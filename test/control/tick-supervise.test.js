// The tick's care of running agents: status nags, pauses that shut agents
// down and kill them, pairs that wait for approval, and the triggered runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';

const turnsEnd = ctx => until(() => [...ctx.agents.values()].every(a => a.result));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const edit = (f, file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const engineFile = f => join(f.dir, 'engines', 'example-development', 'state-engine.json');

test('tick: a Running agent quiet past the engine\'s seconds is asked for a status update, once per silence', async () => {
  const f = controlFixture();
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    const name = record['agent-name'], stamp = record['start-time'].replace(/[-:]/g, '');
    assert.equal(f.inbox(name, stamp).length, 1);
    assert.ok(await turnsEnd(f.ctx));
    process.kill(f.ctx.agents.get(name).agent.pid, 'SIGSTOP');                                  // silent from here on
    f.ctx.agents.get(name).result = null;                                                        // as though still mid-turn
    let clock = Date.parse(record['start-time']);                                                // the silence counts from the record's own time stamp
    f.ctx.now = () => new Date(clock);
    clock += 599_000;
    await tick(f.ctx);
    assert.equal(f.inbox(name, stamp).length, 1);                                               // 600 seconds not yet passed
    clock += 2_000;
    await tick(f.ctx);
    assert.equal(f.inbox(name, stamp).length, 2);
    assert.match(f.inbox(name, stamp)[1], /^\d+ minutes; update:/);                               // the minutes are the agent-cli's, by the real clock
    await tick(f.ctx);
    assert.equal(f.inbox(name, stamp).length, 2);                                               // not asked again for the same silence
    assert.ok(f.lines.some(l => l === `agents ${name} asked for a status update`));
  } finally {
    for (const live of f.ctx.agents.values()) { try { process.kill(-live.agent.pid, 'SIGKILL'); } catch { /* gone */ } }   // a stopped process ignores SIGTERM
  }
});

test('tick: a pause shuts every agent down, kills what is still there after the delay and removes it; its turn ending meanwhile moves nothing; nothing is dispatched while paused', async () => {
  const f = controlFixture();
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    const name = record['agent-name'], stamp = record['start-time'].replace(/[-:]/g, '');
    const pid = f.ctx.agents.get(name).agent.pid;
    assert.ok(await turnsEnd(f.ctx));
    f.ctx.agents.get(name).result = null;                                                        // as though still mid-turn when the pause comes
    await f.agent('assignments:pause', 'all', 'human');
    let clock = Date.now();
    f.ctx.now = () => new Date(clock);
    await tick(f.ctx);
    const [r] = f.assignments().assignments;
    assert.equal(r.status, 'Shutting Down');
    assert.deepEqual(f.inbox(name, stamp).at(-1), 'STOP NOW');
    assert.ok(await turnsEnd(f.ctx));                                                           // it answers the shut-down prompt: a turn ends
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments, []);                                          // ended, no move
    assert.equal(f.variation()['harness-status'].state, 'plan');
    assert.ok(await until(() => !alive(pid)));
    assert.ok(f.lines.some(l => /^finish \S+ ended \(\$1\.0000\)$/.test(l)), f.lines.join('\n'));    // two turns: the dispatch and the shut-down prompt
    assert.ok(!f.lines.some(l => l.startsWith('dispatch ') && f.lines.indexOf(l) > f.lines.findIndex(x => x.includes('asked to shut down'))), 'dispatched while paused');

    // A second agent, once the pause lifts; paused again, it does not answer: killed after the delay.
    await f.agent('assignments:start', 'all', 'human');
    await tick(f.ctx);
    const [second] = f.assignments().assignments;
    const live = f.ctx.agents.get(second['agent-name']);
    assert.ok(await turnsEnd(f.ctx));
    process.kill(live.agent.pid, 'SIGSTOP');                                                     // it will answer nothing more
    live.result = null;                                                                          // as though its turn never ended
    await f.agent('assignments:pause', 'all', 'human');
    await tick(f.ctx);
    const shutting = f.assignments().assignments[0];
    assert.equal(shutting.status, 'Shutting Down');
    clock = Date.parse(shutting['shut-down-requested']) + 500;                                   // the delay counts from the record's own time stamp
    await tick(f.ctx);
    assert.equal(f.assignments().assignments[0].status, 'Shutting Down');                      // 1 second not yet passed
    clock += 600;
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments, []);
    assert.ok(await until(() => !alive(live.agent.pid)));
    assert.ok(f.lines.some(l => /killed after the shut-down delay/.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a paired assignment ends only once the pen-holder\'s turn has ended and the pair has approved; both are removed with their own cost', async () => {
  const f = controlFixture();
  edit(f, engineFile(f), e => { e.steps.find(s => s.id === 'plan').action['agent-count'] = 2; });
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    await tick(f.ctx);
    const [pen, pair] = f.assignments().assignments;
    assert.deepEqual([pen['is-lead'], pair['is-lead'], pen['assignment-id'] === pair['assignment-id']], [true, false, true]);
    assert.equal(f.ctx.agents.size, 2);
    assert.ok(await turnsEnd(f.ctx));                                                           // both answered their dispatch
    await tick(f.ctx);
    assert.equal(f.assignments().assignments.length, 2);                                        // no approval yet: the turn is not complete
    assert.equal(f.variation()['harness-status'].state, 'plan');
    await f.agent('assignments:approve', pair['agent-name']);
    await tick(f.ctx);
    assert.ok(!f.ctx.agents.has(pen['agent-name']) && !f.ctx.agents.has(pair['agent-name']) || f.ctx.agents.size === 1);
    assert.equal(f.variation()['harness-status'].state, 'local-testing');                      // plan → build (the pair's output), build's script, then the test engine, in the same tick
    const log = f.variation()['state-changes'][1]['agent-dispatch-log'];
    assert.deepEqual(log.map(d => [d['dispatched-to'], d['cost-usd']]), [[pen['agent-name'], 0.5], [pair['agent-name'], 0.5]]);
    assert.deepEqual(f.assignments().assignments.map(a => a.state), ['test']);                 // only the test engine's agent remains
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('tick: a ticket whose system status strays from its step\'s pairing gets one gap-resolution run; a done run at a trigger\'s top level is removed', async () => {
  const f = controlFixture();
  // Turns hold until the test lets them end, so the ticks before see the agents still working.
  process.env.FAKE_HOLD = join(f.dir, 'hold');
  writeFileSync(process.env.FAKE_HOLD, '');
  try {
    await tick(f.ctx);
    edit(f, join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0]['ticket-system-status'] = 'Done'; });   // moved by a human in Jira
    await tick(f.ctx);
    assert.equal(f.assignments()['transient-state-engines'].length, 1);                          // the gap-resolution-steps run
    await tick(f.ctx);                                                                           // its step starts the investigate-gap child, which gets its agent
    const runs = f.assignments()['transient-state-engines'];
    assert.equal(runs.length, 2);
    const [gap, child] = runs;
    assert.deepEqual([gap['state-engine'], gap.state, gap.parent], ['example-development/gap-resolution-steps', 'gap-resolution', { trigger: 'gap-resolution', 'work-item': 'ABC-3', variation: 'A' }]);
    assert.deepEqual([child['state-engine'], child.state, child.parent], ['investigate-gap', 'investigate', { 'transient-state-engine': gap.id, 'state-engine': 'example-development/gap-resolution-steps', state: 'gap-resolution' }]);
    const agents = f.assignments().assignments;
    assert.deepEqual(agents.map(a => [a['transient-state-engine'] ?? null, a['work-item'], a.variation, a.state]).toSorted(), [[child.id, 'ABC-3', 'A', 'investigate'], [null, 'ABC-3', 'A', 'plan']].toSorted());
    await tick(f.ctx);
    assert.equal(f.assignments()['transient-state-engines'].length, 2);                         // one gap run per variation
    // The investigator ends its turn: the child is done; the gap run's one exit (is-done, no target) finishes it. The fake
    // investigator fixed nothing, so the gap is seen again and a new run starts in the same tick.
    rmSync(process.env.FAKE_HOLD);
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.ok(f.lines.some(l => l === `steps run investigate-gap ${child.id.slice(0, 8)} ended`), f.lines.join('\n'));
    assert.ok(f.lines.some(l => l === `steps run example-development/gap-resolution-steps ${gap.id.slice(0, 8)} ended (finished)`), f.lines.join('\n'));
    const after = f.assignments()['transient-state-engines'];
    assert.deepEqual(after.map(r => [r['state-engine'], r.id === gap.id]), [['example-development/gap-resolution-steps', false]]);
  } finally {
    delete process.env.FAKE_HOLD;
    f.ctx.stopAgents();
  }
});

test('tick: only the harness project\'s engine checks health — every project\'s state changes sampled into harness runs, naming the ticket\'s project', async () => {
  const f = controlFixture();
  // h, the harness project, runs its own copy of the engine, the only one with the health checks.
  const engine = JSON.parse(readFileSync(engineFile(f), 'utf8'));
  const health = { 'check-health-interval-seconds': 300, 'check-ticket-health-sample-every': 2, 'check-health-steps': engine['check-health-steps'],
    'check-ticket-health-steps': [{ id: 'check-ticket-health', sequence: 1, action: { type: 'state-engine', engine: 'investigate-gap' }, 'exit-events': [{ condition: { 'is-done': true } }] }] };
  for (const key of Object.keys(health)) delete engine[key];
  writeFileSync(engineFile(f), JSON.stringify(engine));
  mkdirSync(join(f.dir, 'engines', 'harness-e'));
  writeFileSync(join(f.dir, 'engines', 'harness-e', 'state-engine.json'), JSON.stringify({ ...engine, ...health }));
  mkdirSync(join(f.dir, 'projects', 'h', 'sprints', 'sprint-1'), { recursive: true });
  writeFileSync(join(f.dir, 'projects', 'h', 'project.json'), JSON.stringify({ name: 'H', 'execution-state-engine': 'harness-e', 'work-sources': [], 'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: join(f.dir, 'workspace'), 'active-branch': null }] }));
  writeFileSync(join(f.dir, 'projects', 'h', 'sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': true }] }));
  writeFileSync(join(f.dir, 'projects', 'h', 'sprints', 'sprint-1', 'sprint.json'), JSON.stringify({ number: 1, features: [], bugs: [], spikes: [] }));
  edit(f, join(f.dir, 'harness.json'), h => { h['harness-project'] = 'h'; });
  const runs = () => f.assignments()['transient-state-engines'].map(r => [r.project, r['state-engine'], r.parent.trigger ?? null, r.parent['ticket-project'] ?? null]);
  let clock = f.ctx.started.getTime();
  f.ctx.now = () => new Date(clock);
  process.env.FAKE_HOLD = join(f.dir, 'hold');
  writeFileSync(process.env.FAKE_HOLD, '');
  try {
    await tick(f.ctx);                                                                           // p's ABC-3 moves twice: sampled into an h run
    assert.deepEqual(runs(), [['h', 'harness-e/check-ticket-health-steps', 'check-ticket-health', 'p']]);
    await tick(f.ctx);                                                                           // its investigate run gets an agent, told the ticket's project
    const told = f.lines.find(l => l.startsWith('cli agent.sh agent:dispatch ') && l.includes('ticket-project=p'));
    assert.ok(told?.includes(`ticket-project-folder=${join(f.dir, 'projects', 'p')}`), f.lines.join('\n'));
    assert.match(told, /seats=.*in-planning.{0,3}:\[.{0,2}ABC-3 A/, 'ASS-240 AC1: the ticket project\'s limits and seat holders (plan.js seatsOf)');
    clock += 300_000;
    await tick(f.ctx);                                                                           // h's check-health fires; p has none
    assert.deepEqual(runs().filter(r => r[2] === 'check-health'), [['h', 'harness-e/check-health-steps', 'check-health', null]]);
  } finally {
    delete process.env.FAKE_HOLD;
    f.ctx.stopAgents();
  }
});

test('tick: timers start check-health and check-variation-appeal runs at their intervals, state changes are sampled for check-ticket-health, and no turn fires self-healing', async () => {
  const f = controlFixture();
  edit(f, engineFile(f), e => {
    Object.assign(e, { 'check-health-interval-seconds': 300, 'check-variation-appeal-interval-seconds': 600, 'check-ticket-health-sample-every': 2 });
    e['check-ticket-health-steps'] = [{ id: 'check-ticket-health', sequence: 1, action: { type: 'state-engine', engine: 'investigate-gap' }, 'exit-events': [{ condition: { 'is-done': true } }] }];
    e['check-variation-appeal-steps'] = [{ id: 'check-variation-appeal', sequence: 1, action: { type: 'state-engine', engine: 'investigate-gap' }, 'exit-events': [{ condition: { 'is-done': true } }] }];
  });
  // A stale self-healing-trigger left in harness.json fires nothing: self-healing starts only from check-health's assess step.
  edit(f, join(f.dir, 'harness.json'), h => { h['self-healing-trigger'] = [{ id: 'heal', action: { type: 'state-engine', engine: 'self-healing' }, 'execution-turns-interval': 2 }]; h['max-tickets-in-planning'] = 2; h['harness-project'] = 'p'; });
  edit(f, join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations.push({ name: 'B', 'harness-status': { state: 'plan', 'state-engine': 'example-development' }, 'state-changes': [{ 'from-state': 'committed', 'to-state': 'plan', 'agent-dispatch-log': [] }] }); });
  const runs = () => f.assignments()['transient-state-engines'].map(r => [r['state-engine'], r.parent.trigger ?? null, r.parent['work-item'] ?? null, r.parent.variation ?? null]);
  let clock = f.ctx.started.getTime();
  f.ctx.now = () => new Date(clock);
  try {
    await tick(f.ctx);                                                                           // A: backlog → committed → plan is 2 changes: sampled
    assert.deepEqual(runs(), [['example-development/check-ticket-health-steps', 'check-ticket-health', 'ABC-3', 'A']]);
    assert.equal(f.assignments()['transient-state-engines'][0].parent['ticket-project'], 'p');
    clock += 300_000;
    await tick(f.ctx);
    assert.deepEqual(runs().slice(1), [['investigate-gap', null, null, null], ['example-development/check-health-steps', 'check-health', null, null]]);
    clock += 300_000;
    await tick(f.ctx);                                                                           // check-health again? no: one at a time. Appeal: the ticket has two variations
    assert.deepEqual(runs().filter(r => r[1] === 'check-health').length, 1);
    assert.deepEqual(runs().filter(r => r[1] === 'check-variation-appeal'), [['example-development/check-variation-appeal-steps', 'check-variation-appeal', 'ABC-3', null]]);
    // Turns ending start no self-healing run.
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.ok(!f.lines.some(l => /started self-healing/.test(l)), f.lines.join('\n'));
    assert.ok(!runs().some(r => r[1] === 'self-healing'), JSON.stringify(runs()));
  } finally {
    f.ctx.stopAgents();
  }
});

// ASS-181 AC5, ASS-182: a VM agent's shut-down prompt names the VM's ticket folder and agent.sh, as its dispatch did — by its step's run-location, not by whether its variation has a VM.
test('ASS-181 AC5, ASS-182: a paused agent on a run-location: vm step is sent agent:shut-down with ticket-folder=/mnt/ticket and agent-sh=agent.sh; one on a host step, with its name alone, though its variation has a VM', async () => {
  const { superviseAgents } = await import('../../src/control/supervise.js');
  const record = (name, variation, state) => ({ 'agent-name': name, project: 'p', 'work-item': 'T-1', variation, 'state-engine': 'e', state, status: 'Running', 'start-time': '2026-10-27T00:00:00Z' });
  const ticket = { key: 'T-1', variations: [{ name: 'A', vm: { name: 'p-t-1-a' } }, { name: 'B' }] };
  const engines = { e: { steps: [{ id: 'build', 'run-location': 'vm', action: { type: 'prompt' } }, { id: 'groom', action: { type: 'prompt' } }] } };
  const state = { pauses: { all: { human: true } }, harness: {}, engines, transient: [], projects: [{ id: 'p', tickets: [ticket] }], assignments: [record('Hulk', 'A', 'build'), record('Loki', 'A', 'groom'), record('Thor', 'B', 'groom')] };
  const calls = [];
  const ctx = { now: () => new Date('2026-10-27T01:00:00Z'), cli: async argv => { calls.push(argv); }, log: () => {}, attempt: async (_phase, _what, run) => run(), agents: new Map() };
  await superviseAgents(ctx, state);
  assert.deepEqual(calls, [['agent:shut-down', 'Hulk', 'ticket-folder=/mnt/ticket', 'agent-sh=agent.sh'], ['agent:shut-down', 'Loki'], ['agent:shut-down', 'Thor']]);
});
