// ASS-522: a variation whose Blocked run has finished moves back to the step
// it returns to in the same tick, seat or not, and waits for its seat there:
// nothing runs at the step (no script, no sub-engine run, no agent) until it
// is seated, then it carries on as any waiting variation does. Driven tick by
// tick on the control fixture and a fake agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { tick } from '../../src/control/tick.js';
import { planFor } from '../../src/control/plan.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const STATUS = { blocked: 'Blocked', plan: 'In Progress', build: 'In Progress', 'local-testing': 'In Progress', done: 'Done' };
const was = (from, to) => ({ 'state-engine': 'example-development', 'from-state': from, 'to-state': to, timestamp: '2026-11-20T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': true });
// A sprint ticket, its one variation at `state` with `changes` (state-changes).
const at = (key, state, changes = []) => ({ key, title: key, 'ticket-system-status': STATUS[state], priority: Number(key.split('-')[1]), dependencies: [], variations: [{ name: 'A', 'harness-status': hs(state), 'state-changes': changes }] });
// Blocked's run for `key`, finished: its one-step engine at done.
const doneRun = (key, id = `run-${key}`) => ({ id, project: 'p', 'state-engine': 'unblock', state: 'done', 'is-done': true, 'structured-output': null, parent: { 'work-item': key, variation: 'A', 'state-engine': 'example-development', state: 'blocked' } });

// The control fixture with: Blocked a state-engine step on a one-step engine
// (unblock: done at once), its is-done exit following the return-to step (as
// grouped-blocked's does); a sprint of ABC-1 A at blocked, come from `from`,
// its Blocked run done; `holders` (default ABC-2 at build, holding the one
// in-progress seat) after it; and harness.json's `limits`; `seats` on the Mac (ASS-528; the fixture's one by default).
function blockedReturn({ from = 'build', holders = [at('ABC-2', 'build')], limits = {}, seats } = {}) {
  const f = controlFixture();
  const engine = join(f.dir, 'engines', 'example-development', 'workflow.yaml');
  edit(engine, e => Object.assign(e.steps.find(s => s.id === 'blocked'), {
    action: { type: 'state-engine', engine: 'unblock' },
    'follow-return-to-state': true, 'exit-events': [{ condition: { 'is-done': true }, 'follow-return-to-state': true }],
  }));
  // ASS-527: a seat only at a step that uses its machine — build made an in-machine script (machine-steps.js), its run
  // stood in for here: logged as the fixture's real script is, exit 0.
  edit(engine, e => { e.steps.find(s => s.id === 'build').action.command = './agent.sh ci-checks:verify {project} {ticket} {variation}'; });
  const real = f.ctx.script;
  f.ctx.script = async (argv, vm, env) => {
    if (argv[1] !== 'ci-checks:verify') return real(argv, vm, env);
    f.ctx.log('script', argv.join(' '));
    return { exitCode: 0, stdout: '' };
  };
  mkdirSync(join(f.dir, 'engines', 'unblock'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'unblock', 'workflow.yaml'), JSON.stringify({ steps: [{ id: 'done', sequence: 1, 'is-done': true, action: { type: 'none' } }] }));
  edit(join(f.dir, 'harness.json'), h => Object.assign(h, limits));
  if (seats != null) f.seats(seats);
  const sprintFile = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const into = from === 'plan' ? [was('committed', 'plan')] : from === 'build' ? [was('plan', 'build')] : [was('plan', 'build'), was('build', 'local-testing')];
  edit(sprintFile, s => { s.features = [at('ABC-1', 'blocked', [...into, was(from, 'blocked')]), ...holders]; });
  writeFileSync(join(f.dir, 'projects', 'p', 'backlog.json'), JSON.stringify({ tickets: [] }));
  edit(join(f.dir, 'assignments.json'), a => { a['transient-state-engines'] = [doneRun('ABC-1')]; });
  const inSprint = key => f.sprint().features.find(t => t.key === key);
  return {
    ...f,
    editSprint: change => edit(sprintFile, change),
    inSprint,
    stateOf: key => inSprint(key).variations[0]['harness-status'].state,
    calls: pattern => f.lines.filter(l => pattern.test(l)),
    plan: () => { const state = f.ctx.load(); const plan = planFor(state, state.projects[0]); return { reserved: plan.reserved.map(r => r.key), waiting: plan.waiting.map(r => r.key) }; },
    ticks: async (n = 1) => { for (let i = 0; i < n; i++) await tick(f.ctx); },
  };
}

const script = (f, key) => f.calls(new RegExp(`^script \\./agent\\.sh ci-checks:verify p ${key} A$`));
const runsOf = (f, key) => f.assignments()['transient-state-engines'].filter(r => r.parent?.['work-item'] === key);
const agentsOn = (f, key) => f.assignments().assignments.filter(a => a['work-item'] === key);
const moved = (f, key, to) => f.inSprint(key).variations[0]['state-changes'].find(c => c['from-state'] === 'blocked' && c['to-state'] === to && !c['sub-state-change']);
const freeSeat = f => f.editSprint(s => { const t = s.features.find(x => x.key === 'ABC-2'); t['ticket-system-status'] = 'Done'; t.variations[0]['harness-status'] = hs('done'); });

test('ASS-522 T1: Blocked run done, build target, no in-progress seat — at build the same tick, paired status set, waiting, no script, no "waits for" line; seat freed → its script runs', async () => {
  const f = blockedReturn();
  await f.ticks();
  const log = f.lines.join('\n');
  assert.equal(f.stateOf('ABC-1'), 'build', log);                                         // AC1
  assert.equal(f.inSprint('ABC-1')['ticket-system-status'], 'In Progress', log);           // build's paired status
  assert.ok(moved(f, 'ABC-1', 'build'), log);
  assert.equal(runsOf(f, 'ABC-1').filter(r => r['state-engine'] === 'unblock').length, 0, log);   // Blocked's run ended
  assert.deepEqual(f.plan().waiting, ['ABC-1'], log);                                      // AC2
  assert.ok(!f.plan().reserved.includes('ABC-1'), log);
  assert.equal(script(f, 'ABC-1').length, 0, log);
  assert.equal(agentsOn(f, 'ABC-1').length, 0, log);
  assert.equal(f.calls(/ABC-1 A .*waits for an in-progress slot to move to/).length, 0, log);   // AC4
  freeSeat(f);
  await f.ticks();
  assert.deepEqual(f.plan().reserved, ['ABC-1'], f.lines.join('\n'));                      // AC2 / AC3: seated, carries on
  assert.equal(script(f, 'ABC-1').length, 1, f.lines.join('\n'));
});

test('ASS-522 T1: two Blocked runs done for build, one seat freed — the higher-ranked takes it, the other stays waiting, its script not run', async () => {
  const f = blockedReturn({ holders: [at('ABC-2', 'build'), at('ABC-3', 'blocked', [was('plan', 'build'), was('build', 'blocked')])] });
  edit(join(f.dir, 'assignments.json'), a => { a['transient-state-engines'].push(doneRun('ABC-3')); });
  await f.ticks();
  const log = f.lines.join('\n');
  assert.equal(f.stateOf('ABC-1'), 'build', log);
  assert.equal(f.stateOf('ABC-3'), 'build', log);
  const queue = f.plan().waiting;
  assert.deepEqual(queue.toSorted(), ['ABC-1', 'ABC-3'], log);
  assert.equal(script(f, 'ABC-1').length + script(f, 'ABC-3').length, 0, log);
  freeSeat(f);
  await f.ticks();
  const after = f.lines.join('\n');
  assert.deepEqual(f.plan().reserved, [queue[0]], after);
  assert.deepEqual(f.plan().waiting, [queue[1]], after);
  assert.equal(script(f, queue[0]).length, 1, after);
  assert.equal(script(f, queue[1]).length, 0, after);
});

test('ASS-522 T2: Blocked run done, local-testing target, seats full — at local-testing, waiting, no sub-engine run or sub-state; seat freed → its run is made', async () => {
  const f = blockedReturn({ from: 'local-testing' });
  await f.ticks();
  const log = f.lines.join('\n');
  assert.equal(f.stateOf('ABC-1'), 'local-testing', log);                                  // AC1
  assert.equal(f.inSprint('ABC-1')['ticket-system-status'], 'In Progress', log);
  assert.deepEqual(f.plan().waiting, ['ABC-1'], log);                                      // AC2
  assert.equal(runsOf(f, 'ABC-1').length, 0, log);
  assert.equal(f.inSprint('ABC-1').variations[0]['harness-status']['sub-status'] ?? null, null, log);
  assert.equal(agentsOn(f, 'ABC-1').length, 0, log);
  assert.equal(f.calls(/ABC-1 A .*waits for an in-progress slot to move to/).length, 0, log);   // AC4
  freeSeat(f);
  await f.ticks();
  const after = f.lines.join('\n');
  assert.deepEqual(f.plan().reserved, ['ABC-1'], after);                                   // AC3
  assert.equal(runsOf(f, 'ABC-1').filter(r => r['state-engine'] === 'test').length, 1, after);
});

test('ASS-522 T3: Blocked run done with a free seat — moves to build and its script runs as today', async () => {
  const f = blockedReturn({ holders: [] });
  await f.ticks(2);
  const log = f.lines.join('\n');
  assert.notEqual(f.stateOf('ABC-1'), 'blocked', log);
  assert.ok(moved(f, 'ABC-1', 'build'), log);
  assert.equal(script(f, 'ABC-1').length, 1, log);
  assert.equal(f.calls(/waits for an in-progress slot/).length, 0, log);
});

test('ASS-522 T4: Blocked run done, plan target with no seat (ASS-528: none on the Mac) — at plan the same tick, waiting, no agent, no "waits for a planning slot" line', async () => {
  const f = blockedReturn({ from: 'plan', holders: [], seats: 0 });
  try {
    await f.ticks();
    const log = f.lines.join('\n');
    assert.equal(f.stateOf('ABC-1'), 'plan', log);                                         // AC1
    assert.equal(f.inSprint('ABC-1')['ticket-system-status'], 'In Progress', log);
    assert.ok(moved(f, 'ABC-1', 'plan'), log);
    assert.deepEqual(f.plan().waiting, ['ABC-1'], log);                                    // AC2
    assert.equal(agentsOn(f, 'ABC-1').length, 0, log);
    assert.equal(f.calls(/waits for a planning slot to move to plan/).length, 0, log);     // AC4
  } finally { f.ctx.stopAgents(); }
});
