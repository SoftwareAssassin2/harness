// ASS-579: the sprint grid shows no "empty seat" rows (ASS-451's, one per free seat) any more, whatever the
// project's seats: seats are no fixed counts since the seat budget (ASS-527, ASS-528), and the compute network
// screen (n) and the seat queue (q) show room for more work. The grid is the tickets and their section lines alone;
// selection, ↑/↓, Enter, scrolling and the section lines' counts work over the ticket rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render, handleKey } from '../../src/tui/app.js';
import * as shared from '../../src/tui/screens/shared.js';
import * as sprint from '../../src/tui/screens/sprint.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const wide = { columns: 200, rows: 100, now: new Date('2026-10-01T16:04:00Z') };
const key = name => ({ name });
const steps = [
  { id: 'stuck', name: 'Stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true },
  { id: 'committed', name: 'Committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } },
  { id: 'refine', name: 'Refine', sequence: 2, 'is-planning-stage': true, action: { type: 'prompt' } },
  { id: 'detour', name: 'Detour', sequence: 3, 'follow-return-to-state': true, action: { type: 'prompt' } },
  { id: 'build', name: 'Build', sequence: 5, 'is-planning-stage': false, action: { type: 'prompt' } },
  { id: 'review', name: 'Review', sequence: 6, 'is-planning-stage': false, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const ticket = (key, state, variation = {}) => ({ key, title: `At ${state}`, variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, ...variation }] });
const paused = (key, state) => ticket(key, state, { 'is-paused': true });
const sprintOf = features => ({ number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs: [], spikes: [] });
// ASS-528: `seats`, the project's one pool (its seat budget's, seat-budget.json; none: not limited).
const stateOf = (features, { seats = null } = {}, extra = {}, more = {}) => ({
  ...initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: sprintOf(features), seatBudget: seats == null ? null : { seats }, limits: { project: {}, harness: {} }, ...more }], workflows: [{ name: 'e', steps }], assignments: [] }),
  ...extra,
});
const ALL = [
  ticket('A-1', 'done'), ticket('A-2', 'done'), ticket('A-3', 'review'), ticket('A-4', 'build'), ticket('A-5', 'detour'),
  ticket('A-6', 'refine'), ticket('A-7', 'refine'), ticket('A-8', 'committed'), ticket('A-9', 'stuck'),
];

// The grid's rows top to bottom, as the keys shown, 'E' for anything that reads "empty seat", and the section lines by their label.
function grid(state, size = wide) {
  const out = render(state, size);
  const rows = [];
  for (const l of out) {
    const text = strip(l);
    const label = l.match(/^├\x1b\[3[245]m─+ (.+?) ─+\x1b\[0m/)?.[1];
    if (label) rows.push(`[${label}]`);
    else if (text.includes('empty seat')) rows.push('E');
    else if (text.startsWith('│')) { const k = text.match(/ (A-\d+): /)?.[1]; if (k) rows.push(k); }
  }
  return { rows, out };
}
const PLAIN = ['A-1', 'A-2', '[in progress (3) ↓ · ↑ done (2)]', 'A-3', 'A-4', 'A-5', '[planning (4) ↓ · ↑ in progress (3)]', 'A-6', 'A-7', 'A-8', 'A-9'];

test('AC1: free capacity gives no empty seat rows — the grid is the same whatever the seats', () => {
  for (const seats of [null, 0, 2, 4, 9, 50]) {
    const { rows, out } = grid(stateOf(ALL, { seats }));
    assert.deepEqual(rows, PLAIN, `seats ${seats}:\n${out.join('\n')}`);
    assert.ok(!out.some(l => strip(l).includes('empty seat')), `seats ${seats}`);
  }
  // No tickets, room for many: the grid says so, no seat rows.
  const { rows, out } = grid(stateOf([], { seats: 5 }));
  assert.deepEqual(rows, []);
  assert.ok(out.some(l => strip(l).includes('No tickets in this sprint')));
});

test('AC1: a past day shows no empty seat rows', () => {
  const days = { '2026-09-30': sprintOf([ticket('A-10', 'done'), ticket('A-20', 'build'), ticket('A-30', 'refine')]) };
  const { rows } = grid(stateOf(ALL, { seats: 12 }, { day: '2026-09-30' }, { days }));
  assert.deepEqual(rows, ['A-10', '[in progress (1) ↓ · ↑ done (1)]', 'A-20', '[planning (1) ↓ · ↑ in progress (1)]', 'A-30']);
});

test('AC2: the empty-seat helpers are gone, and seatPlan has no `free`', () => {
  assert.equal(sprint.withEmptySeats, undefined);
  assert.equal(shared.freeSeats, undefined);
  const s = stateOf(ALL, { seats: 9 });
  assert.ok(!('free' in shared.seatPlan(s)));
  assert.ok(!('free' in shared.seatPlan({ ...s, day: '2026-09-30' })));
});

test('AC2: ↑/↓ move one ticket row at a time, Enter opens the selected one, with free seats', () => {
  let s = stateOf(ALL, { seats: 9 }, { focus: 'tickets', selected: 3, scroll: 0 });
  const selectedKey = st => strip(render(st, wide).find(l => l.includes('\x1b[7m'))).match(/ (A-\d+): /)?.[1];
  assert.equal(selectedKey(s), 'A-4');
  s = handleKey(s, key('down'), wide);
  assert.equal(s.selected, 4);
  assert.equal(selectedKey(s), 'A-5');
  assert.deepEqual(handleKey(s, key('return'), wide).ticket, { key: 'A-5', variation: 'A' });
  s = handleKey(s, key('up'), wide);
  assert.equal(selectedKey(s), 'A-4');
  // At the last row, down stays.
  const last = stateOf(ALL, { seats: 9 }, { focus: 'tickets', selected: ALL.length - 1, scroll: 0 });
  assert.equal(handleKey(last, key('down'), wide).selected, ALL.length - 1);
  // No tickets: nothing selected, Enter does nothing.
  const none = stateOf([], { seats: 2 }, { focus: 'tickets' });
  assert.ok(!render(none, wide).some(l => l.includes('\x1b[7m') && /A-\d+/.test(strip(l))));
  assert.equal(handleKey(none, key('return'), wide).ticket, none.ticket);
});

test('AC2: scrolling follows the selection over ticket rows', () => {
  const short = { ...wide, rows: 40 };
  let at = stateOf(ALL, { seats: 9 }, { focus: 'tickets', selected: 0, scroll: 0 });
  for (let i = 0; i < 8; i++) at = handleKey(at, key('down'), short);
  assert.equal(at.selected, 8);
  assert.ok(at.scroll > 0, 'the grid scrolled to keep the selection in view');
  assert.equal(strip(render(at, short).find(l => l.includes('\x1b[7m'))).match(/ (A-\d+): /)?.[1], 'A-9');
});

test('AC2: section lines and their counts are over the ticket rows, whatever the seats', () => {
  for (const set of [ALL, ALL.slice(2), ALL.filter(t => !/refine/.test(t.title))]) {
    assert.deepEqual(grid(stateOf(set, { seats: 11 })).rows, grid(stateOf(set)).rows);
  }
});

test('AC3: no 💺 on the grid or in its key', () => {
  const { out } = grid(stateOf(ALL, { seats: 9 }));
  assert.ok(!out.some(l => strip(l).includes('💺')), out.join('\n'));
});
