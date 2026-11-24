// ASS-451: the sprint grid shows each free in-progress and planning seat as an "empty seat" row — free being the
// limit the planner enforces (project.json's, capped by harness.json's) less the seats held now (seatsOf). The
// in-progress ones go right after the last row holding an in-progress seat, the planning ones after the last
// holding a planning seat (each section's start with none). One line, "empty seat" in dim gray and a dim 💺; never
// selected; not counted in the section lines; none on a past day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render, handleKey } from '../../src/tui/app.js';
import { freeSeats } from '../../src/tui/screens/shared.js';
import { withEmptySeats } from '../../src/tui/screens/sprint.js';

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

// The grid's rows top to bottom, as the keys shown, 'E' for an empty seat row, and the section lines by their label.
function grid(state, size = wide) {
  const out = render(state, size);
  const rows = [];
  for (const l of out) {
    const text = strip(l);
    const label = l.match(/^├\x1b\[3[245]m─+ (.+?) ─+\x1b\[0m/)?.[1];
    if (label) rows.push(`[${label}]`);
    else if (/^│ {10}💺 empty seat\s*│/.test(text)) rows.push('E');
    else if (text.startsWith('│')) { const k = text.match(/ (A-\d+): /)?.[1]; if (k) rows.push(k); }
  }
  return { rows, out };
}

test('AC1, ASS-528: free seats from the pool the planner grants, less its holders — all counted as in-progress ones (one pool)', () => {
  assert.deepEqual(freeSeats({ seats: { mac: 6, remote: 0, free: 5 } }), { progress: 5, planning: 0 });
  assert.deepEqual(freeSeats({ seats: { mac: null, remote: 0, free: null } }), { progress: 0, planning: 0 });   // no limit: none
  assert.deepEqual(freeSeats({ seats: { mac: 2, remote: 0, free: 0 } }), { progress: 0, planning: 0 });
  assert.deepEqual(freeSeats({}), { progress: 0, planning: 0 });
});

test('AC1, ASS-528: another project\'s seats leave this one\'s free seats as they are — machines are never shared', () => {
  const other = { id: 'q', name: 'Q', stateEngine: 'e', sprint: sprintOf([ticket('B-1', 'build'), ticket('B-2', 'review'), ticket('B-3', 'refine')]), seatBudget: { seats: 3 }, limits: { project: {}, harness: {} } };
  const s = stateOf(ALL, { seats: 5 });
  const withOther = { ...s, projects: [s.projects[0], { ...s.projects[0], ...other }] };
  assert.deepEqual(grid(withOther).rows, grid(s).rows);
});

test('AC1, AC2, ASS-528: one row per free seat of the one pool, right after the last in-progress holder; other rows keep their places', () => {
  // A-3, A-4 hold seats in progress, A-6, A-7 in planning; A-5 (a detour) and A-8, A-9 hold none.
  const { rows, out } = grid(stateOf(ALL, { seats: 9 }));
  assert.deepEqual(rows, ['A-1', 'A-2', '[in progress (3) ↓ · ↑ done (2)]', 'A-3', 'A-4', 'E', 'E', 'E', 'E', 'E', 'A-5', '[planning (4) ↓ · ↑ in progress (3)]', 'A-6', 'A-7', 'A-8', 'A-9'], out.join('\n'));
  // Fewer seats: fewer rows, the holders taken in rank order.
  assert.deepEqual(grid(stateOf(ALL, { seats: 5 })).rows.filter(r => r === 'E').length, 1);
  assert.deepEqual(grid(stateOf(ALL, { seats: 3 })).rows.filter(r => r === 'E').length, 0);
});

test('AC1: no limits, or every seat taken or over the limits: no empty seat rows', () => {
  const plain = grid(stateOf(ALL)).rows;
  assert.ok(!plain.includes('E'));
  assert.deepEqual(grid(stateOf(ALL, { seats: 4 })).rows, plain);
  assert.deepEqual(grid(stateOf(ALL, { seats: 2 })).rows, plain);   // A-4 and A-7 over the limits
});

test('AC2: with no holder of a kind, its empty seats start its section; the lines go above them', () => {
  const held = [ticket('A-1', 'done'), paused('A-3', 'review'), paused('A-4', 'build'), paused('A-6', 'refine'), ticket('A-8', 'committed')];
  assert.deepEqual(grid(stateOf(held, { seats: 3 })).rows,
    ['A-1', '[in progress (2) ↓ · ↑ done (1)]', 'E', 'E', 'E', 'A-3', 'A-4', '[planning (2) ↓ · ↑ in progress (2)]', 'A-6', 'A-8']);
  // No in-progress rows at all: under the Done rows, before the planning ones.
  assert.deepEqual(grid(stateOf([ticket('A-1', 'done'), ticket('A-6', 'refine')], { seats: 3 })).rows,
    ['A-1', '[in progress (1) ↓ · ↑ done (1)]', 'E', 'E', 'A-6']);   // ASS-528: one pool, its free seats in one place
  // No planning rows: after the last in-progress row and the empty in-progress seats.
  assert.deepEqual(grid(stateOf([ticket('A-3', 'review'), paused('A-4', 'build'), ticket('A-8', 'committed')], { seats: 3 })).rows,
    ['A-3', 'E', 'E', 'A-4', 'A-8']);
  // No tickets: the seats alone.
  assert.deepEqual(grid(stateOf([], { seats: 2 })).rows, ['E', 'E']);
});

test('AC2: withEmptySeats puts each kind after its last holder, ticket rows in order', () => {
  const tickets = ['a', 'b', 'c'].map(k => ({ key: k, variation: { name: 'A' } }));
  const { rows, place } = withEmptySeats(tickets, { progress: ['a A'], planning: ['b A'], free: { progress: 1, planning: 2 } });
  assert.deepEqual(rows.map(r => r.key ?? r.emptySeat), ['a', 'progress', 'b', 'planning', 'planning', 'c']);
  assert.equal(place(1, false), 1);
  assert.equal(place(2, true), 3);   // the blue line over c goes above the planning seats before it
  assert.equal(place(2, false), 3);
  assert.deepEqual(withEmptySeats(tickets, { free: { progress: 0, planning: 0 } }).rows, tickets);
});

test('AC3: one line — dim gray "empty seat" and a dim 💺 where the rows\' 🤖/💻 column is (ASS-559: no seat column), every other cell blank', () => {
  const { out } = grid(stateOf(ALL, { seats: 9 }));
  const row = out.find(l => strip(l).includes('empty seat'));
  assert.ok(row.includes('\x1b[2m💺\x1b[0m'), row);
  assert.ok(row.includes('\x1b[2m\x1b[90mempty seat\x1b[0m\x1b[0m'), row);
  assert.match(strip(row), /^│ {10}💺 empty seat +│$/);   // no key, title, status, points, spend, machine or anything else
  // "empty seat" starts where a holder's key does (ASS-559: the 💺 in the 🤖/💻 column, the seat column gone).
  const holder = strip(out.find(l => strip(l).includes('A-3: ')));
  assert.equal(strip(row).indexOf('empty seat'), holder.indexOf('A-3: '));
  // The next row is the next row of the grid: no second line.
  const i = out.indexOf(row);
  assert.match(strip(out[i + 1]), /^│\s+-|empty seat|A-5/);
});

test('AC4: empty seat rows are never selected: ↑/↓ skip them, Enter on a ticket row still opens it', () => {
  let s = stateOf(ALL, { seats: 9 }, { focus: 'tickets', selected: 3, scroll: 0 });
  const selectedKey = st => strip(render(st, wide).find(l => l.includes('\x1b[7m'))).match(/ (A-\d+): /)?.[1];
  assert.equal(selectedKey(s), 'A-4');                              // grid rows: A-1 A-2 A-3 A-4 E E E E E A-5 …
  s = handleKey(s, key('down'), wide);
  assert.equal(s.selected, 9);
  assert.equal(selectedKey(s), 'A-5');                              // past the five empty seats
  s = handleKey(s, key('up'), wide);
  assert.equal(selectedKey(s), 'A-4');
  // A selection left on an empty seat row (the seats changed under it) moves to the next ticket row.
  const stale = stateOf(ALL, { seats: 9 }, { focus: 'tickets', selected: 4, scroll: 0 });
  assert.equal(selectedKey(stale), 'A-5');
  const opened = handleKey(stale, key('return'), wide);
  assert.deepEqual(opened.ticket, { key: 'A-5', variation: 'A' });
  // Down from the last ticket row onto trailing empty seats: the selection stays, the grid scrolls to show them.
  const trailing = stateOf([ticket('A-3', 'review')], { seats: 3 }, { focus: 'tickets', selected: 0, scroll: 0 });
  const down = handleKey(trailing, key('down'), wide);
  assert.equal(down.selected, 0);
  // Nothing but empty seats: nothing selected, Enter does nothing.
  const none = stateOf([], { seats: 2 }, { focus: 'tickets' });
  assert.ok(!render(none, wide).some(l => l.includes('\x1b[7m') && strip(l).includes('empty seat')));
  assert.equal(handleKey(none, key('return'), wide).ticket, none.ticket);
  assert.equal(handleKey(none, key('down'), wide).selected, none.selected);
});

test('AC4: scrolling counts empty seat rows as rows', () => {
  const short = { ...wide, rows: 50 };
  const s = stateOf(ALL, { seats: 9 }, { focus: 'tickets', selected: 0, scroll: 0 });
  let at = s;
  for (let i = 0; i < 8; i++) at = handleKey(at, key('down'), short);
  assert.equal(strip(render(at, short).find(l => l.includes('\x1b[7m'))).match(/ (A-\d+): /)?.[1], 'A-9');
  assert.ok(at.scroll > 0);
});

test('AC4: section-line counts and positions among the ticket rows are unchanged', () => {
  const tickets = r => r.filter(x => x !== 'E');
  for (const set of [ALL, ALL.slice(2), ALL.filter(t => !/refine/.test(t.title))]) {
    const plain = grid(stateOf(set)).rows;
    const seated = grid(stateOf(set, { seats: 11 })).rows;
    assert.ok(seated.includes('E'));
    assert.deepEqual(tickets(seated), plain);
  }
});

test('AC5: a past day shows no empty seat rows', () => {
  const days = { '2026-09-30': sprintOf([ticket('A-10', 'done'), ticket('A-20', 'build'), ticket('A-30', 'refine')]) };
  const { rows } = grid(stateOf(ALL, { seats: 12 }, { day: '2026-09-30' }, { days }));
  assert.deepEqual(rows, ['A-10', '[in progress (1) ↓ · ↑ done (1)]', 'A-20', '[planning (1) ↓ · ↑ in progress (1)]', 'A-30']);
});
