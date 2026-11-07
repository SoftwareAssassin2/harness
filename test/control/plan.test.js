// Planning dispatches: the in-progress and planning slots (ASS-126: tickets in motion), max-agents, trigger caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDispatch, slotKind, triggerAllowed, seatsOf } from '../../src/control/plan.js';

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
const unlimited = { 'max-agents': null, 'max-tickets-in-progress': null, 'max-tickets-in-planning': null };
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
  const result = plan(ranked, { ...unlimited, 'max-tickets-in-progress': 1 });
  assert.deepEqual(result.reserved, [{ key: 'T-7', variation: 'A' }]);
  assert.deepEqual(result.dispatch, [item('T-7', 'review')]);
  // a paused ticket, not just a paused variation.
  assert.deepEqual(plan([{ ...ticket('T-1', at('build')), 'is-paused': true }, ticket('T-2', at('review'))], { ...unlimited, 'max-tickets-in-progress': 1 }).dispatch, [item('T-2', 'review')]);
});

// ASS-203 AC1: a gate or a top-level human step holds its slot by position — gets no agent, but does not give the seat up.
test('ASS-203 AC1: a top-level human step holds the only in-progress slot; the next ticket neither reserves nor dispatches', () => {
  const result = plan([ticket('T-1', at('gate')), ticket('T-2', at('review'))], { ...unlimited, 'max-tickets-in-progress': 1 });
  assert.deepEqual(result.reserved, [{ key: 'T-1', variation: 'A' }]);
  assert.deepEqual(result.dispatch, []);
});

test('ASS-203 AC1/AC3: a gated ticket holds the only in-progress slot; lower-ranked tickets wait, even with slots to spare in number but not in limit', () => {
  const gated = at('review', { 'gate-when-leaving-state': ['e/review'], 'state-changes': [{ 'from-state': 'build', 'to-state': 'review', 'work-is-done': true }] });
  const result = plan([ticket('T-1', gated), ticket('T-2', at('review')), ticket('T-3', at('review'))], { ...unlimited, 'max-tickets-in-progress': 1 });
  assert.deepEqual(result.reserved, [{ key: 'T-1', variation: 'A' }]);
  assert.deepEqual(result.dispatch, []);
});

test('ASS-203 AC3: the slot frees once the gate is left, for the next ticket to take', () => {
  const harness = { ...unlimited, 'max-tickets-in-progress': 1 };
  const gated = at('review', { 'gate-when-leaving-state': ['e/review'], 'state-changes': [{ 'from-state': 'build', 'to-state': 'review', 'work-is-done': true }] });
  const before = plan([ticket('T-1', gated), ticket('T-2', at('review'))], harness);
  assert.deepEqual([before.reserved, before.dispatch], [[{ key: 'T-1', variation: 'A' }], []]);
  // T-1 has moved on past the gated step: its slot is free for T-2.
  const after = plan([ticket('T-1', at('done')), ticket('T-2', at('review'))], harness);
  assert.deepEqual(after.dispatch, [item('T-2', 'review')]);
});

test('ASS-203 AC1: slotKind no longer nulls a bare human step — it holds a progress or planning slot by position', () => {
  const gate = engine.steps.find(s => s.id === 'gate');
  assert.equal(slotKind(gate), 'progress');
  assert.equal(slotKind(gate, { chain: [{ step: { 'is-planning-stage': true } }] }), 'planning');
});

test('ASS-126 AC6: a planning step takes a planning slot, not an in-progress one; the queue (committed) takes none', () => {
  const harness = { 'max-agents': null, 'max-tickets-in-progress': 1, 'max-tickets-in-planning': 1 };
  const result = plan([ticket('T-1', at('plan')), ticket('T-2', at('build')), ticket('T-3', at('committed'))], harness);
  assert.deepEqual(result.reserved, [{ key: 'T-2', variation: 'A' }]);
  assert.equal(result.planning, 1);
  assert.deepEqual(result.dispatch, [item('T-1', 'plan'), item('T-2', 'build', 2)]);
  // every slot taken: none free for the queue's next.
  assert.deepEqual(result.free, { planning: false, progress: false });
  // a ticket in the queue leaves both free.
  assert.deepEqual(plan([ticket('T-3', at('committed'))], harness).free, { planning: true, progress: true });
});

test('in-progress slots go to the first max-tickets-in-progress variations in progress in rank order, a ticket under way holding its slot; one in the queue holds none', () => {
  const ranked = [ticket('T-1', at('build')), ticket('T-2', at('committed')), ticket('T-3', at('review')), ticket('T-4', at('review'))];
  const result = plan(ranked, { ...unlimited, 'max-tickets-in-progress': 2 }, { assignments: [assignment('T-1', 'A', 'build')] });
  assert.deepEqual(result.reserved, [{ key: 'T-1', variation: 'A' }, { key: 'T-3', variation: 'A' }]);
  assert.deepEqual(result.dispatch, [item('T-3', 'review')]);
  // each variation of a ticket takes its own slot.
  const two = plan([ticket('T-1', at('review'), at('review', { name: 'B' })), ticket('T-2', at('review'))], { ...unlimited, 'max-tickets-in-progress': 2 });
  assert.deepEqual(two.dispatch, [item('T-1', 'review'), item('T-1', 'review', 1, 'B')]);
  // null: unlimited — T-3 and T-4 go too.
  assert.deepEqual(plan(ranked, unlimited, { assignments: [assignment('T-1', 'A', 'build')] }).dispatch, [item('T-3', 'review'), item('T-4', 'review')]);
});

test('planning dispatches stop at max-tickets-in-planning, counting the tickets in planning, not their agents', () => {
  const ranked = [ticket('T-1', at('plan')), ticket('T-2', at('plan')), ticket('T-3', at('plan')), ticket('T-4', at('review'))];
  const harness = { 'max-agents': null, 'max-tickets-in-progress': null, 'max-tickets-in-planning': 2 };
  assert.deepEqual(plan(ranked, harness).dispatch, [item('T-1', 'plan'), item('T-2', 'plan'), item('T-4', 'review')]);
  // T-1's pair of agents holds one planning slot; T-4 in progress holds none of them.
  const assignments = [assignment('T-1', 'A', 'plan'), assignment('T-1', 'A', 'plan'), assignment('T-4', 'A', 'review')];
  assert.deepEqual(plan(ranked, harness, { assignments }).dispatch, [item('T-2', 'plan')]);
  // planning never takes an in-progress slot.
  assert.deepEqual(plan(ranked, { ...harness, 'max-tickets-in-progress': 1, 'max-tickets-in-planning': null }).dispatch, [item('T-1', 'plan'), item('T-2', 'plan'), item('T-3', 'plan'), item('T-4', 'review')]);
});

test('max-agents counts the agents running plus those dispatched: a 2-agent step that does not fit is skipped, a later 1-agent one goes', () => {
  const ranked = [ticket('T-1', at('build')), ticket('T-2', at('review')), ticket('T-3', at('review'))];
  const harness = { 'max-agents': 3, 'max-tickets-in-progress': null, 'max-tickets-in-planning': null };
  assert.deepEqual(plan(ranked, harness, { agentsRunning: 2 }).dispatch, [item('T-2', 'review')]);
  assert.deepEqual(plan(ranked, harness, { agentsRunning: 1 }).dispatch, [item('T-1', 'build', 2)]);
  assert.deepEqual(plan(ranked, harness, { agentsRunning: 0 }).dispatch, [item('T-1', 'build', 2), item('T-2', 'review')]);
  assert.deepEqual(plan(ranked, harness, { agentsRunning: 3 }).dispatch, []);
  // the skipped ticket keeps its reserved slot.
  assert.deepEqual(plan(ranked, { ...harness, 'max-tickets-in-progress': 1 }, { agentsRunning: 2 }).reserved, [{ key: 'T-1', variation: 'A' }]);
});

test('a project\'s own limits hold within the harness\'s: a dispatch must fit both, the harness\'s counting every project', () => {
  const ranked = [ticket('T-1', at('review')), ticket('T-2', at('review')), ticket('T-3', at('plan')), ticket('T-4', at('plan'))];
  // The project's own: one in-progress slot, one planning slot, two agents.
  const own = { 'max-tickets-in-progress': 1, 'max-tickets-in-planning': 1, 'max-agents': 2 };
  assert.deepEqual(plan(ranked, unlimited, { project: own }).dispatch, [item('T-1', 'review'), item('T-3', 'plan')]);
  assert.deepEqual(plan(ranked, unlimited, { project: own, projectAgentsRunning: 1 }).dispatch, [item('T-1', 'review')]);   // its agents, not every project's
  assert.deepEqual(plan(ranked, unlimited, { project: own, agentsRunning: 50 }).dispatch, [item('T-1', 'review'), item('T-3', 'plan')]);
  // The harness's count every project: slots and planning other projects hold, and every agent running.
  const harness = { 'max-agents': 10, 'max-tickets-in-progress': 2, 'max-tickets-in-planning': 2 };
  assert.deepEqual(plan(ranked, harness, { reservedElsewhere: 1, planningElsewhere: 1 }).dispatch, [item('T-1', 'review'), item('T-3', 'plan')]);
  assert.deepEqual(plan(ranked, harness, { reservedElsewhere: 2, planningElsewhere: 2 }).dispatch, []);
  assert.deepEqual(plan(ranked, harness, { agentsRunning: 9 }).dispatch, [item('T-1', 'review')]);
  // A project without limits of its own is bounded by the harness's alone, as before.
  assert.deepEqual(plan(ranked, harness).dispatch, [item('T-1', 'review'), item('T-2', 'review'), item('T-3', 'plan'), item('T-4', 'plan')]);
  // It says how many planning slots it holds.
  assert.equal(plan(ranked, harness).planning, 2);
});

test('planning and implementation are planned in one pass, in rank order', () => {
  const ranked = [ticket('T-1', at('review')), ticket('T-2', at('plan')), ticket('T-3', at('build')), ticket('T-4', at('plan'))];
  const harness = { 'max-agents': 4, 'max-tickets-in-progress': 1, 'max-tickets-in-planning': 1 };
  assert.deepEqual(plan(ranked, harness).dispatch, [item('T-1', 'review'), item('T-2', 'plan')]);
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

test('a variation inside a sub-engine holds its in-progress slot, and its run\'s prompt is held without one — or, at a planning step, past max-tickets-in-planning', () => {
  const harness = { 'max-agents': null, 'max-tickets-in-progress': 1, 'max-tickets-in-planning': 1 };
  const ranked = [ticket('T-1', inGroup('code')), ticket('T-2', inGroup('code')), ticket('T-3', inGroup('draft')), ticket('T-4', inGroup('draft'))];
  const result = grouping(ranked, harness);
  assert.deepEqual(result.reserved, [{ key: 'T-1', variation: 'A' }]);
  assert.deepEqual(result.dispatch, []);                                      // a run's agents are dispatched with its run (dispatch.js)
  assert.deepEqual(result.held, [hold('T-2', 'code'), hold('T-4', 'draft')]);
  assert.equal(result.planning, 1);
  // A ticket in planning takes one planning slot, however many agents its run has out.
  const out = grouping([ticket('T-3', inGroup('draft')), ticket('T-4', inGroup('draft'))], harness, { assignments: [runAssignment('T-3', 'draft'), runAssignment('T-3', 'draft')] });
  assert.deepEqual([out.planning, out.held], [1, [hold('T-4', 'draft')]]);
  // A top-level planning step counts the same.
  assert.deepEqual(grouping([ticket('T-1', at('plan')), ticket('T-3', inGroup('draft'))], harness).held, [hold('T-3', 'draft')]);
});

test('a variation at a human step or a gate inside a sub-engine reserves its top-level slot and waits on the human, held with no agent for its run; one at a step waiting outside still reserves none', () => {
  const harness = { ...unlimited, 'max-tickets-in-progress': 3 };
  const gated = inGroup('code', { 'gate-when-leaving-state': ['g/code'], 'state-changes': [{ 'from-state': 'group', 'to-state': 'group', 'work-is-done': true, 'sub-state-change': { 'state-engine': 'g', 'from-state': 'draft', 'to-state': 'code' } }] });
  const result = grouping([ticket('T-1', inGroup('ask')), ticket('T-2', gated), ticket('T-3', inGroup('wait')), ticket('T-4', inGroup('code'))], harness);
  // ASS-203 AC1: the nested human/gate step now reserves at its top-level (group) step — slot accounting and "no agent" (held) are different checks, both true at once.
  assert.deepEqual(result.reserved, [{ key: 'T-1', variation: 'A' }, { key: 'T-2', variation: 'A' }, { key: 'T-4', variation: 'A' }]);
  assert.deepEqual(result.held, [hold('T-1', 'ask'), hold('T-2', 'code')]);
  // Its sub-engine run done, a variation is about to move on: not waiting outside (unaffected by the AC1 reorder — kept at max-tickets-in-progress: 1 as before).
  assert.deepEqual(grouping([ticket('T-1', inGroup('done')), ticket('T-2', inGroup('code'))], { ...unlimited, 'max-tickets-in-progress': 1 }).reserved, [{ key: 'T-1', variation: 'A' }]);
});

test('ASS-126 AC2: Blocked (a detour, follow-return-to-state), Blocked for Human and Done hold no slot — the next in rank order takes it — and Blocked\'s own run is not held for one; ASS-203 AC1: a gate now holds its slot instead', () => {
  const detour = { steps: [...grouped.steps.filter(s => s.id !== 'blocked'), { id: 'blocked', sequence: 0, 'follow-return-to-state': true, action: { type: 'state-engine', engine: 'g' } }] };
  const harness = { ...unlimited, 'max-tickets-in-progress': 1 };
  const inBlocked = at('blocked', { 'harness-status': { state: 'blocked', 'state-engine': 'e', 'sub-status': { state: 'code', 'state-engine': 'g' } } });
  for (const first of [inBlocked, at('blocked-for-human'), at('done')]) {
    const result = planDispatch({ ranked: [ticket('T-1', first), ticket('T-2', at('review'))], engine: detour, engines, harness });
    assert.deepEqual([result.reserved, result.dispatch, result.held], [[{ key: 'T-2', variation: 'A' }], [item('T-2', 'review')], []], first['harness-status'].state);
  }
  // Unlike the trio above, a gate (a bare human step, no is-blocked-state/follow-return-to-state) keeps its seat: it holds the only slot, and T-2 neither reserves nor dispatches.
  const gated = planDispatch({ ranked: [ticket('T-1', at('gate')), ticket('T-2', at('review'))], engine: detour, engines, harness });
  assert.deepEqual([gated.reserved, gated.dispatch], [[{ key: 'T-1', variation: 'A' }], []]);
});

test('ASS-203 AC2: Blocked for Human takes no slot, reasserted standalone of the AC1 human-step cases above', () => {
  const result = plan([ticket('T-1', at('blocked-for-human')), ticket('T-2', at('review'))], { ...unlimited, 'max-tickets-in-progress': 1 });
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

// ASS-240 AC1: what the grouped health check is told of the ticket's project (dispatch.js, {seats}): its limits — its
// project.json's and harness.json's, null for none — and who holds its seats, those in motion past them named.
test('ASS-240 AC1: seatsOf gives a project\'s limits and its seat holders: in progress, in planning, and over the limits', () => {
  const project = { id: 'p', json: { 'max-tickets-in-progress': 1 }, engine, engines: {}, tickets: [ticket('T-1', at('build')), ticket('T-2', at('review')), ticket('T-3', at('plan')), ticket('T-4', at('committed'))] };
  const state = { harness: { 'max-agents': 4, 'max-tickets-in-progress': 3 }, assignments: [], transient: [], engines: {}, projects: [project] };
  assert.deepEqual(seatsOf(state, project), {
    limits: {
      project: { 'max-tickets-in-progress': 1, 'max-tickets-in-planning': null, 'max-agents': null },
      harness: { 'max-tickets-in-progress': 3, 'max-tickets-in-planning': null, 'max-agents': 4 },
    },
    'in-progress': ['T-2 A'], 'in-planning': ['T-3 A'], 'over-the-limits': ['T-1 A'],
  });
});

test('ASS-248 AC2: a ticket with an open blocking question (`asking`, its key) neither dispatches nor reserves a slot, as a paused one; the next ticket takes the slot', () => {
  const ranked = [ticket('T-1', at('build'), at('review', { name: 'B' })), ticket('T-2', at('review'))];
  const planned = plan(ranked, { ...unlimited, 'max-tickets-in-progress': 1 }, { asking: new Set(['T-1']) });
  assert.deepEqual(planned.dispatch, [item('T-2', 'review')]);
  assert.deepEqual(planned.reserved, [{ key: 'T-2', variation: 'A' }]);
  assert.deepEqual(planned.held, []);
});
