// ASS-526: the loop counter in the dashboard's bottom-right corner — the
// selected project's control's finished loops modulo 100 (frame.js loopCount,
// withLoopCount), at the right end of the bottom line, on every screen with
// the footer, within the 120-column minimum; read from each project's
// loop-count.json (load.js loadLoopCounts) into the state (loopCountsRead).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, render, loopCountsRead, controlStarted, controlExited } from '../../src/tui/app.js';
import { loopCount, withLoopCount } from '../../src/tui/screens/frame.js';
import { loadLoopCounts } from '../../src/tui/load.js';
import { visible } from '../../src/tui/text.js';

const T0 = Date.parse('2026-11-22T01:00:00Z');
const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const projects = ['p', 'q'].map(id => ({ id, name: `Project ${id}`, sprint: null, environments: [] }));
const screen = { columns: 120, rows: 50, now: new Date(T0) };
const corner = (state, size = screen) => render(state, size).at(-1);
const counted = (counts, extra = {}) => loopCountsRead({ ...initialState({ projects }), ...extra }, counts);

test('ASS-526 AC1, AC2: the bottom-right corner shows the selected project\'s finished loops modulo 100: 0 before any, 1, 99, then 0 (never 100)', () => {
  assert.match(strip(corner(initialState({ projects }))), / 0$/);   // no count yet
  for (const [loops, shown] of [[0, ' 0'], [1, ' 1'], [42, '42'], [99, '99'], [100, ' 0'], [101, ' 1'], [250, '50']]) {
    const s = counted({ p: loops });
    assert.equal(loopCount(s), Number(shown));
    const line = strip(corner(s));
    assert.ok(line.endsWith(` ${shown}`), JSON.stringify(line));
    assert.equal(visible(corner(s)), screen.columns);   // right at the corner
    assert.ok(!line.includes('100'));
  }
});

test('ASS-526 AC6: the counter takes no line of its own — the bottom line keeps its text with the counter at its right end — and fits 120 columns on every screen', () => {
  const s = counted({ p: 7 });
  const without = render(initialState({ projects }), screen), withIt = render(s, screen);
  assert.equal(withIt.length, without.length);
  assert.equal(strip(withIt.at(-1)).trimEnd().replace(/ +7$/, '').trimEnd(), strip(without.at(-1)).replace(/ +0$/, '').trimEnd());
  assert.match(strip(withIt.at(-1)), /press \? for menu +7$/);
  for (const name of ['s', 'b', 'c', 'a', 'S', 'B']) {
    const lines = render({ ...s, screen: name }, screen);
    assert.equal(lines.length, screen.rows);
    assert.ok(lines.every(l => visible(l) <= screen.columns), name);
    assert.match(strip(lines.at(-1)), / 7$/, name);
  }
  // With the "last updated" line under the legend, the counter sits on that one, the last.
  const updated = render({ ...s, updatedAt: { p: T0 - 5000 } }, screen);
  assert.match(strip(updated.at(-1)), /last updated: .* 7$/);
  assert.match(strip(updated.at(-2)), /press \? for menu$/);
  // A bottom line that would reach the corner is cut short for it.
  const long = withLoopCount('x'.repeat(200), s, 120);
  assert.equal(visible(long), 120);
  assert.match(strip(long), /x{117} {2}7$/);
});

test('ASS-526 AC5: switching projects shows that project\'s control\'s counter', () => {
  const s = counted({ p: 12, q: 34 });
  assert.match(strip(corner(s)), / 12$/);
  assert.match(strip(corner({ ...s, project: 1 })), / 34$/);
});

test('ASS-526 AC3, AC4: each count read replaces the last; a control down keeps its last value (its file is left), and a restarted one shows its 0', () => {
  let s = controlStarted(counted({ p: 98 }), 'p', { pid: 100, startTime: new Date(T0) });
  s = loopCountsRead(s, { p: 99 });
  assert.match(strip(corner(s)), / 99$/);
  s = loopCountsRead(s, { p: 100 });
  assert.match(strip(corner(s)), / 0$/);
  s = loopCountsRead(s, { p: 101 });
  s = controlExited(s, 'p', 70, 0, T0);
  assert.equal(loopCountsRead(s, { p: 101 }), s);   // nothing changed: the very same state
  assert.equal(loopCountsRead(s, {}), s);           // no file read: the last value kept
  assert.match(strip(corner(s)), / 1$/);
  s = loopCountsRead(s, { p: 0 });                   // started again: it wrote 0
  assert.match(strip(corner(s)), / 0$/);
});

test('ASS-526 AC3, AC5: loadLoopCounts reads each project\'s loop-count.json, again once it changes; a project without one is left out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-counts-'));
  for (const id of ['p', 'q', 'r']) mkdirSync(join(dir, id));
  writeFileSync(join(dir, 'p', 'loop-count.json'), JSON.stringify({ 'control-pid': 1, started: 'S', loops: 5 }));
  writeFileSync(join(dir, 'q', 'loop-count.json'), JSON.stringify({ 'control-pid': 2, started: 'S', loops: 123 }));
  writeFileSync(join(dir, 'r', 'loop-count.json'), '{ half');
  assert.deepEqual(loadLoopCounts(dir, ['p', 'q', 'r', 'missing']), { p: 5, q: 123 });
  writeFileSync(join(dir, 'p', 'loop-count.json'), JSON.stringify({ 'control-pid': 1, started: 'S', loops: 60 }));
  assert.equal(loadLoopCounts(dir, ['p']).p, 60);
});
