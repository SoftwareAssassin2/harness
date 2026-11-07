// Ranking the sprint and the backlog, one tie-break at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankSprint, rankBacklog, backlogPriorities, flattenSprint, priorityOrder } from '../../src/control/rank.js';

const engine = { steps: [{ id: 'plan', sequence: 2 }, { id: 'build', sequence: 3 }, { id: 'review', sequence: 4 }, { id: 'done', sequence: 7, 'is-done': true }] };
const at = (state, extra = {}) => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, ...extra });
// A sprint ticket: every field the rules read, neutral unless overridden.
const ticket = (key, extra = {}) => ({ key, type: 'feature', 'manual-priority': null, 'ticket-system-priority': null, points: null, dependencies: [], variations: [at('plan')], ...extra });
const keys = list => list.map(t => t.key);
const sprint = (tickets, opts = { engine }) => keys(rankSprint(tickets, opts));

test('priorityOrder is Jira\'s, highest first, covering both the default scale and the Critical … Very Low one', () => {
  assert.deepEqual(priorityOrder, ['Highest', 'Critical', 'Very High', 'High', 'Medium', 'Low', 'Very Low', 'Lowest']);
  const list = [ticket('T-1', { 'ticket-system-priority': 'High' }), ticket('T-2', { 'ticket-system-priority': 'Very High' }), ticket('T-3', { 'ticket-system-priority': 'Critical' }), ticket('T-4', { 'ticket-system-priority': 'Very Low' }), ticket('T-5', { 'ticket-system-priority': 'Low' })];
  assert.deepEqual(rankSprint(list, { engine }).map(t => t.key), ['T-3', 'T-2', 'T-1', 'T-5', 'T-4']);
});

test('flattenSprint merges features, bugs and spikes, tagging each with its type and keeping its fields', () => {
  const s = { number: 10, features: [{ key: 'F-1', points: 3 }], bugs: [{ key: 'B-1' }, { key: 'B-2' }], spikes: [{ key: 'S-1' }] };
  assert.deepEqual(flattenSprint(s), [{ key: 'F-1', points: 3, type: 'feature' }, { key: 'B-1', type: 'bug' }, { key: 'B-2', type: 'bug' }, { key: 'S-1', type: 'spike' }]);
  assert.deepEqual(flattenSprint({ bugs: [{ key: 'B-1' }] }), [{ key: 'B-1', type: 'bug' }]);
  assert.deepEqual(flattenSprint({}), []);
});

test('rankSprint: manual priority beats every rule, ascending, before the rest', () => {
  const list = [ticket('T-1', { 'ticket-system-priority': 'Highest' }), ticket('T-2', { 'manual-priority': 2 }), ticket('T-3', { 'manual-priority': 1, 'ticket-system-priority': 'Lowest' })];
  assert.deepEqual(sprint(list), ['T-3', 'T-2', 'T-1']);
});

test('ASS-83 AC2: rankSprint puts a fast-tracked ticket above every other, manual priority 1 included; fast-tracked ones among themselves by the usual rules', () => {
  const list = [
    ticket('T-1', { 'manual-priority': 1, 'ticket-system-priority': 'Highest', type: 'bug' }),
    ticket('T-9', { 'fast-track': true, 'ticket-system-priority': 'Low' }),
    ticket('T-5', { 'fast-track': true, 'manual-priority': 3 }),
    ticket('T-2', { 'fast-track': false, 'manual-priority': 2 }),
  ];
  assert.deepEqual(sprint(list), ['T-5', 'T-9', 'T-1', 'T-2']);
});

test('rankSprint: Jira priority Highest … Lowest, then none', () => {
  const list = [ticket('T-1'), ticket('T-2', { 'ticket-system-priority': 'Low' }), ticket('T-3', { 'ticket-system-priority': 'Highest' }), ticket('T-4', { 'ticket-system-priority': 'Medium' }), ticket('T-5', { 'ticket-system-priority': 'Lowest' }), ticket('T-6', { 'ticket-system-priority': 'High' })];
  assert.deepEqual(sprint(list), ['T-3', 'T-6', 'T-4', 'T-2', 'T-5', 'T-1']);
});

test('rankSprint: bugs before features and spikes, within the same Jira priority', () => {
  const list = [ticket('T-1', { type: 'spike' }), ticket('T-2', { type: 'bug' }), ticket('T-3', { type: 'bug', 'ticket-system-priority': 'Low' }), ticket('T-4', { type: 'feature', 'ticket-system-priority': 'High' })];
  assert.deepEqual(sprint(list), ['T-4', 'T-3', 'T-2', 'T-1']);
});

test('rankSprint: a ticket another ticket in the list depends on comes first', () => {
  const list = [ticket('T-1'), ticket('T-2', { dependencies: ['T-3'] }), ticket('T-3')];
  assert.deepEqual(sprint(list), ['T-3', 'T-1', 'T-2']);
  // a dependency outside the list counts for nothing.
  assert.deepEqual(sprint([ticket('T-2', { dependencies: ['X-9'] }), ticket('T-1')]), ['T-1', 'T-2']);
});

test('rankSprint: closer to done first — the highest step sequence over variations not deleted', () => {
  const list = [
    ticket('T-1', { variations: [at('plan')] }),
    ticket('T-2', { variations: [at('build'), at('done', { name: 'B', 'is-deleted': true })] }),
    ticket('T-3', { variations: [at('plan'), at('review', { name: 'B' })] }),
    ticket('T-4', { variations: [] }),
    ticket('T-5', { variations: [at('unknown-step')] }),
  ];
  assert.deepEqual(sprint(list), ['T-3', 'T-2', 'T-1', 'T-4', 'T-5']);
});

test('rankSprint: more points first, missing points as 0', () => {
  const list = [ticket('T-1'), ticket('T-2', { points: 3 }), ticket('T-3', { points: 8 }), ticket('T-4', { points: 0 })];
  assert.deepEqual(sprint(list), ['T-3', 'T-2', 'T-1', 'T-4']);
});

test('rankSprint: finally the ticket number, as a number', () => {
  assert.deepEqual(sprint([ticket('T-10'), ticket('T-9'), ticket('T-100'), ticket('T-1')]), ['T-1', 'T-9', 'T-10', 'T-100']);
});

test('rankSprint applies each rule only to the ties the one before left', () => {
  const list = [
    ticket('T-1', { type: 'feature', points: 13 }),
    ticket('T-2', { type: 'bug', points: 1 }),
    ticket('T-3', { type: 'feature', points: 1, variations: [at('review')] }),
    ticket('T-4', { type: 'bug', dependencies: ['T-3'] }),
  ];
  // bugs first (T-2 has more points than T-4); then T-3, depended on, before T-1 for all its points.
  assert.deepEqual(sprint(list), ['T-2', 'T-4', 'T-3', 'T-1']);
});

test('rankSprint is pure and stable: the input is untouched, equal tickets keep their order', () => {
  const list = [ticket('T-2'), ticket('T-1')];
  const copy = structuredClone(list);
  const same = [{ ...ticket('T-1'), key: 'X' }, { ...ticket('T-1'), key: 'Y' }];   // no number: nothing tells them apart
  assert.deepEqual(sprint(list), ['T-1', 'T-2']);
  assert.deepEqual(list, copy);
  assert.deepEqual(sprint(same), ['X', 'Y']);
});

// A backlog ticket.
const item = (key, extra = {}) => ({ key, 'manual-backlog-priority': null, 'sprint-tag': null, 'ticket-system-priority': null, dependencies: [], ...extra });
const backlog = list => keys(rankBacklog(list));

test('rankBacklog: manual backlog priority first', () => {
  assert.deepEqual(backlog([item('T-1', { 'sprint-tag': 'Sprint 11' }), item('T-2', { 'manual-backlog-priority': 1 })]), ['T-2', 'T-1']);
});

test('rankBacklog: a manual backlog priority is the ticket\'s place; the rest fill the places left free, in order', () => {
  // the places left free (1, 3) go to the rest in order; one past the end comes last.
  const list = [item('T-1', { 'manual-backlog-priority': 4 }), item('T-2', { 'manual-backlog-priority': 2 }), item('T-9'), item('T-8')];
  assert.deepEqual(backlog(list), ['T-8', 'T-2', 'T-9', 'T-1']);
  assert.deepEqual(backlog([item('T-1', { 'manual-backlog-priority': 9 }), item('T-2')]), ['T-2', 'T-1']);
});

test('rankBacklog: manual-priority is the sprint\'s, never read for the backlog', () => {
  assert.deepEqual(backlog([item('T-1'), item('T-2', { 'manual-priority': 1 })]), ['T-1', 'T-2']);
});

test('backlogPriorities: each ticket\'s priority, its 1-based place in rankBacklog, a manual backlog priority kept as set', () => {
  const list = [item('T-1', { 'manual-backlog-priority': 2 }), item('T-2', { 'manual-backlog-priority': 9 }), item('T-3'), item('T-4')];
  assert.deepEqual(backlogPriorities(list), { 'T-3': 1, 'T-1': 2, 'T-4': 3, 'T-2': 9 });
  assert.deepEqual(backlogPriorities(list), backlogPriorities(structuredClone(list).reverse()));   // deterministic
});

test('rankBacklog: tagged for a sprint before untagged, earlier sprint first by its number', () => {
  const list = [item('T-1'), item('T-2', { 'sprint-tag': 'Sprint 12' }), item('T-3', { 'sprint-tag': 'Sprint 11' }), item('T-4', { 'sprint-tag': 'Sprint 9' })];
  assert.deepEqual(backlog(list), ['T-4', 'T-3', 'T-2', 'T-1']);
});

test('rankBacklog: then Jira priority, then ticket number', () => {
  const list = [item('T-3'), item('T-1', { 'ticket-system-priority': 'Low' }), item('T-2', { 'ticket-system-priority': 'Low' }), item('T-4', { 'ticket-system-priority': 'High' })];
  assert.deepEqual(backlog(list), ['T-4', 'T-1', 'T-2', 'T-3']);
});

test('rankBacklog: a ticket others depend on inherits their sprint tag and Jira priority when better, transitively', () => {
  const list = [
    item('T-1', { 'sprint-tag': 'Sprint 11', 'ticket-system-priority': 'High', dependencies: ['T-2'] }),
    item('T-2', { 'sprint-tag': 'Sprint 13', dependencies: ['T-3'] }),
    item('T-3'),
    item('T-4', { 'sprint-tag': 'Sprint 12', 'ticket-system-priority': 'Highest' }),
  ];
  // T-3 and T-2 take Sprint 11 / High from T-1; T-3 is deeper in the chain than T-2.
  assert.deepEqual(backlog(list), ['T-3', 'T-2', 'T-1', 'T-4']);
  // a better own value is kept.
  assert.deepEqual(backlog([item('T-1', { 'sprint-tag': 'Sprint 12', dependencies: ['T-2'] }), item('T-2', { 'sprint-tag': 'Sprint 11', 'ticket-system-priority': 'Low' })]), ['T-2', 'T-1']);
});

test('rankBacklog: deeper in the dependency chain first, among equals', () => {
  const list = [item('T-1', { dependencies: ['T-2'] }), item('T-2', { dependencies: ['T-3'] }), item('T-3'), item('T-0')];
  assert.deepEqual(backlog(list), ['T-3', 'T-2', 'T-0', 'T-1']);
});

test('rankBacklog survives a dependency cycle and is pure', () => {
  const list = [item('T-2', { dependencies: ['T-1'] }), item('T-1', { dependencies: ['T-2'] })];
  const copy = structuredClone(list);
  assert.deepEqual(backlog(list), ['T-1', 'T-2']);
  assert.deepEqual(list, copy);
});

test('ASS-195 AC2: a dependency raised to a manual-priority just above its dependent\'s ranks above it in the sprint, ahead of rules that favoured the dependent', () => {
  // The dependent had 4; the raise gave the dependency 4 and pushed the dependent to 5.
  const list = [ticket('T-1', { 'manual-priority': 5, dependencies: ['T-2'], 'ticket-system-priority': 'Highest' }), ticket('T-2', { 'manual-priority': 4, 'ticket-system-priority': 'Lowest' })];
  assert.deepEqual(sprint(list), ['T-2', 'T-1']);
});

test('ASS-195 AC2: a dependency raised to manual-backlog-priority 1 tops the backlog, above every other manual one', () => {
  const list = [item('B-1', { 'manual-backlog-priority': 2, 'ticket-system-priority': 'Highest' }), item('B-2', { 'manual-backlog-priority': 3 }), item('B-9', { 'manual-backlog-priority': 1 })];
  assert.equal(backlog(list)[0], 'B-9');
});
