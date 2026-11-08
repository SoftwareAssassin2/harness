// ASS-83: a fast-tracked ticket (fast-track: true, raised by the health
// check) ranks above everything and pre-empts: for each one waiting for a
// seat — a ticket slot (ASS-126) it needs and none is free — control pauses
// exactly one running ticket holding a seat of that kind, the lowest-ranked
// first, marked as its pause (ticket:set-preempted), and resumes it once the
// fast-tracked ticket no longer holds or wants that seat. Each pre-emption,
// resumption and fast-track join is logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { runSteps } from '../../src/control/steps.js';
import { fastTrack } from '../../src/control/fast-track.js';
import { dispatch } from '../../src/control/dispatch.js';
import { superviseAgents } from '../../src/control/supervise.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const ok = to => [{ condition: { 'exit-code': 0 }, 'move-to-state': to }];
const planning = { 'is-planning-stage': true };

// As tick-slots.test.js's: committed → setup (a script) → plan (a prompt) →
// approve (a script) → build (a script) → review (a prompt) → done; setup to
// approve in planning, build on in progress; prepare, a planning group (the
// test engine) whose run, done, moves on to build.
const steps = [
  { id: 'blocked', sequence: 0, 'is-blocked-state': true, action: { type: 'human' } },
  { id: 'backlog', sequence: 1, ...planning, action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'committed' }] },
  { id: 'committed', sequence: 2, ...planning, action: { type: 'none' }, 'exit-events': [{ condition: { 'agent-needs-work': true }, 'move-to-state': 'setup' }] },
  { id: 'setup', sequence: 3, ...planning, action: { type: 'script', command: 'true' }, 'exit-events': ok('plan') },
  { id: 'plan', sequence: 4, ...planning, action: { type: 'prompt', prompt: 'review-plan' } },
  { id: 'approve', sequence: 5, ...planning, action: { type: 'script', command: 'true' }, 'exit-events': ok('build') },
  { id: 'prepare', sequence: 6, ...planning, action: { type: 'state-engine', engine: 'test' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'build' }] },
  { id: 'build', sequence: 7, action: { type: 'script', command: 'true' }, 'exit-events': ok('review') },
  { id: 'review', sequence: 8, action: { type: 'prompt', prompt: 'test' } },
  { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } },
];

// The control fixture on that engine with harness.json's `limits` and the
// sprint `tickets`: [key, state, manual-priority, fast-tracked?] each.
// cycle() is a tick's two phases this is about, in tick order: fast-track,
// then steps. state(key), paused(key) (is-paused and paused-for-fast-track)
// read the sprint; logged(re) the log lines matching.
function sprint(tickets, limits) {
  const f = controlFixture();
  const sprintFile = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps = steps; });
  edit(join(f.dir, 'harness.json'), h => Object.assign(h, { 'max-tickets-in-progress': null, 'max-tickets-in-planning': null }, limits));
  edit(sprintFile, s => {
    s.features = tickets.map(([key, state, rank, fast]) => ({ key, 'manual-priority': rank, ...(fast ? { 'fast-track': true } : {}), variations: [{ name: 'A', 'harness-status': hs(state), 'state-changes': [] }] }));
  });
  const v = key => f.sprint().features.find(t => t.key === key).variations[0];
  return {
    ...f,
    edit: change => edit(sprintFile, change),
    state: key => v(key)['harness-status'].state,
    paused: key => [v(key)['is-paused'] ?? false, v(key)['paused-for-fast-track'] ?? null],
    logged: re => f.lines.filter(l => re.test(l)),
    cycle: async () => { await fastTrack(f.ctx, f.ctx.load()); await runSteps(f.ctx, f.ctx.load()); },
  };
}

test('ASS-83 AC3: a fast-tracked ticket with a seat free takes it; nothing is paused', async () => {
  const f = sprint([['T-1', 'plan', 1], ['F-1', 'committed', null, true]], { 'max-tickets-in-planning': 2 });
  await f.cycle();
  await f.cycle();
  assert.equal(f.state('F-1'), 'plan');
  assert.deepEqual(f.paused('T-1'), [false, null]);
  assert.deepEqual(f.logged(/paused/), []);
});

test('ASS-83 AC3, AC4: one fast-tracked ticket waiting for a planning seat pauses exactly the lowest-ranked ticket in planning, logged; it takes the seat, and the paused one resumes once it is done', async () => {
  const f = sprint([['T-1', 'plan', 1], ['T-2', 'plan', 2], ['F-1', 'committed', null, true]], { 'max-tickets-in-planning': 2 });
  await f.cycle();                                                      // F-1 waits: no planning seat
  assert.equal(f.state('F-1'), 'committed');
  await f.cycle();                                                      // T-2 paused for it; F-1 moves in
  assert.deepEqual([f.paused('T-1'), f.paused('T-2')], [[false, null], [true, 'F-1']]);
  assert.equal(f.state('F-1'), 'plan');
  assert.deepEqual(f.logged(/^fast-track /), ['fast-track paused T-2 to free a seat for fast-tracked F-1 (T-2 A held a planning seat)']);
  await f.cycle();
  await f.cycle();
  assert.deepEqual(f.paused('T-1'), [false, null]);                     // exactly one seat freed: no more paused
  assert.deepEqual(f.paused('T-2'), [true, 'F-1']);                     // F-1 holds the seat: T-2 stays paused
  f.edit(s => { s.features.find(t => t.key === 'F-1').variations[0]['harness-status'] = hs('done'); });
  await f.cycle();
  assert.deepEqual(f.paused('T-2'), [false, null]);
  assert.deepEqual(f.logged(/resumed/), ['fast-track resumed T-2 A: fast-tracked F-1 no longer needs its planning seat']);
});

test('ASS-83 AC3: two fast-tracked tickets waiting pause exactly two, the lowest-ranked first, and both take the seats', async () => {
  const f = sprint([['T-1', 'plan', 1], ['T-2', 'plan', 2], ['T-3', 'plan', 3], ['F-1', 'committed', null, true], ['F-2', 'committed', null, true]], { 'max-tickets-in-planning': 3 });
  for (let i = 0; i < 4; i++) await f.cycle();
  assert.deepEqual(['T-1', 'T-2', 'T-3'].map(f.paused), [[false, null], [true, 'F-2'], [true, 'F-1']]);
  assert.deepEqual([f.state('F-1'), f.state('F-2')], ['plan', 'plan']);
  assert.equal(f.logged(/^fast-track paused/).length, 2);
});

test('ASS-83 AC3: a fast-tracked ticket waiting for an in-progress seat pauses the lowest-ranked ticket in progress, not one in planning; it resumes once the fast-tracked one is done', async () => {
  const f = sprint([['T-1', 'review', 1], ['T-2', 'plan', 2], ['F-1', 'prepare', null, true]], { 'max-tickets-in-progress': 1, 'max-tickets-in-planning': 2 });
  // F-1's planning group is done: it waits for an in-progress seat to move on to build (ASS-126).
  edit(join(f.dir, 'assignments.json'), a => {
    a['transient-state-engines'] = [{ id: 'run-1', project: 'p', 'state-engine': 'test', state: 'done', 'is-done': true, 'structured-output': null, parent: { 'work-item': 'F-1', variation: 'A', 'state-engine': 'example-development', state: 'prepare' } }];
  });
  f.edit(s => { s.features.find(t => t.key === 'F-1').variations[0]['harness-status']['sub-status'] = { state: 'done', 'state-engine': 'test' }; });
  await f.cycle();
  assert.equal(f.state('F-1'), 'prepare');
  await f.cycle();
  assert.deepEqual([f.paused('T-1'), f.paused('T-2')], [[true, 'F-1'], [false, null]]);
  assert.equal(f.state('F-1'), 'review');
  assert.deepEqual(f.logged(/^fast-track paused/), ['fast-track paused T-1 to free a seat for fast-tracked F-1 (T-1 A held an in-progress seat)']);
  f.edit(s => { s.features.find(t => t.key === 'F-1').variations[0]['harness-status'] = hs('done'); });
  await f.cycle();
  assert.deepEqual(f.paused('T-1'), [false, null]);
});

test('ASS-83 AC3: control never pre-empts a fast-tracked ticket, and never resumes a ticket the operator paused', async () => {
  const f = sprint([['F-1', 'plan', null, true], ['F-2', 'committed', null, true], ['T-1', 'plan', 1]], { 'max-tickets-in-planning': 1 });
  f.edit(s => { s.features.find(t => t.key === 'T-1').variations[0]['is-paused'] = true; });   // the operator's
  for (let i = 0; i < 3; i++) await f.cycle();
  assert.deepEqual([f.paused('F-1'), f.paused('T-1')], [[false, null], [true, null]]);
  assert.equal(f.state('F-2'), 'committed');                          // no seat to take: it waits
  assert.deepEqual(f.logged(/paused|resumed/), []);
});

test('ASS-83 AC4: control logs a fast-tracked ticket joining the sprint while it runs, once, and one left in the backlog by a failed join, once while it stays there', async () => {
  const f = sprint([['T-1', 'plan', 1]], {});
  writeFileSync(join(f.dir, 'projects', 'p', 'backlog.json'), JSON.stringify({ tickets: [{ key: 'F-9', 'fast-track': true, variations: [] }, { key: 'B-1', variations: [] }] }));
  await f.cycle();
  await f.cycle();
  assert.deepEqual(f.logged(/^fast-track /), ['fast-track fast-tracked F-9 is in the backlog, not the sprint: its join failed; join it by hand, or its source tries again on its next run']);
  f.edit(s => { s.features.push({ key: 'F-9', 'fast-track': true, variations: [{ name: 'A', 'harness-status': hs('committed'), 'state-changes': [] }] }); });   // joined; its backlog entry stays (ASS-84)
  await f.cycle();
  await f.cycle();
  assert.deepEqual(f.logged(/^fast-track /).slice(1), ['fast-track fast-tracked F-9 joined the sprint']);
});

// The agent pool (harness.json's max-agents, a project's own): the sprint's
// agents held at work (FAKE_HOLD) while fn runs; turn() is a whole tick's
// phases this is about — fast-track, steps, supervise, dispatch.
async function agentsHeld(f, fn) {
  process.env.FAKE_HOLD = join(f.dir, 'hold');
  writeFileSync(process.env.FAKE_HOLD, '');
  try { return await fn(); } finally { delete process.env.FAKE_HOLD; f.ctx.stopAgents(); }
}
const turn = async f => { for (const phase of [fastTrack, runSteps, superviseAgents, dispatch]) await phase(f.ctx, f.ctx.load()); };
const working = f => f.assignments().assignments.map(a => a['work-item']).toSorted();

for (const [cap, limits] of [['harness.json\'s', { 'max-agents': 2 }], ['the project\'s own', {}]]) {
  test(`ASS-83 AC3: a fast-tracked ticket waiting for an agent seat (${cap} max-agents full) pauses exactly the lowest-ranked ticket with an agent, which is shut down; the fast-tracked one gets the agent; the paused one resumes once it is done`, async () => {
    const f = sprint([['T-1', 'plan', 1], ['T-2', 'plan', 2]], { 'max-tickets-in-planning': 5, 'agent-graceful-shut-down-delay-in-seconds': 0, ...limits });
    if (!limits['max-agents']) edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['max-agents'] = 2; });
    await agentsHeld(f, async () => {
      await turn(f);
      assert.deepEqual(working(f), ['T-1', 'T-2']);
      f.edit(s => { s.features.push({ key: 'F-1', 'fast-track': true, variations: [{ name: 'A', 'harness-status': hs('plan'), 'state-changes': [] }] }); });
      await turn(f);                                                     // F-1 waits: no agent seat
      assert.deepEqual(working(f), ['T-1', 'T-2']);
      for (let i = 0; i < 4; i++) await turn(f);
      assert.deepEqual([f.paused('T-1'), f.paused('T-2')], [[false, null], [true, 'F-1']]);
      assert.deepEqual(working(f), ['F-1', 'T-1']);
      assert.deepEqual(f.logged(/^fast-track paused/), ['fast-track paused T-2 to free a seat for fast-tracked F-1 (T-2 A held an agent seat)']);
      // F-1 done, its agent gone: T-2 resumes. (Its agent still there, it does not.)
      f.edit(s => { s.features.find(t => t.key === 'F-1').variations[0]['harness-status'] = hs('done'); });
      await fastTrack(f.ctx, f.ctx.load());
      assert.deepEqual(f.paused('T-2'), [true, 'F-1']);
      const live = f.assignments().assignments.find(a => a['work-item'] === 'F-1')['agent-name'];
      f.ctx.agents.get(live).agent.stop();
      f.ctx.agents.delete(live);
      edit(join(f.dir, 'assignments.json'), a => { a.assignments = a.assignments.filter(r => r['work-item'] !== 'F-1'); });
      await turn(f);
      assert.deepEqual(f.paused('T-2'), [false, null]);
      assert.deepEqual(f.logged(/resumed/), ['fast-track resumed T-2 A: fast-tracked F-1 no longer needs its agent seat']);
    });
  });
}

test('ASS-83 AC3: a fast-tracked ticket whose sub-engine run waits for an agent seat (the v2 engines\' shape) pre-empts the same way; its run gets the agent', async () => {
  const f = sprint([['T-1', 'plan', 1], ['T-2', 'plan', 2]], { 'max-tickets-in-planning': 5, 'max-agents': 2, 'agent-graceful-shut-down-delay-in-seconds': 0 });
  await agentsHeld(f, async () => {
    await turn(f);
    f.edit(s => { s.features.push({ key: 'F-1', 'fast-track': true, variations: [{ name: 'A', 'harness-status': { ...hs('prepare'), 'sub-status': { state: 'test', 'state-engine': 'test' } }, 'state-changes': [] }] }); });
    edit(join(f.dir, 'assignments.json'), a => {
      a['transient-state-engines'] = [{ id: 'run-1', project: 'p', 'state-engine': 'test', state: 'test', 'is-done': false, 'structured-output': null, parent: { 'work-item': 'F-1', variation: 'A', 'state-engine': 'example-development', state: 'prepare' } }];
    });
    for (let i = 0; i < 5; i++) await turn(f);
    assert.deepEqual([f.paused('T-1'), f.paused('T-2')], [[false, null], [true, 'F-1']]);
    assert.ok(f.assignments().assignments.some(a => a['transient-state-engine'] === 'run-1'), 'its run has the agent');
    assert.equal(f.logged(/^fast-track paused/).length, 1);
  });
});

test('ASS-83 AC3: a project\'s own planning cap, full below harness.json\'s, is pre-empted the same way', async () => {
  const f = sprint([['T-1', 'plan', 1], ['T-2', 'plan', 2], ['F-1', 'committed', null, true]], { 'max-tickets-in-planning': 9 });
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['max-tickets-in-planning'] = 2; });
  await f.cycle();
  await f.cycle();
  assert.deepEqual([f.paused('T-1'), f.paused('T-2'), f.state('F-1')], [[false, null], [true, 'F-1'], 'plan']);
});

// ASS-151: a human step's fast-tracked exit — the v2 Review group's Human
// Review and Payment Gate, inside its run; or a step at the top level —
// passes a fast-tracked ticket with no human, the move logged and recorded
// with cause "fast-track"; any other ticket waits there for a human.
const sign = to => [{ condition: { 'human-review': 'Approved' }, 'move-to-state': to }, { condition: { 'fast-tracked': true }, 'move-to-state': to }];
function humanSteps(fast) {
  const f = sprint([['T-1', 'prepare', 1, fast], ['T-2', 'sign-off', 2, fast]], { 'max-tickets-in-progress': 5, 'max-tickets-in-planning': 5 });
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps.push({ id: 'sign-off', sequence: 10, action: { type: 'human' }, 'exit-events': sign('done') }); });
  mkdirSync(join(f.dir, 'engines', 'gate'));
  writeFileSync(join(f.dir, 'engines', 'gate', 'state-engine.json'), JSON.stringify({ steps: [
    { id: 'human-review', sequence: 1, action: { type: 'human' }, 'exit-events': sign('done') },
    { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
  ] }));
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps.find(s => s.id === 'prepare').action.engine = 'gate'; });
  f.edit(s => { s.features[0].variations[0]['harness-status']['sub-status'] = { state: 'human-review', 'state-engine': 'gate' }; });
  edit(join(f.dir, 'assignments.json'), a => {
    a['transient-state-engines'] = [{ id: 'run-1', project: 'p', 'state-engine': 'gate', state: 'human-review', 'is-done': false, 'structured-output': null, parent: { 'work-item': 'T-1', variation: 'A', 'state-engine': 'example-development', state: 'prepare' } }];
  });
  return f;
}

test('ASS-151 AC1: a fast-tracked ticket at a human step leaves it by the step\'s approving exit with no human — inside a run and at the top level — logged, and recorded in its history with cause fast-track', async () => {
  const f = humanSteps(true);
  await runSteps(f.ctx, f.ctx.load());
  const v = key => f.sprint().features.find(t => t.key === key).variations[0];
  assert.equal(f.assignments()['transient-state-engines'][0]?.state ?? 'done', 'done');
  assert.equal(f.state('T-2'), 'done');
  const moved = v('T-1')['state-changes'].find(c => c['sub-state-change']?.['to-state'] === 'done');
  assert.deepEqual([moved?.['sub-state-change']['from-state'], moved?.cause], ['human-review', 'fast-track']);
  assert.equal(v('T-2')['state-changes'].at(-1).cause, 'fast-track');
  assert.deepEqual(f.logged(/passed by itself/), [
    'steps T-2 A sign-off: fast-tracked, passed by itself — no human asked (→ done)',
    'steps T-1 A gate/human-review: fast-tracked, passed by itself — no human asked (→ done)',
  ]);
});

test('ASS-151 AC1: a ticket not fast-tracked waits at the human step for a human, inside a run and at the top level; nothing is logged as passed', async () => {
  const f = humanSteps(false);
  await runSteps(f.ctx, f.ctx.load());
  await runSteps(f.ctx, f.ctx.load());
  assert.equal(f.assignments()['transient-state-engines'][0].state, 'human-review');
  assert.equal(f.state('T-2'), 'sign-off');
  assert.deepEqual(f.logged(/passed by itself/), []);
});
