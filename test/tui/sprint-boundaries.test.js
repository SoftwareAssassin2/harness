// The sprint grid's section lines (ASS-358): a solid green line under the last
// Done row; a solid blue one, "planning ↓ · ↑ in progress" centred in it,
// over the first planning-pool row below the last in-progress-pool row
// (slotKind; rows in neither pool are skipped); every other line between rows
// the dim dashed one (ASS-243). Each still one line: scrolling and the
// selected row are unchanged. A past day's view draws them from its own rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { visible } from '../../src/tui/text.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const wide = { columns: 200, rows: 60, now: new Date('2026-10-01T16:04:00Z') };
const steps = [
  { id: 'stuck', name: 'Stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true },
  { id: 'committed', name: 'Committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } },
  { id: 'refine', name: 'Refine', sequence: 2, 'is-planning-stage': true, action: { type: 'prompt' } },
  { id: 'detour', name: 'Detour', sequence: 3, 'follow-return-to-state': true, action: { type: 'prompt' } },
  { id: 'build', name: 'Build', sequence: 5, 'is-planning-stage': false, action: { type: 'prompt' } },
  { id: 'review', name: 'Review', sequence: 6, 'is-planning-stage': false, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const ticket = (key, state) => ({ key, title: `At ${state}`, variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'e' } }] });
const sprintOf = features => ({ number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs: [], spikes: [] });
const stateOf = (features, extra = {}, project = {}) => ({
  ...initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: sprintOf(features), ...project }], workflows: [{ name: 'e', steps }], assignments: [] }),
  ...extra,
});
const ALL = [
  ticket('A-1', 'done'), ticket('A-2', 'done'), ticket('A-3', 'review'), ticket('A-4', 'build'), ticket('A-5', 'detour'),
  ticket('A-6', 'refine'), ticket('A-7', 'refine'), ticket('A-8', 'committed'), ticket('A-9', 'stuck'),
];
const GREEN = /^├\x1b\[32m─+ in progress ↓ · ↑ done ─+\x1b\[0m[┤█]$/;   // labelled (ASS-371)
const BLUE = /^├\x1b\[34m─+ planning ↓ · ↑ in progress ─+\x1b\[0m[┤█]$/;
const DASHED = /^│\x1b\[90m {3}- {3}- .*-\s*\x1b\[0m[│█]$/;

// The line drawn above each ticket row on show, by key: 'green', 'blue', 'dashed' or (the first row) 'top'.
function lines(state, size = wide) {
  const out = render(state, size);
  const above = {};
  out.forEach((l, i) => {
    const key = strip(l).match(/ (A-\d+): /)?.[1];
    if (!key || key in above) return;
    const prev = out[i - 1];
    above[key] = GREEN.test(prev) ? 'green' : BLUE.test(prev) ? 'blue' : DASHED.test(prev) ? 'dashed' : /^├─+┴/.test(prev) ? 'top' : prev;
  });
  return { above, out };
}

test('AC1, AC2, AC3: green under the last Done row, blue over the first planning row below the last in-progress one, skipping the detour; dashed elsewhere', () => {
  const { above, out } = lines(stateOf(ALL));
  assert.deepEqual(above, { 'A-1': 'top', 'A-2': 'dashed', 'A-3': 'green', 'A-4': 'dashed', 'A-5': 'dashed', 'A-6': 'blue', 'A-7': 'dashed', 'A-8': 'dashed', 'A-9': 'dashed' }, out.join('\n'));
  const blue = out.find(l => BLUE.test(l));
  assert.equal(visible(blue), wide.columns);
  const [left, right] = strip(blue).slice(1, -1).split(' planning ↓ · ↑ in progress ');
  assert.ok(Math.abs(left.length - right.length) <= 1, strip(blue));              // centred
  assert.equal(out.filter(l => GREEN.test(l)).length, 1);
  assert.equal(out.filter(l => BLUE.test(l)).length, 1);
});

test('ASS-371: the green line carries "in progress ↓ · ↑ done", centred, full width', () => {
  const { out } = lines(stateOf(ALL));
  const green = out.find(l => GREEN.test(l));
  assert.ok(green, out.join('\n'));
  assert.equal(visible(green), wide.columns);
  const [left, right] = strip(green).slice(1, -1).split(' in progress ↓ · ↑ done ');
  assert.ok(Math.abs(left.length - right.length) <= 1, strip(green));
});

test('AC1: no green line without Done rows, or with only Done rows', () => {
  assert.ok(!Object.values(lines(stateOf(ALL.slice(2))).above).includes('green'));
  assert.deepEqual(lines(stateOf(ALL.slice(0, 2))).above, { 'A-1': 'top', 'A-2': 'dashed' });
  assert.equal(lines(stateOf(ALL.slice(0, 3))).above['A-3'], 'green');              // Done, then a blocked or any other row
  assert.equal(lines(stateOf([ticket('A-1', 'done'), ticket('A-9', 'stuck')])).above['A-9'], 'green');
});

test('AC2: no blue line when either pool is missing, or no planning row sits below an in-progress one', () => {
  const noPlanning = lines(stateOf(ALL.filter(t => !/refine/.test(t.title)))).above;
  assert.ok(!Object.values(noPlanning).includes('blue'), JSON.stringify(noPlanning));
  const noProgress = lines(stateOf(ALL.filter(t => !/review|build/.test(t.title)))).above;
  assert.ok(!Object.values(noProgress).includes('blue'), JSON.stringify(noProgress));
  assert.equal(noProgress['A-5'], 'green');
  // Committed (no agent works it) is in neither pool: no line over it either.
  assert.ok(!Object.values(lines(stateOf([ticket('A-4', 'build'), ticket('A-8', 'committed')])).above).includes('blue'));
  assert.equal(lines(stateOf([ticket('A-4', 'build'), ticket('A-6', 'refine')])).above['A-6'], 'blue');
});

test('AC2: the full label, centred in the grid, at every width: down to the narrowest the grid fits, and below, where the screen cuts the grid', () => {
  for (const columns of [200, 160, 140, 130, 90]) {
    const out = render(stateOf(ALL), { ...wide, columns });
    const blue = out.find(l => l.startsWith('├\x1b[34m'));
    assert.ok(blue, `${columns}\n${out.join('\n')}`);
    assert.match(strip(blue), /^├─+ planning ↓ · ↑ in progress ─+/, String(columns));
    const top = strip(out.find(l => l.startsWith('┌') && l.includes('┬')));
    if (!top.endsWith('┐')) continue;                                              // the grid runs past the screen (ASS-207): cut there
    assert.equal(visible(blue), visible(top), String(columns));
    const [left, right] = strip(blue).slice(1, -1).split(' planning ↓ · ↑ in progress ');
    assert.ok(Math.abs(left.length - right.length) <= 1, strip(blue));
  }
});

test('AC3: the grid takes the same lines, scrolls and selects the same rows as with dashes alone', () => {
  const short = { ...wide, rows: 40 };
  const at = n => stateOf(ALL, { focus: 'tickets', selected: n, scroll: n });
  // The same features with every row in one pool: only dashed lines between rows.
  const flat = n => stateOf(ALL.map(t => ticket(t.key, 'build')), { focus: 'tickets', selected: n, scroll: n });
  for (const n of [0, 2, 3, 5, 99]) {
    const styled = render(at(n), short), plain = render(flat(n), short);
    assert.equal(styled.length, plain.length, String(n));
    const keys = out => out.map(l => strip(l).match(/ (A-\d+): /)?.[1]).filter(Boolean);
    assert.deepEqual(keys(styled), keys(plain), String(n));
    const where = out => out.map((l, i) => (l.includes('\x1b[7m') ? i : -1)).filter(i => i >= 0);
    assert.deepEqual(where(styled), where(plain), String(n));
    assert.ok(!styled.some(l => l.includes('\x1b[7m') && /─{5}/.test(strip(l))), 'a section line is never highlighted');
  }
  assert.ok(!('A-9' in lines(at(0), short).above));                                    // too short for every row: it scrolls
  const scrolled = lines(at(3), short).above;
  assert.equal(scrolled['A-4'], 'top');                                               // the line above the first row shown is not drawn
  assert.equal(scrolled['A-6'], 'blue');
});

test('AC4: a past day draws the lines from its own rows', () => {
  const days = { '2026-09-30': sprintOf([ticket('A-10', 'done'), ticket('A-20', 'build'), ticket('A-30', 'refine')]) };
  const live = [ticket('A-4', 'build'), ticket('A-8', 'committed')];
  const { above, out } = lines(stateOf(live, { day: '2026-09-30' }, { days }));
  assert.deepEqual(above, { 'A-10': 'top', 'A-20': 'green', 'A-30': 'blue' }, out.join('\n'));
  assert.deepEqual(lines(stateOf(live)).above, { 'A-4': 'top', 'A-8': 'dashed' });
});
