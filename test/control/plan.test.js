// Planning dispatches: the seats (ASS-126: tickets in motion; ASS-528: one pool, its seats the seat budget's and the
// remote machines'), max-agents, trigger caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDispatch, slotKind, poolOf, triggerAllowed, seatsOf } from '../../src/control/plan.js';

const engine = {
  steps: [
    { id: 'blocked-for-human', sequence: 0, 'is-blocked-state': true, action: { type: 'human' } },
    { id: 'blocked', sequence: 0, action: { type: 'state-engine', engine: 'blocked' } },
    { id: 'committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } },
    { id: 'plan', sequence: 2, 'is-planning-stage': true, action: { type: 'prompt', prompt: 'plan' } },
    { id: 'build', sequence: 3, action: { type: 'prompt', prompt: 'build', 'agent-count': 2 } },
    { id: 'review', sequence: 4, action: { type: 'prompt', prompt: 'review', 'agent-count': 1 } },
    { id: 'test', sequence: 5, action: { type: 'state-engine', engine: 'test' } },
    { id: 'gate', sequence: 6, action: { type: 'human' } },
    { id: 'qa', sequence: 7, action: { type: 'none' }, 'exit-events': [{ condition: { 'ticket-system-status': 'Done' }, 'move-to-state': 'done' }] },
    { id: 'done', sequence: 8, 'is-done': true, action: { type: 'none' } },
  ],
};
const at = (state, extra = {}) => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, ...extra });
const ticket = (key, ...variations) => ({ key, variations });
const assignment = (workItem, variation, state) => ({ 'work-item': workItem, variation, state });
const unlimited = { 'max-agents': null };
// seats(mac, remote) — ASS-528: the project's one pool, its Mac seats and its remote machines' (planDispatch `seats`).
const seats = (mac, remote = 0) => ({ seats: { mac, remote } });
const plan = (ranked, harness = unlimited, extra = {}) => planDispatch({ ranked, engine, assignments: [], transient: [], harness, agentsRunning: 0, ...extra });
const item = (key, state, agentCount = 1, variation = 'A') => ({ key, variation, state, agentCount, planning: engine.steps.find(s => s.id === state)['is-planning-stage'] === true });

test('a variation at a prompt step with no assignment is dispatched; other action types are not', () => {
  const ranked = [ticket('T-1', at('committed')), ticket('T-2', at('plan')), ticket('T-3', at('build')), ticket('T-4', at('test')), ticket('T-5', at('gate')), ticket('T-6', at('done')), ticket('T-7', at('blocked')), ticket('T-8', at('review'))];
  assert.deepEqual(plan(ranked).dispatch, [item('T-2', 'plan'), item('T-3', 'build', 2), item('T-8', 'review')]);
});

test('a variation with an assignment never gets another, whether the assignment names the variation or not', () => {
  const ranked = [ticket('T-1', at('build')), ticket('T-2', at('review')), ticket('T-3', at('review'), at('review', { name: 'B' }))];
  const assignments = [assignment('T-1', 'A', 'build'), assignment('T-2', null, 'review'), assignment('T-3', 'A', 'review')];
  assert.deepEqual(plan(ranked, unlimited, { assignments }).dispatch, [item('T-3', 'review', 1, 'B')]);
});

test('paused, soft-deleted, blocked-for-human, done and externally-waiting variations neither dispatch nor reserve a slot', () => {
  const ranked = [
    ticket('T-1', at('build', { 'is-paused': true })),
    ticket('T-2', at('build', { 'is-deleted': true })),
    ticket('T-5', at('blocked-for-human')),
    ticket('T-6', at('done')),
    ticket('T-8', at('qa')),   // waits on the ticket system, nothing to implement
    ticket('T-7', at('review')),
  ];
  const result = plan(ranked, unlimited, seats(1));
  assert.deepEqual(result.reserved, [{ key: 'T-7', variation: 'A' }]);
  assert.deepEqual(result.dispatch, [item('T-7', 'review')]);
  // a paused ticket, not just a paused variation.
  assert.deepEqual(plan([{ ...ticket('T-1', at('build')), 'is-paused': true }, ticket('T-2', at('review'))], unlimited, seats(1)).dispatch, [item('T-2', 'review')]);
});

// ASS-527 (replacing ASS-203's rule that a gate or a human step held its slot by position): a variation holds a
// seat only while its current step uses its machine — at a gate or a human step it holds none, the next takes it.
test('ASS-527 AC1: a top-level human step holds no in-progress slot; the next ticket reserves and dispatches', () => {
  const result = plan([ticket('T-1', at('gate')), ticket('T-2', at('review'))], unlimited, seats(1));
  assert.deepEqual(result.reserved, [{ key: 'T-2', variation: 'A' }]);
  assert.deepEqual(result.dispatch, [item('T-2', 'review')]);
  assert.deepEqual(result.waiting, []);
});

test('ASS-527 AC1: a variation gated on leaving its step, its work there done, holds no slot; the next in rank order takes it', () => {
  const gated = at('review', { 'gate-when-leaving-state': ['e/review'], 'state-changes': [{ 'from-state': 'build', 'to-state': 'review', 'work-is-done': true }] });
  const result = plan([ticket('T-1', gated), ticket('T-2', at('review')), ticket('T-3', at('review'))], unlimited, seats(1));
  assert.deepEqual(result.reserved, [{ key: 'T-2', variation: 'A' }]);
  assert.deepEqual(result.dispatch, [item('T-2', 'review')]);
  assert.deepEqual(result.waiting, [{ key: 'T-3', variation: 'A' }]);
});

test('ASS-527 AC3: back from the gate at a step that uses its machine, it waits for a seat (planner `waiting`) and takes the next free one in rank order', () => {
  const harness = unlimited;
  // T-1 has left its gate for review (a prompt step), T-2 took the seat meanwhile and is still seated there (seats.js record).
  const seated = (t, v) => t.key === 'T-2' && { key: 'T-2', variation: 'A', kind: 'vm' };
  const back = plan([ticket('T-1', at('review')), ticket('T-2', at('build'))], harness, { ...seats(1), seated });
  assert.deepEqual([back.reserved, back.waiting, back.dispatch], [[{ key: 'T-2', variation: 'A' }], [{ key: 'T-1', variation: 'A' }], [item('T-2', 'build', 2)]]);
  // T-2 reaches a gate: its seat is free, and T-1 takes it.
  const freed = plan([ticket('T-1', at('review')), ticket('T-2', at('gate'))], harness, { ...seats(1), seated });
  assert.deepEqual([freed.reserved, freed.waiting, freed.dispatch], [[{ key: 'T-1', variation: 'A' }], [], [item('T-1', 'review')]]);
});

test('ASS-527: slotKind is the pool (poolOf, by position) only while the current step uses its machine; poolOf alone says the pool', () => {
  const gate = engine.steps.find(s => s.id === 'gate'), build = engine.steps.find(s => s.id === 'build');
  assert.equal(poolOf(gate), 'progress');
  assert.equal(poolOf(gate, { chain: [{ step: { 'is-planning-stage': true } }] }), 'planning');
  assert.equal(slotKind(gate), null);
  assert.equal(slotKind(build), 'progress');
  // a script step: by its command's declaration (machine-steps.js), or run-location vm.
  const script = command => ({ id: 's', action: { type: 'script', command } });
  assert.equal(slotKind(script('./agent.sh automated-tests:verify-success {project} {ticket} {variation}')), 'progress');
  assert.equal(slotKind(script('./agent.sh merge-request:check {project} {ticket} {variation}')), null);
  assert.equal(slotKind({ ...script('./agent.sh merge-request:check {project} {ticket} {variation}'), 'run-location': 'vm' }), 'progress');
  // a group step whose run has not started takes none: its first step decides.
  assert.equal(slotKind(engine.steps.find(s => s.id === 'test')), null);
});

test('ASS-528 AC2: planning and building take one pool of seats, in rank order; the queue (committed) takes none', () => {
  const ranked = [ticket('T-1', at('plan')), ticket('T-2', at('build')), ticket('T-3', at('committed'))];
  const two = plan(ranked, unlimited, seats(2));
  assert.deepEqual([two.inPlanning, two.reserved], [[{ key: 'T-1', variation: 'A' }], [{ key: 'T-2', variation: 'A' }]]);
  assert.deepEqual(two.dispatch, [item('T-1', 'plan'), item('T-2', 'build', 2)]);
  // every seat taken: none free for the queue's next, of either pool.
  assert.deepEqual(two.free, { planning: false, progress: false });
  assert.equal(two.freeSeats, 0);
  // one seat: the higher-ranked takes it, planning or not; the other waits.
  const one = plan(ranked, unlimited, seats(1));
  assert.deepEqual([one.inPlanning, one.reserved, one.waiting], [[{ key: 'T-1', variation: 'A' }], [], [{ key: 'T-2', variation: 'A' }]]);
  const swapped = plan([ticket('T-2', at('build')), ticket('T-1', at('plan'))], unlimited, seats(1));
  assert.deepEqual([swapped.inPlanning, swapped.reserved, swapped.waiting], [[], [{ key: 'T-2', variation: 'A' }], [{ key: 'T-1', variation: 'A' }]]);
  // a ticket in the queue leaves both free.
  assert.deepEqual(plan([ticket('T-3', at('committed'))], unlimited, seats(1)).free, { planning: true, progress: true });
});

test('ASS-528 AC1: max-tickets-in-progress and max-tickets-in-planning are no longer read, harness.json\'s or project.json\'s', () => {
  const ranked = [ticket('T-1', at('review')), ticket('T-2', at('review')), ticket('T-3', at('plan')), ticket('T-4', at('plan'))];
  const counts = { 'max-tickets-in-progress': 1, 'max-tickets-in-planning': 1 };
  const all = [item('T-1', 'review'), item('T-2', 'review'), item('T-3', 'plan'), item('T-4', 'plan')];
  assert.deepEqual(plan(ranked, { ...unlimited, ...counts }).dispatch, all);
  assert.deepEqual(plan(ranked, unlimited, { project: counts }).dispatch, all);
  // what bounds them now is the pool's seats.
  assert.deepEqual(plan(ranked, unlimited, seats(3)).dispatch, all.slice(0, 3));
});

test('ASS-528 AC2: a seat held (recorded) is kept ahead of the rest, planning or in progress: a higher-ranked ticket back from its gate waits for the next one', () => {
  const ranked = [ticket('T-1', at('review')), ticket('T-2', at('plan'))];
  const seated = (t, v) => t.key === 'T-2' && { key: 'T-2', variation: 'A', pool: 'planning' };
  const result = plan(ranked, unlimited, { ...seats(1), seated });
  assert.deepEqual([result.inPlanning, result.waiting, result.dispatch], [[{ key: 'T-2', variation: 'A' }], [{ key: 'T-1', variation: 'A' }], [item('T-2', 'plan')]]);
  assert.deepEqual(result.onMac, [{ key: 'T-2', variation: 'A', seated: true }]);
});

test('ASS-528: remote seats — one in progress takes a remote seat first, then a Mac seat; planning takes a Mac seat, or a remote one in workstation mode', () => {
  const ranked = [ticket('T-1', at('review')), ticket('T-2', at('review')), ticket('T-3', at('plan'))];
  const mixed = plan(ranked, unlimited, seats(1, 1));
  assert.deepEqual([mixed.reserved, mixed.inPlanning, mixed.waiting], [[{ key: 'T-1', variation: 'A' }, { key: 'T-2', variation: 'A' }], [], [{ key: 'T-3', variation: 'A' }]]);
  assert.deepEqual(mixed.onMac, [{ key: 'T-2', variation: 'A', seated: false }]);   // T-1 on the remote seat, T-2 on the Mac
  // workstation mode: no Mac seats, planning on the remote seats.
  const remote = plan([ticket('T-3', at('plan')), ticket('T-1', at('review'))], unlimited, { seats: { mac: 0, remote: 1 }, planningRemote: true });
  assert.deepEqual([remote.inPlanning, remote.reserved, remote.onMac], [[{ key: 'T-3', variation: 'A' }], [], []]);
});

test('in-progress seats go to the first variations in progress in rank order, a ticket under way holding its seat; one in the queue holds none', () => {
  const ranked = [ticket('T-1', at('build')), ticket('T-2', at('committed')), ticket('T-3', at('review')), ticket('T-4', at('review'))];
  const result = plan(ranked, unlimited, { ...seats(2), assignments: [assignment('T-1', 'A', 'build')] });
  assert.deepEqual(result.reserved, [{ key: 'T-1', variation: 'A' }, { key: 'T-3', variation: 'A' }]);
  assert.deepEqual(result.dispatch, [item('T-3', 'review')]);
  // each variation of a ticket takes its own seat.
  const two = plan([ticket('T-1', at('review'), at('review', { name: 'B' })), ticket('T-2', at('review'))], unlimited, seats(2));
  assert.deepEqual(two.dispatch, [item('T-1', 'review'), item('T-1', 'review', 1, 'B')]);
  // no limit (Infinity, the default) — T-3 and T-4 go too.
  assert.deepEqual(plan(ranked, unlimited, { assignments: [assignment('T-1', 'A', 'build')] }).dispatch, [item('T-3', 'review'), item('T-4', 'review')]);
});

test('planning dispatches stop when the pool is full, counting the tickets in planning, not their agents', () => {
  const ranked = [ticket('T-1', at('plan')), ticket('T-2', at('plan')), ticket('T-3', at('plan')), ticket('T-4', at('review'))];
  assert.deepEqual(plan(ranked, unlimited, seats(2)).dispatch, [item('T-1', 'plan'), item('T-2', 'plan')]);
  // T-1's pair of agents holds one seat.
  const assignments = [assignment('T-1', 'A', 'plan'), assignment('T-1', 'A', 'plan')];
  assert.deepEqual(plan(ranked, unlimited, { ...seats(2), assignments }).dispatch, [item('T-2', 'plan')]);
  assert.deepEqual(plan(ranked, unlimited, { ...seats(4), assignments }).dispatch, [item('T-2', 'plan'), item('T-3', 'plan'), item('T-4', 'review')]);
});

test('max-agents counts the agents running plus those dispatched: a 2-agent step that does not fit is skipped, a later 1-agent one goes', () => {
  const ranked = [ticket('T-1', at('build')), ticket('T-2', at('review')), ticket('T-3', at('review'))];
  const harness = { 'max-agents': 3 };
  assert.deepEqual(plan(ranked, harness, { agentsRunning: 2 }).dispatch, [item('T-2', 'review')]);
  assert.deepEqual(plan(ranked, harness, { agentsRunning: 1 }).dispatch, [item('T-1', 'build', 2)]);
  assert.deepEqual(plan(ranked, harness, { agentsRunning: 0 }).dispatch, [item('T-1', 'build', 2), item('T-2', 'review')]);
  assert.deepEqual(plan(ranked, harness, { agentsRunning: 3 }).dispatch, []);
  // the skipped ticket keeps its seat.
  assert.deepEqual(plan(ranked, harness, { ...seats(1), agentsRunning: 2 }).reserved, [{ key: 'T-1', variation: 'A' }]);
});

test('a project\'s own max-agents holds within the harness\'s: a dispatch must fit both, the harness\'s counting every agent', () => {
  const ranked = [ticket('T-1', at('review')), ticket('T-2', at('review')), ticket('T-3', at('plan')), ticket('T-4', at('plan'))];
  const own = { 'max-agents': 2 };
  assert.deepEqual(plan(ranked, unlimited, { project: own }).dispatch, [item('T-1', 'review'), item('T-2', 'review')]);
  assert.deepEqual(plan(ranked, unlimited, { project: own, projectAgentsRunning: 1 }).dispatch, [item('T-1', 'review')]);   // its agents, not every project's
  assert.deepEqual(plan(ranked, unlimited, { project: own, agentsRunning: 50 }).dispatch, [item('T-1', 'review'), item('T-2', 'review')]);
  assert.deepEqual(plan(ranked, { 'max-agents': 10 }, { agentsRunning: 9 }).dispatch, [item('T-1', 'review')]);
  // It says how many planning seats it holds.
  assert.equal(plan(ranked, unlimited).planning, 2);
});

test('planning and implementation are planned in one pass, in rank order', () => {
  const ranked = [ticket('T-1', at('review')), ticket('T-2', at('plan')), ticket('T-3', at('build')), ticket('T-4', at('plan'))];
  assert.deepEqual(plan(ranked, { 'max-agents': 4 }, seats(2)).dispatch, [item('T-1', 'review'), item('T-2', 'plan')]);
});

// Sub-engines (ASS-67): `group` runs engine g — a planning step, a working one, a human one, one waiting outside and done.
const grouped = { steps: [...engine.steps, { id: 'group', sequence: 9, action: { type: 'state-engine', engine: 'g' } }] };
const engines = { g: { steps: [
  { id: 'draft', sequence: 1, 'is-planning-stage': true, action: { type: 'prompt', prompt: 'draft' } },
  { id: 'code', sequence: 2, action: { type: 'prompt', prompt: 'code' } },
  { id: 'ask', sequence: 3, action: { type: 'human' } },
  { id: 'wait', sequence: 4, action: { type: 'none' }, 'exit-events': [{ condition: { 'ticket-system-status': 'Done' }, 'move-to-state': 'done' }] },
  { id: 'done', sequence: 5, 'is-done': true, action: { type: 'none' } },
] } };
const inGroup = (step, extra = {}) => at('group', { 'harness-status': { state: 'group', 'state-engine': 'e', 'sub-status': { state: step, 'state-engine': 'g' } }, ...extra });
const grouping = (ranked, harness = unlimited, extra = {}) => planDispatch({ ranked, engine: grouped, engines, assignments: [], harness, agentsRunning: 0, ...extra });
const runAssignment = (workItem, state) => ({ 'work-item': workItem, variation: 'A', 'state-engine': 'g', state, 'transient-state-engine': `run-${workItem}` });
const hold = (key, state) => ({ key, variation: 'A', 'state-engine': 'g', state });

test('a variation inside a sub-engine holds its seat, and its run\'s prompt is held without one — in planning or in progress (ASS-528: one pool)', () => {
  const ranked = [ticket('T-1', inGroup('code')), ticket('T-3', inGroup('draft')), ticket('T-2', inGroup('code')), ticket('T-4', inGroup('draft'))];
  const result = grouping(ranked, unlimited, seats(2));
  assert.deepEqual(result.reserved, [{ key: 'T-1', variation: 'A' }]);
  assert.deepEqual(result.dispatch, []);                                      // a run's agents are dispatched with its run (dispatch.js)
  assert.deepEqual(result.held, [hold('T-2', 'code'), hold('T-4', 'draft')]);
  assert.equal(result.planning, 1);
  // A ticket in planning takes one seat, however many agents its run has out.
  const out = grouping([ticket('T-3', inGroup('draft')), ticket('T-4', inGroup('draft'))], unlimited, { ...seats(1), assignments: [runAssignment('T-3', 'draft'), runAssignment('T-3', 'draft')] });
  assert.deepEqual([out.planning, out.held], [1, [hold('T-4', 'draft')]]);
  // A top-level planning step counts the same.
  assert.deepEqual(grouping([ticket('T-1', at('plan')), ticket('T-3', inGroup('draft'))], unlimited, seats(1)).held, [hold('T-3', 'draft')]);
});

test('a variation at a human step or a gate inside a sub-engine waits on the human, held with no agent for its run, and (ASS-527) holds no slot; one at a step waiting outside reserves none', () => {
  const harness = unlimited;
  const gated = inGroup('code', { 'gate-when-leaving-state': ['g/code'], 'state-changes': [{ 'from-state': 'group', 'to-state': 'group', 'work-is-done': true, 'sub-state-change': { 'state-engine': 'g', 'from-state': 'draft', 'to-state': 'code' } }] });
  const result = grouping([ticket('T-1', inGroup('ask')), ticket('T-2', gated), ticket('T-3', inGroup('wait')), ticket('T-4', inGroup('code'))], harness, seats(3));
  // ASS-527: the nested human step and the gate hold no slot; only T-4, at a step that uses its machine, does.
  assert.deepEqual(result.reserved, [{ key: 'T-4', variation: 'A' }]);
  assert.deepEqual(result.held, [hold('T-1', 'ask'), hold('T-2', 'code')]);
  // Its sub-engine run done, a variation is about to move on: at a none step it holds no slot (ASS-527), so T-2 takes it.
  assert.deepEqual(grouping([ticket('T-1', inGroup('done')), ticket('T-2', inGroup('code'))], unlimited, seats(1)).reserved, [{ key: 'T-2', variation: 'A' }]);
});

test('ASS-126 AC2: Blocked (a detour, follow-return-to-state), Blocked for Human and Done hold no slot — the next in rank order takes it — and Blocked\'s own run is not held for one; ASS-527: a gate holds none either', () => {
  const detour = { steps: [...grouped.steps.filter(s => s.id !== 'blocked'), { id: 'blocked', sequence: 0, 'follow-return-to-state': true, action: { type: 'state-engine', engine: 'g' } }] };
  const harness = unlimited;
  const inBlocked = at('blocked', { 'harness-status': { state: 'blocked', 'state-engine': 'e', 'sub-status': { state: 'code', 'state-engine': 'g' } } });
  for (const first of [inBlocked, at('blocked-for-human'), at('done')]) {
    const result = planDispatch({ ranked: [ticket('T-1', first), ticket('T-2', at('review'))], engine: detour, engines, harness, ...seats(1) });
    assert.deepEqual([result.reserved, result.dispatch, result.held], [[{ key: 'T-2', variation: 'A' }], [item('T-2', 'review')], []], first['harness-status'].state);
  }
  // ASS-527: a gate (a bare human step) holds none either: T-2 takes the slot.
  const gated = planDispatch({ ranked: [ticket('T-1', at('gate')), ticket('T-2', at('review'))], engine: detour, engines, harness, ...seats(1) });
  assert.deepEqual([gated.reserved, gated.dispatch], [[{ key: 'T-2', variation: 'A' }], [item('T-2', 'review')]]);
});

test('ASS-203 AC2: Blocked for Human takes no slot, reasserted standalone of the AC1 human-step cases above', () => {
  const result = plan([ticket('T-1', at('blocked-for-human')), ticket('T-2', at('review'))], unlimited, seats(1));
  assert.deepEqual(result.reserved, [{ key: 'T-2', variation: 'A' }]);
  assert.deepEqual(result.dispatch, [item('T-2', 'review')]);
});

test('triggerAllowed refuses a second transient engine for the same trigger kind, project and (when given) ticket or variation', () => {
  const transient = [
    { id: '1', project: 'p', 'state-engine': 'check-health', parent: { trigger: 'check-health' } },
    { id: '2', project: 'p', 'state-engine': 'investigate-gap', parent: { trigger: 'gap-resolution', 'work-item': 'T-1', variation: 'A' } },
    { id: '3', project: 'p', 'state-engine': 'test', parent: { 'work-item': 'T-2', variation: 'A', 'state-engine': 'e', state: 'test' } },
  ];
  assert.equal(triggerAllowed({ transient, kind: 'check-health', project: 'p' }), false);
  assert.equal(triggerAllowed({ transient, kind: 'check-health', project: 'q' }), true);
  assert.equal(triggerAllowed({ transient, kind: 'check-variation-appeal', project: 'p' }), true);
  assert.equal(triggerAllowed({ transient, kind: 'gap-resolution', project: 'p', workItem: 'T-1', variation: 'A' }), false);
  assert.equal(triggerAllowed({ transient, kind: 'gap-resolution', project: 'p', workItem: 'T-1', variation: 'B' }), true);
  assert.equal(triggerAllowed({ transient, kind: 'gap-resolution', project: 'p', workItem: 'T-1' }), false);
  assert.equal(triggerAllowed({ transient, kind: 'gap-resolution', project: 'p', workItem: 'T-9' }), true);
  assert.equal(triggerAllowed({ transient: [], kind: 'check-health', project: 'p' }), true);
  assert.equal(triggerAllowed({ kind: 'check-health', project: 'p' }), true);
});

// ASS-240 AC1: what the grouped health check is told of the ticket's project (dispatch.js, {seats}): ASS-528 its seats
// (its Mac seats, the seat budget's, and its remote ones), its seat budget and max-agents, and who holds its seats,
// those in motion past them named.
test('ASS-240 AC1, ASS-528: seatsOf gives a project\'s seats, budget and limits and its seat holders: in progress, in planning, and over the limits', () => {
  const project = { id: 'p', json: {}, seatBudget: { seats: 2, share: 50, allotment: { seats: 3 }, used: { seats: 1 } }, engine, engines: {}, tickets: [ticket('T-1', at('build')), ticket('T-2', at('review')), ticket('T-3', at('plan')), ticket('T-4', at('committed'))] };
  const state = { harness: { 'max-agents': 4 }, assignments: [], transient: [], engines: {}, projects: [project] };
  assert.deepEqual(seatsOf(state, project), {
    seats: { mac: 2, remote: 0, free: 0 },
    budget: { share: 50, allotment: 3, used: 1 },
    limits: { project: { 'max-agents': null }, harness: { 'max-agents': 4 } },
    'in-progress': ['T-2 A', 'T-1 A'], 'in-planning': [], 'over-the-limits': ['T-3 A'],   // one pool, in rank order
    targets: { 'T-2 A': 'local-vm', 'T-1 A': 'local-vm' },   // ASS-559: each holder's run target (the sprint screen's Machine and Runs in)
  });
  // no seat budget: no limit.
  assert.deepEqual(seatsOf(state, { ...project, seatBudget: null }).seats, { mac: null, remote: 0, free: null });
});

test('ASS-248 AC2: a ticket with an open blocking question (`asking`, its key) neither dispatches nor reserves a slot, as a paused one; the next ticket takes the slot', () => {
  const ranked = [ticket('T-1', at('build'), at('review', { name: 'B' })), ticket('T-2', at('review'))];
  const planned = plan(ranked, unlimited, { ...seats(1), asking: new Set(['T-1']) });
  assert.deepEqual(planned.dispatch, [item('T-2', 'review')]);
  assert.deepEqual(planned.reserved, [{ key: 'T-2', variation: 'A' }]);
  assert.deepEqual(planned.held, []);
});
