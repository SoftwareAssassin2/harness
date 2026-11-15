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
const stateOf = (features, { project = null, harness = null } = {}, extra = {}, more = {}) => ({
  ...initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: sprintOf(features), limits: { project: project ?? {}, harness: harness ?? {} }, ...more }], workflows: [{ name: 'e', steps }], assignments: [] }),
  ...extra,
});
const ALL = [
  ticket('A-1', 'done'), ticket('A-2', 'done'), ticket('A-3', 'review'), ticket('A-4', 'build'), ticket('A-5', 'detour'),
  ticket('A-6', 'refine'), ticket('A-7', 'refine'), ticket('A-8', 'committed'), ticket('A-9', 'stuck'),
];
const limits = (progress, planning) => ({ 'max-tickets-in-progress': progress, 'max-tickets-in-planning': planning });

// The grid's rows top to bottom, as the keys shown, 'E' for an empty seat row, and the section lines by their label.
function grid(state, size = wide) {
  const out = render(state, size);
  const rows = [];
  for (const l of out) {
    const text = strip(l);
    const label = l.match(/^├\x1b\[3[245]m─+ (.+?) ─+\x1b\[0m/)?.[1];
    if (label) rows.push(`[${label}]`);
    else if (/^│ {12}💺 empty seat\s*│/.test(text)) rows.push('E');
    else if (text.startsWith('│')) { const k = text.match(/ (A-\d+): /)?.[1]; if (k) rows.push(k); }
  }
  return { rows, out };
}

test('AC1: free seats per kind from the limits the planner enforces, less the holders', () => {
  const seats = (project, harness, progress = 0, planning = 0) => freeSeats({
    limits: { project: { ...limits(null, null), ...project }, harness: { ...limits(null, null), ...harness } },
    'in-progress': Array.from({ length: progress }, (_, i) => `A-${i} A`), 'in-planning': Array.from({ length: planning }, (_, i) => `B-${i} A`),
  });
  assert.deepEqual(seats(limits(6, 6), {}, 1, 0), { progress: 5, planning: 6 });                        // project's alone
  assert.deepEqual(seats({}, limits(3, 2), 1, 1), { progress: 2, planning: 1 });                        // harness's alone
  assert.deepEqual(seats(limits(6, 2), limits(4, 5), 1, 1), { progress: 3, planning: 1 });              // both: the smaller
  assert.deepEqual(seats({}, {}, 2, 2), { progress: 0, planning: 0 });                                  // no limit: none
  assert.deepEqual(seats(limits(2, 1), {}, 2, 3), { progress: 0, planning: 0 });                        // at or over the limits: none
  assert.deepEqual(seats(limits(0, null), {}, 0, 0), { progress: 0, planning: 0 });                     // a limit of 0: none
  assert.deepEqual(freeSeats({}), { progress: 0, planning: 0 });
  // Harness.json's limit is every project's together: the other projects' seats (inMotion) count against it too.
  const both = { limits: { project: limits(6, 6), harness: limits(4, 3) }, 'in-progress': ['A-1 A'], 'in-planning': [] };
  assert.deepEqual(freeSeats(both, { progress: 2, planning: 1 }), { progress: 1, planning: 2 });
  assert.deepEqual(freeSeats(both, { progress: 5, planning: 3 }), { progress: 0, planning: 0 });
  assert.deepEqual(freeSeats({ ...both, limits: { project: limits(1, 6), harness: limits(9, null) } }, { progress: 2, planning: 9 }), { progress: 0, planning: 6 });
});

test('AC1: another project\'s seats under a harness-wide limit leave fewer free, as the planner grants them', () => {
  const other = { id: 'q', name: 'Q', stateEngine: 'e', sprint: sprintOf([ticket('B-1', 'build'), ticket('B-2', 'review'), ticket('B-3', 'refine')]), limits: { project: {}, harness: {} } };
  const withOther = (harness, project = {}) => {
    const s = stateOf(ALL, { project, harness });
    return { ...s, projects: [s.projects[0], { ...s.projects[0], ...other }] };
  };
  // Five in progress across the harness: Q holds two, P two (A-3, A-4) — one free; planning 3: Q one, P two — none.
  assert.deepEqual(grid(withOther(limits(5, 3))).rows, ['A-1', 'A-2', '[in progress (3) ↓ · ↑ done (2)]', 'A-3', 'A-4', 'E', 'A-5', '[planning (4) ↓ · ↑ in progress (3)]', 'A-6', 'A-7', 'A-8', 'A-9']);
  // Alone, the same limits would leave four: three in progress, one planning.
  assert.equal(grid(stateOf(ALL, { harness: limits(5, 3) })).rows.filter(r => r === 'E').length, 4);
  // The project's own limit the tighter: it rules.
  assert.equal(grid(withOther(limits(9, 9), limits(3, 2))).rows.filter(r => r === 'E').length, 1);
});

test('AC1, AC2: one row per free seat, right after the last holder of each kind; other rows keep their places', () => {
  // A-3, A-4 hold the in-progress seats, A-6, A-7 the planning ones; A-5 (a detour) and A-8, A-9 hold none.
  const { rows, out } = grid(stateOf(ALL, { project: limits(4, 5) }));
  assert.deepEqual(rows, ['A-1', 'A-2', '[in progress (3) ↓ · ↑ done (2)]', 'A-3', 'A-4', 'E', 'E', 'A-5', '[planning (4) ↓ · ↑ in progress (3)]', 'A-6', 'A-7', 'E', 'E', 'E', 'A-8', 'A-9'], out.join('\n'));
  // Capped by harness.json's, and harness.json's alone.
  assert.deepEqual(grid(stateOf(ALL, { project: limits(4, 5), harness: limits(3, 3) })).rows.filter(r => r === 'E').length, 2);
  assert.deepEqual(grid(stateOf(ALL, { harness: limits(3, null) })).rows, ['A-1', 'A-2', '[in progress (3) ↓ · ↑ done (2)]', 'A-3', 'A-4', 'E', 'A-5', '[planning (4) ↓ · ↑ in progress (3)]', 'A-6', 'A-7', 'A-8', 'A-9']);
});

test('AC1: no limits, or every seat taken or over the limits: no empty seat rows', () => {
  const plain = grid(stateOf(ALL)).rows;
  assert.ok(!plain.includes('E'));
  assert.deepEqual(grid(stateOf(ALL, { project: limits(2, 2) })).rows, plain);
  assert.deepEqual(grid(stateOf(ALL, { project: limits(1, 1) })).rows, plain);   // A-4 and A-7 over the limits
});

test('AC2: with no holder of a kind, its empty seats start its section; the lines go above them', () => {
  const held = [ticket('A-1', 'done'), paused('A-3', 'review'), paused('A-4', 'build'), paused('A-6', 'refine'), ticket('A-8', 'committed')];
  assert.deepEqual(grid(stateOf(held, { project: limits(2, 1) })).rows,
    ['A-1', '[in progress (2) ↓ · ↑ done (1)]', 'E', 'E', 'A-3', 'A-4', '[planning (2) ↓ · ↑ in progress (2)]', 'E', 'A-6', 'A-8']);
  // No in-progress rows at all: under the Done rows, before the planning ones.
  assert.deepEqual(grid(stateOf([ticket('A-1', 'done'), ticket('A-6', 'refine')], { project: limits(1, 2) })).rows,
    ['A-1', '[in progress (1) ↓ · ↑ done (1)]', 'E', 'A-6', 'E']);
  // No planning rows: after the last in-progress row and the empty in-progress seats.
  assert.deepEqual(grid(stateOf([ticket('A-3', 'review'), paused('A-4', 'build'), ticket('A-8', 'committed')], { project: limits(2, 1) })).rows,
    ['A-3', 'E', 'A-4', 'E', 'A-8']);
  // No tickets: the seats alone.
  assert.deepEqual(grid(stateOf([], { project: limits(1, 1) })).rows, ['E', 'E']);
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

test('AC3: one line — dim gray "empty seat" and a dim 💺 in the seat column, every other cell blank', () => {
  const { out } = grid(stateOf(ALL, { project: limits(4, 5) }));
  const row = out.find(l => strip(l).includes('empty seat'));
  assert.ok(row.includes('\x1b[2m💺\x1b[0m'), row);
  assert.ok(row.includes('\x1b[2m\x1b[90mempty seat\x1b[0m\x1b[0m'), row);
  assert.match(strip(row), /^│ {12}💺 empty seat +│$/);   // no key, title, status, points, spend or anything else
  // The seat column lines up with a holder's.
  const holder = strip(out.find(l => strip(l).includes('A-3: ')));
  assert.equal(strip(row).indexOf('💺'), holder.indexOf('💺'));
  // The next row is the next row of the grid: no second line.
  const i = out.indexOf(row);
  assert.match(strip(out[i + 1]), /^│\s+-|empty seat|A-5/);
});

test('AC4: empty seat rows are never selected: ↑/↓ skip them, Enter on a ticket row still opens it', () => {
  let s = stateOf(ALL, { project: limits(4, 5) }, { focus: 'tickets', selected: 3, scroll: 0 });
  const selectedKey = st => strip(render(st, wide).find(l => l.includes('\x1b[7m'))).match(/ (A-\d+): /)?.[1];
  assert.equal(selectedKey(s), 'A-4');                              // grid rows: A-1 A-2 A-3 A-4 E E A-5 …
  s = handleKey(s, key('down'), wide);
  assert.equal(s.selected, 6);
  assert.equal(selectedKey(s), 'A-5');                              // past the two empty seats
  s = handleKey(s, key('up'), wide);
  assert.equal(selectedKey(s), 'A-4');
  // A selection left on an empty seat row (the seats changed under it) moves to the next ticket row.
  const stale = stateOf(ALL, { project: limits(4, 5) }, { focus: 'tickets', selected: 4, scroll: 0 });
  assert.equal(selectedKey(stale), 'A-5');
  const opened = handleKey(stale, key('return'), wide);
  assert.deepEqual(opened.ticket, { key: 'A-5', variation: 'A' });
  // Down from the last ticket row onto trailing empty seats: the selection stays, the grid scrolls to show them.
  const trailing = stateOf([ticket('A-3', 'review'), ticket('A-6', 'refine')], { project: limits(1, 3) }, { focus: 'tickets', selected: 1, scroll: 0 });
  const down = handleKey(trailing, key('down'), wide);
  assert.equal(down.selected, 1);
  // Nothing but empty seats: nothing selected, Enter does nothing.
  const none = stateOf([], { project: limits(1, 1) }, { focus: 'tickets' });
  assert.ok(!render(none, wide).some(l => l.includes('\x1b[7m') && strip(l).includes('empty seat')));
  assert.equal(handleKey(none, key('return'), wide).ticket, none.ticket);
  assert.equal(handleKey(none, key('down'), wide).selected, none.selected);
});

test('AC4: scrolling counts empty seat rows as rows', () => {
  const short = { ...wide, rows: 50 };
  const s = stateOf(ALL, { project: limits(4, 5) }, { focus: 'tickets', selected: 0, scroll: 0 });
  let at = s;
  for (let i = 0; i < 8; i++) at = handleKey(at, key('down'), short);
  assert.equal(strip(render(at, short).find(l => l.includes('\x1b[7m'))).match(/ (A-\d+): /)?.[1], 'A-9');
  assert.ok(at.scroll > 0);
});

test('AC4: section-line counts and positions among the ticket rows are unchanged', () => {
  const tickets = r => r.filter(x => x !== 'E');
  for (const set of [ALL, ALL.slice(2), ALL.filter(t => !/refine/.test(t.title))]) {
    const plain = grid(stateOf(set)).rows;
    const seated = grid(stateOf(set, { project: limits(5, 6) })).rows;
    assert.ok(seated.includes('E'));
    assert.deepEqual(tickets(seated), plain);
  }
});

test('AC5: a past day shows no empty seat rows', () => {
  const days = { '2026-09-30': sprintOf([ticket('A-10', 'done'), ticket('A-20', 'build'), ticket('A-30', 'refine')]) };
  const { rows } = grid(stateOf(ALL, { project: limits(6, 6) }, { day: '2026-09-30' }, { days }));
  assert.deepEqual(rows, ['A-10', '[in progress (1) ↓ · ↑ done (1)]', 'A-20', '[planning (1) ↓ · ↑ in progress (1)]', 'A-30']);
});
