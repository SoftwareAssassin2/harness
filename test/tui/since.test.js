// ASS-260: the progress bar's changes since the snapshot before the day on show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../../src/tui/app.js';
import { earlierDay } from '../../src/tui/since.js';
import * as sprintScreen from '../../src/tui/screens/sprint.js';

const hs = state => ({ state, 'state-engine': 'example-development' });
const engine = { name: 'example-development', steps: [{ id: 'backlog', name: 'Backlog', sequence: 1 }, { id: 'code-review', name: 'Code Review', sequence: 13 }, { id: 'done', name: 'Done', sequence: 20 }] };
// A sprint (or snapshot) of one feature per status given, ABC-1 on.
const sprintAt = (...statuses) => ({
  number: 10, start: '2026-10-19', end: '2026-10-30',
  features: statuses.map((s, i) => ({ key: `ABC-${i + 1}`, title: 'Feature', priority: 1, variations: [{ name: 'A', 'harness-status': hs(s) }] })),
  bugs: [], spikes: [],
});
// The sprint screen's state names (the line under the bar) for a project with
// this sprint and these snapshots, on `day` (null: the current day) seen at `now`.
const names = (sprint, days, { day = null, now = '2026-10-27T12:00:00' } = {}) => {
  const project = { id: 'example', name: 'Example', stateEngine: 'example-development', sprint, days };
  const state = { ...initialState({ projects: [project], workflows: [engine] }), day };
  return sprintScreen.view(state, { columns: 62, rows: 30, now: new Date(now) })[3].trim().split(/\s{2,}/);
};

test('"yesterday" is the latest snapshot in the sprint before the day on show; Monday compares with Friday (ASS-260)', () => {
  const project = { sprint: sprintAt(), days: { '2026-10-16': {}, '2026-10-22': {}, '2026-10-23': {}, '2026-10-26': {}, '2026-10-31': {} } };
  assert.equal(earlierDay(project, '2026-10-26'), '2026-10-23');    // Monday: the weekend has none, so Friday's
  assert.equal(earlierDay(project, '2026-10-27'), '2026-10-26');    // today's own snapshot (written at its end) is not before it
  assert.equal(earlierDay(project, '2026-10-23'), '2026-10-22');    // a past day: the one before it
});

test('the sprint\'s first day has no earlier snapshot in the sprint: an older sprint\'s does not count (ASS-260)', () => {
  const project = { sprint: sprintAt(), days: { '2026-10-16': {}, '2026-10-19': {} } };
  assert.equal(earlierDay(project, '2026-10-19'), null);
  assert.equal(earlierDay({ sprint: null, days: { '2026-10-16': {} } }, '2026-10-19'), null);   // no active sprint
});

test('each name under the bar shows its run\'s change: +N, -N, nothing for no change, +N for a state new since (ASS-260)', () => {
  const today = sprintAt('backlog', 'done', 'done', 'done');
  const yesterday = sprintAt('backlog', 'code-review', 'code-review', 'done');
  // Code Review emptied since yesterday: it has no run today to label.
  assert.deepEqual(names(today, { '2026-10-26': yesterday }), ['Backlog', 'Done +2']);
  assert.deepEqual(names(sprintAt('backlog', 'code-review', 'code-review'), { '2026-10-26': sprintAt('backlog', 'backlog', 'code-review') }), ['Backlog -1', 'Code Review +1']);
  assert.deepEqual(names(sprintAt('backlog', 'code-review'), { '2026-10-26': sprintAt('backlog', 'backlog') }), ['Backlog -1', 'Code Review +1']);   // new since: +N
});

test('across a weekend, Monday compares with Friday\'s snapshot (ASS-260)', () => {
  const days = { '2026-10-22': sprintAt('backlog', 'backlog', 'backlog'), '2026-10-23': sprintAt('backlog', 'backlog', 'done') };
  assert.deepEqual(names(sprintAt('backlog', 'done', 'done'), days, { now: '2026-10-26T09:00:00' }), ['Backlog -1', 'Done +1']);
});

test('a past day compares with the snapshot before it; the sprint\'s first day shows no changes (ASS-260)', () => {
  const days = { '2026-10-19': sprintAt('backlog', 'backlog', 'backlog'), '2026-10-20': sprintAt('backlog', 'done', 'done'), '2026-10-21': sprintAt('done', 'done', 'done') };
  assert.deepEqual(names(sprintAt('done', 'done', 'done'), days, { day: '2026-10-20' }), ['Backlog -2', 'Done +2']);
  assert.deepEqual(names(sprintAt('done', 'done', 'done'), days, { day: '2026-10-19' }), ['Backlog']);
  assert.deepEqual(names(sprintAt('backlog', 'done'), {}, { now: '2026-10-19T09:00:00' }), ['Backlog', 'Done']);   // live, no snapshot yet
});
