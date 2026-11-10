// ASS-195, ASS-355: a ticket waits for the tickets it depends on.
// dependencyHold — the one pure predicate control, the planner, the VM job
// and the dashboard share — given { on (the project's wait-for-dependencies),
// engine (its execution engine), engines (those beneath it), tickets (its
// sprint's, soft-deleted dropped), backlog (its backlog's not in the sprint,
// soft-deleted dropped), outside (its outside-tickets.json tickets),
// elsewhere (each other loaded project's { id, engine, tickets, backlog }) },
// a ticket and one of its variations: { waits: the keys holding it, in
// dependency order; ignores: [{ key, why: 'unknown' }] } — both empty unless
// the flag is on and the variation is at a step a hold holds: any but a done
// step or a person's (ASS-355; ASS-195 held at Committed alone). Done is the
// ticket-system status the done step of the owning project's engine pairs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Imported so each test fails on its own until the module exists.
const { dependencyHold, dependencyRows } = await import('../../src/control/dependencies.js').catch(() => ({}));

const engine = { steps: [
  { id: 'backlog', sequence: 1 }, { id: 'committed', sequence: 2 }, { id: 'plan', sequence: 3 }, { id: 'build', sequence: 4 },
  { id: 'review', sequence: 5 }, { id: 'done', sequence: 6, 'is-done': true, 'paired-ticket-system-status': 'Done' },
] };
const at = (state, extra = {}) => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, ...extra });
// A ticket: its one variation at `state`, its dependencies `deps`.
const ticket = (key, state = 'committed', deps = [], extra = {}) => ({ key, 'ticket-system-status': 'To Do', dependencies: deps, variations: [at(state)], ...extra });
// A backlog ticket, its variation in the refinement engine.
const refining = (key, state = 'groom', extra = {}) => ({ key, 'ticket-system-status': 'Backlog', dependencies: [], variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'example-backlog-refinement' } }], ...extra });
// The hold on `dependent` (its first variation) with the sprint `tickets` (the dependent included), `backlog`, `elsewhere` and `outside`.
const hold = (dependent, { tickets = [], backlog = [], elsewhere = [], outside = [], on = true } = {}) =>
  dependencyHold({ on, engine, tickets: [dependent, ...tickets], backlog, elsewhere, outside }, dependent, dependent.variations[0]);
const NONE = { waits: [], ignores: [] };

test('ASS-195 AC1: a ticket at Committed waits on a same-project dependency in the sprint that is not Done', () => {
  assert.deepEqual(hold(ticket('ASS-200', 'committed', ['ASS-180']), { tickets: [ticket('ASS-180', 'plan')] }), { waits: ['ASS-180'], ignores: [] });
});

test('ASS-195 AC1: a ticket at Committed waits on a same-project dependency in the backlog', () => {
  assert.deepEqual(hold(ticket('ASS-200', 'committed', ['ASS-180']), { backlog: [refining('ASS-180')] }), { waits: ['ASS-180'], ignores: [] });
});

test('ASS-195 AC1: a dependency whose ticket-system-status is Done holds nothing, in the sprint or the backlog', () => {
  const dependent = ticket('ASS-200', 'committed', ['ASS-180']);
  assert.deepEqual(hold(dependent, { tickets: [ticket('ASS-180', 'plan', [], { 'ticket-system-status': 'Done' })] }), NONE);
  assert.deepEqual(hold(dependent, { backlog: [refining('ASS-180', 'groom', { 'ticket-system-status': 'Done' })] }), NONE);
});

test('ASS-195 AC1: a sprint dependency with any non-deleted variation at an is-done step holds nothing; a deleted one at done does not count', () => {
  const dependent = ticket('ASS-200', 'committed', ['ASS-180']);
  assert.deepEqual(hold(dependent, { tickets: [ticket('ASS-180', 'plan', [], { variations: [at('plan'), at('done', { name: 'B' })] })] }), NONE);
  assert.deepEqual(hold(dependent, { tickets: [ticket('ASS-180', 'plan', [], { variations: [at('plan'), at('done', { name: 'B', 'is-deleted': true })] })] }), { waits: ['ASS-180'], ignores: [] });
});

test('ASS-195 AC1: a backlog dependency at its refinement engine\'s done step still holds — refined is not Done', () => {
  assert.deepEqual(hold(ticket('ASS-200', 'committed', ['ASS-180']), { backlog: [refining('ASS-180', 'done')] }), { waits: ['ASS-180'], ignores: [] });
  assert.deepEqual(hold(ticket('ASS-200', 'committed', ['ASS-180']), { backlog: [refining('ASS-180', 'ready')] }), { waits: ['ASS-180'], ignores: [] });
});

test('ASS-355 AC1: a variation is held at any step but a done one — before Committed, at it and past it', () => {
  for (const state of ['backlog', 'committed', 'plan', 'build', 'review']) {
    assert.deepEqual(hold(ticket('ASS-200', state, ['ASS-180']), { tickets: [ticket('ASS-180', 'plan')] }).waits, ['ASS-180'], state);
  }
  assert.deepEqual(hold(ticket('ASS-200', 'done', ['ASS-180', 'ZZZ-9']), { tickets: [ticket('ASS-180', 'plan')] }), NONE);
});

test('ASS-195 AC1: with the flag off nothing holds, an unmet dependency at Committed or not', () => {
  assert.deepEqual(hold(ticket('ASS-200', 'committed', ['ASS-180', 'ZZZ-9']), { tickets: [ticket('ASS-180', 'plan')], on: false }), NONE);
});

test('ASS-195 AC1: dependency keys match case-insensitively', () => {
  assert.deepEqual(hold(ticket('ASS-200', 'committed', ['ass-180']), { tickets: [ticket('ASS-180', 'plan')] }).waits.map(k => k.toUpperCase()), ['ASS-180']);
  assert.deepEqual(hold(ticket('ASS-200', 'committed', ['ASS-180']), { backlog: [refining('ass-180')] }).waits.map(k => k.toUpperCase()), ['ASS-180']);
});

test('ASS-195 AC3: a dependency in no loaded project is ignored as unknown — a soft-deleted one too, dropped before the predicate sees it', () => {
  assert.deepEqual(hold(ticket('ASS-200', 'committed', ['ASS-9'])), { waits: [], ignores: [{ key: 'ASS-9', why: 'unknown' }] });
});

test('ASS-355: a dependency in another loaded project is judged by that project\'s engine — its done step\'s paired status, or a sprint variation at its done step', () => {
  const theirs = { steps: [{ id: 'doing', sequence: 1 }, { id: 'shipped', sequence: 2, 'is-done': true, 'paired-ticket-system-status': 'Closed' }] };
  const other = (tickets, backlog = []) => ({ elsewhere: [{ id: 'q', engine: theirs, tickets, backlog }] });
  const dependent = ticket('ASS-200', 'plan', ['EX-7']);
  assert.deepEqual(hold(dependent, other([ticket('EX-7', 'doing', [], { 'ticket-system-status': 'Done' })])), { waits: ['EX-7'], ignores: [] });   // Done is not their done
  assert.deepEqual(hold(dependent, other([ticket('EX-7', 'doing', [], { 'ticket-system-status': 'Closed' })])), NONE);
  assert.deepEqual(hold(dependent, other([ticket('EX-7', 'shipped')])), NONE);
  assert.deepEqual(hold(dependent, other([], [refining('EX-7', 'groom', { 'ticket-system-status': 'Closed' })])), NONE);
  assert.deepEqual(hold(dependent, other([], [refining('EX-7')])), { waits: ['EX-7'], ignores: [] });
});

test('ASS-355 AC2: a dependency in outside-tickets.json is judged by the dependent project\'s engine, its status against the done step\'s paired one', () => {
  const dependent = ticket('ASS-200', 'build', ['EX-301']);
  const outside = status => [{ key: 'EX-301', title: 'A model', url: 'https://example.test/browse/EX-301', 'ticket-system-status': status, 'ticket-system-assignment': 'A Teammate' }];
  assert.deepEqual(hold(dependent, { outside: outside('In Progress') }), { waits: ['EX-301'], ignores: [] });
  assert.deepEqual(hold(dependent, { outside: outside('Done') }), NONE);
});

test('ASS-355 AC3: done is the status the engine\'s is-done step pairs, never a hard-coded "Done"', () => {
  const merged = { steps: [...engine.steps.filter(s => s.id !== 'done'), { id: 'done', sequence: 6, 'is-done': true, 'paired-ticket-system-status': 'Released' }] };
  const dependent = ticket('ASS-200', 'plan', ['ASS-180', 'EX-1']);
  const judge = status => dependencyHold({ on: true, engine: merged, tickets: [dependent, ticket('ASS-180', 'build', [], { 'ticket-system-status': status })], outside: [{ key: 'EX-1', 'ticket-system-status': status }] }, dependent, dependent.variations[0]).waits;
  assert.deepEqual(judge('Done'), ['ASS-180', 'EX-1']);
  assert.deepEqual(judge('Released'), []);
});

test('ASS-355 AC5: done steps and person-only steps are never held — a human step at any level, a gate waiting on a human, QA waiting on the board', () => {
  const steps = [
    { id: 'committed', sequence: 2, 'is-planning-stage': true, action: { type: 'none' } },
    { id: 'build', sequence: 3, action: { type: 'state-engine', engine: 'sub' } },
    { id: 'human-review', sequence: 4, action: { type: 'human' } },
    { id: 'blocked-for-human', sequence: 0, 'is-blocked-state': true, action: { type: 'human' } },
    { id: 'qa', sequence: 5, action: { type: 'state-engine', engine: 'qa' } },
    { id: 'qa-testing', sequence: 6, action: { type: 'none' }, 'exit-events': [{ condition: { 'ticket-system-status': 'Done' }, 'move-to-state': 'done' }] },
    { id: 'done', sequence: 7, 'is-done': true, 'paired-ticket-system-status': 'Done', action: { type: 'none' } },
  ];
  const top = { steps }, engines = {
    sub: { steps: [{ id: 'code', sequence: 1, action: { type: 'prompt' } }, { id: 'payment-gate', sequence: 2, action: { type: 'human' } }, { id: 'end', sequence: 3, 'is-done': true, action: { type: 'none' } }] },
    qa: { steps: [{ id: 'qa-testing', sequence: 1, action: { type: 'none' }, 'exit-events': [{ condition: { all: [{ 'ticket-system-status': 'Done' }] }, 'move-to-state': 'done' }] }, { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } }] },
  };
  const variation = (state, sub, extra = {}) => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e', ...(sub ? { 'sub-status': { state: sub, 'state-engine': state === 'qa' ? 'qa' : 'sub' } } : {}) }, ...extra });
  const judge = v => dependencyHold({ on: true, engine: top, engines, outside: [{ key: 'EX-1', 'ticket-system-status': 'To Do' }] }, { key: 'PRJ-1', dependencies: ['EX-1'] }, v).waits;
  assert.deepEqual(judge(variation('committed')), ['EX-1']);
  assert.deepEqual(judge(variation('build', 'code')), ['EX-1']);
  for (const [what, v] of [
    ['Human Review', variation('human-review')], ['Blocked for Human', variation('blocked-for-human')], ['a human step in a run', variation('build', 'payment-gate')],
    ['QA in a run', variation('qa', 'qa-testing')], ['QA at the top', variation('qa-testing')], ['done', variation('done')], ['a run at its done step', variation('build', 'end')],
    ['a gate waiting on a human, its work done', variation('build', 'code', { 'gate-when-leaving-state': ['sub/code'], 'state-changes': [{ 'state-engine': 'e', 'from-state': 'build', 'to-state': 'build', 'sub-state-change': { 'state-engine': 'sub', 'from-state': null, 'to-state': 'code' }, 'work-is-done': true }] })],
  ]) assert.deepEqual(judge(v), [], what);
});

test('ASS-195 AC3: a ticket that both waits and ignores gets both, for the caller to choose', () => {
  const dependent = ticket('ASS-200', 'committed', ['ASS-9', 'ASS-180']);
  assert.deepEqual(hold(dependent, { tickets: [ticket('ASS-180', 'plan')] }), {
    waits: ['ASS-180'],
    ignores: [{ key: 'ASS-9', why: 'unknown' }],
  });
});

test('ASS-355: dependencyRows names each dependency with where it is, its status and assignee, and whether it is done', () => {
  const dependent = ticket('ASS-200', 'plan', ['ASS-180', 'EX-1', 'ZZ-9']);
  assert.deepEqual(dependencyRows({ engine, tickets: [dependent, ticket('ASS-180', 'plan', [], { 'ticket-system-assignment': 'Me' })], outside: [{ key: 'EX-1', 'ticket-system-status': 'Done', 'ticket-system-assignment': 'A Teammate' }] }, dependent), [
    { key: 'ASS-180', where: 'sprint', status: 'To Do', assignee: 'Me', done: false },
    { key: 'EX-1', where: 'outside', status: 'Done', assignee: 'A Teammate', done: true },
    { key: 'ZZ-9', where: 'unknown', status: null, assignee: null, done: null },
  ]);
});
