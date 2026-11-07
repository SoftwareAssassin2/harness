// ASS-195: a ticket waits for the tickets it depends on. dependencyHold — the
// one pure predicate control and the dashboard share — given { on (the
// project's wait-for-dependencies), engine (its execution engine), tickets
// (its sprint's, soft-deleted dropped), backlog (its backlog's not in the
// sprint, soft-deleted dropped), elsewhere (the keys in every other loaded
// project's sprint and backlog) }, a ticket and one of its variations:
// { waits: the keys holding it, in dependency order; ignores: [{ key, why:
// 'unknown' | 'another project' }] } — both empty unless the flag is on and
// the variation is at Committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Imported so each test fails on its own until the module exists.
const { dependencyHold } = await import('../../src/control/dependencies.js').catch(() => ({}));

const engine = { steps: [
  { id: 'backlog', sequence: 1 }, { id: 'committed', sequence: 2 }, { id: 'plan', sequence: 3 }, { id: 'build', sequence: 4 },
  { id: 'review', sequence: 5 }, { id: 'done', sequence: 6, 'is-done': true },
] };
const at = (state, extra = {}) => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, ...extra });
// A ticket: its one variation at `state`, its dependencies `deps`.
const ticket = (key, state = 'committed', deps = [], extra = {}) => ({ key, 'ticket-system-status': 'To Do', dependencies: deps, variations: [at(state)], ...extra });
// A backlog ticket, its variation in the refinement engine.
const refining = (key, state = 'groom', extra = {}) => ({ key, 'ticket-system-status': 'Backlog', dependencies: [], variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'example-backlog-refinement' } }], ...extra });
// The hold on `dependent` (its first variation) with the sprint `tickets` (the dependent included), `backlog` and `elsewhere`.
const hold = (dependent, { tickets = [], backlog = [], elsewhere = [], on = true } = {}) =>
  dependencyHold({ on, engine, tickets: [dependent, ...tickets], backlog, elsewhere }, dependent, dependent.variations[0]);
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

test('ASS-195 AC1: off Committed nothing holds — a variation past it keeps going, one before it is not held', () => {
  for (const state of ['backlog', 'plan', 'build', 'review', 'done']) {
    assert.deepEqual(hold(ticket('ASS-200', state, ['ASS-180', 'ZZZ-9']), { tickets: [ticket('ASS-180', 'plan')] }), NONE, state);
  }
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

test('ASS-195 AC3: a dependency living in another loaded project\'s sprint or backlog is ignored as another project', () => {
  assert.deepEqual(hold(ticket('ASS-200', 'committed', ['ASS-7']), { elsewhere: ['ASS-7'] }), { waits: [], ignores: [{ key: 'ASS-7', why: 'another project' }] });
});

test('ASS-195 AC3: several holding dependencies are listed in dependency order, not sorted', () => {
  const dependent = ticket('ASS-200', 'committed', ['ASS-181', 'ASS-180']);
  assert.deepEqual(hold(dependent, { tickets: [ticket('ASS-180', 'plan')], backlog: [refining('ASS-181')] }).waits, ['ASS-181', 'ASS-180']);
});

test('ASS-195 AC3: a ticket that both waits and ignores gets both, for the caller to choose', () => {
  const dependent = ticket('ASS-200', 'committed', ['ASS-9', 'ASS-180', 'ASS-7']);
  assert.deepEqual(hold(dependent, { tickets: [ticket('ASS-180', 'plan')], elsewhere: ['ASS-7'] }), {
    waits: ['ASS-180'],
    ignores: [{ key: 'ASS-9', why: 'unknown' }, { key: 'ASS-7', why: 'another project' }],
  });
});
