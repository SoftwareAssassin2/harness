import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxTable, lastStart, scrollBox, scrollLast, boxRows } from '../../src/tui/table.js';
import { visible, link } from '../../src/tui/text.js';

const headers = ['Ticket', 'Points', 'MR'];

test('spans the full width; the stretch column takes the slack', () => {
  const out = boxTable(headers, [['A-1: Title', '3', 'x']], { columns: 40, stretch: 0 });
  for (const line of out) assert.equal(visible(line), 40, line);
  assert.deepEqual(out, [
    '┌────────────────────────┬────────┬────┐',
    '│         Ticket         │ Points │ MR │',
    '├────────────────────────┴────────┴────┤',
    '│ A-1: Title               3        x  │',
    '└──────────────────────────────────────┘',
  ]);
});

test('a stretch cell too long for its column ends in an ellipsis', () => {
  const out = boxTable(headers, [['A-1: A very long ticket title indeed', '3', 'x']], { columns: 30, stretch: 0 });
  assert.equal(out[3], '│ A-1: A very…   3        x  │');
});

test('cutting a linked cell keeps the link whole', () => {
  const out = boxTable(headers, [[link('A-1: A very long ticket title indeed', 'http://t/1'), '3', 'x']], { columns: 30, stretch: 0 });
  assert.equal(out[3], `│ ${link('A-1: A very', 'http://t/1')}…   3        x  │`);
});

test('a cell with several lines adds continuation rows; a blank line separates rows', () => {
  const out = boxTable(headers, [['A-1', '3', ['!1', '!2']], ['A-2', '1', 'x']], { columns: 30, stretch: 0 });
  assert.deepEqual(out.slice(3), [
    '│ A-1            3        !1 │',
    '│                         !2 │',
    '│                            │',
    '│ A-2            1        x  │',
    '└────────────────────────────┘',
  ]);
});

test('when the screen is too narrow the stretch column keeps its header width', () => {
  const out = boxTable(headers, [['A-1', '3', 'x']], { columns: 10, stretch: 0 });
  assert.equal(out[1], '│ Ticket │ Points │ MR │');
});

// ASS-207: `min` is the stretch column's floor and `shrink` the columns that
// give up width, in order, to reach it — never below their own header.
test('ASS-207 AC1: with room to spare, min and shrink leave the widths as they are', () => {
  const row = [['A-1: Title', '3', 'x']];
  const out = boxTable(headers, row, { columns: 120, stretch: 0, min: 10, shrink: [1] });
  assert.deepEqual(out, boxTable(headers, row, { columns: 120, stretch: 0 }));        // nothing to give up: today's widths
  for (const line of out) assert.equal(visible(line), 120, line);
  assert.ok(out[1].endsWith('│ Points │ MR │'), out[1]);                              // both shrink columns natural
  assert.match(out[3], /^│ A-1: Title {95}3 {8}x {2}│$/);                             // the stretch column took the leftover
});

test('ASS-207 AC1: a shrink column gives up width so the stretch column reaches min', () => {
  const out = boxTable(headers, [['A-1: A very long ticket title indeed', 'Rewriting the loop', 'x']], { columns: 40, stretch: 0, min: 20, shrink: [1] });
  for (const line of out) assert.equal(visible(line), 40, line);
  assert.deepEqual(out, [
    '┌──────────────────────┬──────────┬────┐',
    '│        Ticket        │  Points  │ MR │',
    '├──────────────────────┴──────────┴────┤',
    '│ A-1: A very long ti…   Rewriti…   x  │',
    '└──────────────────────────────────────┘',
  ]);
});

test('ASS-207 AC2: the shrink columns give way in order, the later ones only when the earlier are not enough', () => {
  const out = boxTable(headers, [['A-1: A very long ticket title indeed', 'Rewriting the loop', 'on the grid']], { columns: 40, stretch: 0, min: 10, shrink: [1, 2] });
  for (const line of out) assert.equal(visible(line), 40, line);
  assert.equal(out[3], '│ A-1: A ve…   Rewritin…   on the grid │');     // only Points shrank; MR kept whole
});

test('ASS-207 AC3: too narrow for min, the shrink columns stop at their headers and the stretch column keeps min', () => {
  const out = boxTable(headers, [['A-1234567', 'three two one', 'ten chars!']], { columns: 20, stretch: 0, min: 15, shrink: [1, 2] });
  for (const line of out) assert.equal(visible(line), 33, line);        // wider than the screen, for render to clip
  assert.equal(out[1], '│     Ticket      │ Points │ MR │');
  assert.equal(out[3], '│ A-1234567         three…   t… │');
});

test('height caps the whole table, keeping the bottom border', () => {
  const rows = ['A-1', 'A-2', 'A-3', 'A-4'].map(key => [key, '1', 'x']);
  const out = boxTable(headers, rows, { columns: 30, stretch: 0, height: 8 });
  assert.equal(out.length, 8);
  assert.deepEqual(out.slice(3), [
    '│ A-1            1        x  █',
    '│                            █',
    '│ A-2            1        x  │',
    '│                            │',
    '└────────────────────────────┘',
  ]);
  assert.equal(boxTable(headers, rows.slice(0, 1), { columns: 30, stretch: 0, height: 8 }).length, 5);
  assert.equal(boxTable(headers, rows, { columns: 30, stretch: 0, height: 3 }).length, 4);  // too short for any body
});

const five = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5'].map(key => [key, '1', 'x']);
const keys = out => out.map(l => l.match(/A-\d/)?.[0]).filter(Boolean);
const bar = out => out.slice(3, -1).map(l => l.at(-1)).join('');

test('lastStart is the first row that still lets the last row show in full', () => {
  assert.equal(lastStart(five, 9), 0);                      // 5 rows + 4 blanks fit
  assert.equal(lastStart(five, 5), 2);                      // A-3, A-4, A-5 + 2 blanks
  assert.equal(lastStart(five, 6), 2);
  assert.equal(lastStart([['a', ['1', '2', '3']], ['b', '1']], 3), 1);
  assert.equal(lastStart(five, 0), 4);                      // nothing fits: the last row
  assert.equal(lastStart([], 5), 0);
});

test('scroll starts the body at that row, with no blank line above it', () => {
  const out = boxTable(headers, five, { columns: 30, stretch: 0, height: 9, scroll: 1 });
  assert.deepEqual(keys(out), ['A-2', 'A-3', 'A-4']);
  assert.match(out[3], /A-2/);
});

test('scroll past the end stops where the last row shows in full', () => {
  assert.deepEqual(keys(boxTable(headers, five, { columns: 30, stretch: 0, height: 9, scroll: 99 })), ['A-3', 'A-4', 'A-5']);
});

test('a scrolling table keeps its height at the end, padding with blank lines', () => {
  const out = boxTable(headers, five, { columns: 30, stretch: 0, height: 10, scroll: 99 });
  assert.equal(out.length, 10);
  assert.deepEqual(keys(out), ['A-3', 'A-4', 'A-5']);
  assert.equal(out.at(-2), '│                            █');
});

test('a scrollbar thumb in the right border tracks the scroll; none when everything fits', () => {
  const at = scroll => bar(boxTable(headers, five, { columns: 30, stretch: 0, height: 9, scroll }));
  assert.equal(at(0), '███││');                             // 5 of 9 lines visible: thumb 3 of 5
  assert.equal(at(1), '│███│');
  assert.equal(at(2), '││███');
  assert.equal(bar(boxTable(headers, five, { columns: 30, stretch: 0, height: 13 })), '│││││││││');
  for (const line of boxTable(headers, five, { columns: 30, stretch: 0, height: 9, scroll: 1 })) assert.equal(visible(line), 30);
});

test('the selected row is shown in reverse video inside the borders, kept on after color resets', () => {
  const rows = [['A-1', '1', ['x', 'y']], ['A-2', '1', '\x1b[32mz\x1b[0m']];
  const out = boxTable(headers, rows, { columns: 30, stretch: 0, selected: 1 });
  assert.equal(out[3], '│ A-1            1        x  │');
  assert.equal(out[6], '│\x1b[7m A-2            1        \x1b[32mz\x1b[0m\x1b[7m  \x1b[0m│');
  const first = boxTable(headers, rows, { columns: 30, stretch: 0, selected: 0 });
  assert.ok(first[3].startsWith('│\x1b[7m') && first[4].startsWith('│\x1b[7m') && !first[5].includes('\x1b[7m'));
  for (const line of out) assert.equal(visible(line), 30);
});

test('links count only their visible text', () => {
  const out = boxTable(headers, [['A-1', '3', link('!1', 'http://x/1')]], { columns: 30, stretch: 0 });
  assert.equal(visible(out[3]), 30);
  assert.match(out[3], /\x1b\]8;;http:\/\/x\/1\x1b\\!1\x1b\]8;;\x1b\\ │$/);
});

test('scrollBox boxes lines in exactly width × height, cut with an ellipsis; a thumb in its right border tracks the scroll', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  const box = scroll => scrollBox(lines, { width: 12, height: 7, scroll });
  for (const line of box(0)) assert.equal(visible(line), 12, line);
  assert.deepEqual(box(0), [
    '┌──────────┐',
    '│ line 0   █',
    '│ line 1   █',
    '│ line 2   █',
    '│ line 3   │',
    '│ line 4   │',
    '└──────────┘',
  ]);                                                                // 5 of 10 lines shown: thumb 3 of 5 (as boxTable rounds it)
  assert.deepEqual(box(5).slice(1, 6).map(l => l.at(-1)), ['│', '│', '█', '█', '█']);   // at the bottom
  assert.equal(box(99)[5], '│ line 9   █');                          // no further than the last line
  assert.equal(scrollBox(['a much longer line'], { width: 12, height: 3, scroll: 0 })[1], '│ a much … │');
  assert.deepEqual(scrollBox(['a', 'b'], { width: 6, height: 5, scroll: 0 }), ['┌────┐', '│ a  │', '│ b  │', '│    │', '└────┘']);   // all fit: no thumb
});

test('scrollBox with wrap lays a wider line on as many rows as it needs, no ellipsis; a line that fits and a blank line are drawn as without it', () => {
  assert.deepEqual(scrollBox(['> a much longer line', '', 'fits'], { width: 12, height: 7, scroll: 0, wrap: true }), [
    '┌──────────┐',
    '│ > a much │',
    '│   longer │',
    '│   line   │',
    '│          │',
    '│ fits     │',
    '└──────────┘',
  ]);
  const fits = ['short', '', 'lines'];
  assert.deepEqual(scrollBox(fits, { width: 12, height: 5, scroll: 0, wrap: true }), scrollBox(fits, { width: 12, height: 5, scroll: 0 }));
});

test('a wrapping scrollBox scrolls and sizes its thumb over rows, and scrollLast is the furthest it scrolls', () => {
  const lines = ['aaaa bbbb cccc dddd', 'eeee'];                         // 4 rows and 1 at text width 8
  const opts = { width: 12, height: 4, wrap: true };
  assert.deepEqual(boxRows(lines, opts), ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee']);
  assert.equal(scrollLast(lines, opts), 3);                              // 5 rows, 2 shown
  assert.equal(scrollLast(lines, { width: 12, height: 4 }), 0);          // unwrapped: 2 lines, 2 shown
  assert.deepEqual(scrollBox(lines, { ...opts, scroll: Infinity }).slice(1, 3), ['│ dddd     │', '│ eeee     █']);   // follows the last rows
  assert.deepEqual(scrollBox(lines, { ...opts, scroll: 1 }).slice(1, 3), ['│ bbbb     █', '│ cccc     │']);
  assert.deepEqual(scrollBox(lines, { ...opts, scroll: 0 }).slice(1, 3).map(l => l.at(-1)), ['█', '│']);   // 2 of 5 rows: a one-row thumb
});

// ASS-243: a dim gray dashed line in place of the blank between rows, as many lines.
const DASHES = '│\x1b[90m   -   -   -   -   -   -    \x1b[0m│';

test('ASS-243 AC1: dashed puts a dim gray dashed line between rows, indented, inside the borders; none after the last row', () => {
  const rows = [['A-1', '1', ['x', 'y']], ['A-2', '1', 'z']];
  const out = boxTable(headers, rows, { columns: 30, stretch: 0, dashed: true });
  assert.deepEqual(out.slice(3), [
    '│ A-1            1        x  │',
    '│                         y  │',
    DASHES,
    '│ A-2            1        z  │',
    '└────────────────────────────┘',
  ]);
  for (const line of out) assert.equal(visible(line), 30);
  assert.equal(boxTable(headers, rows, { columns: 30, stretch: 0 })[5], '│                            │');   // undashed: blank as before
});

test('ASS-243 AC2: a dashed table takes the same lines, scrolls and selects as a blank-separated one', () => {
  for (const options of [{ height: 9, scroll: 1 }, { height: 9, scroll: 99 }, { height: 10, scroll: 99 }, { height: 13 }, { selected: 2 }]) {
    const plain = boxTable(headers, five, { columns: 30, stretch: 0, ...options });
    const dashed = boxTable(headers, five, { columns: 30, stretch: 0, ...options, dashed: true });
    assert.equal(dashed.length, plain.length);
    assert.deepEqual(keys(dashed), keys(plain));
    assert.equal(bar(dashed), bar(plain));
  }
  const scrolled = boxTable(headers, five, { columns: 30, stretch: 0, height: 9, scroll: 1, dashed: true });
  assert.match(scrolled[3], /A-2/);                                                   // no dashes above the first row shown
  assert.equal(scrolled[4], '│\x1b[90m   -   -   -   -   -   -    \x1b[0m█');          // the thumb still takes the border
  const selected = boxTable(headers, five, { columns: 30, stretch: 0, selected: 1, dashed: true });
  assert.equal(selected[4], DASHES);                                                  // the dashes are not reversed
  assert.ok(selected[5].includes('\x1b[7m'));
});

// ASS-358: separators restyles chosen lines between rows: solid, colored, a centred label.
const SOLID_GREEN = `├\x1b[32m${'─'.repeat(28)}\x1b[0m┤`;
const LABEL = 'planning ↓ · ↑ in progress';
const stripped = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('ASS-358: separators draws a solid colored line before the rows it names, as wide as the inner border; null keeps the dashes', () => {
  const out = boxTable(headers, five, { columns: 30, stretch: 0, dashed: true, separators: i => (i === 2 ? { color: '32' } : null) });
  assert.equal(out[4], DASHES);
  assert.equal(out[6], SOLID_GREEN);
  assert.equal(out[8], DASHES);
  assert.equal(stripped(out[6]).length, stripped(out[2]).length);                  // the inner border's width
  for (const line of out) assert.equal(visible(line), 30);
  const blank = boxTable(headers, five, { columns: 30, stretch: 0, separators: () => null });
  assert.deepEqual(blank, boxTable(headers, five, { columns: 30, stretch: 0 }));   // no style: as before
  assert.equal(boxTable(headers, five, { columns: 30, stretch: 0, separators: () => ({ color: '32' }) })[3], '│ A-1            1        x  │');   // never above the first row
});

test('ASS-358: a separator\'s text is centred in its line, in its color; cut to fit a narrow table', () => {
  const wide = boxTable(headers, five, { columns: 40, stretch: 0, dashed: true, separators: i => (i === 1 ? { color: '34', text: LABEL } : null) });
  assert.equal(wide[4], `├\x1b[34m───── ${LABEL} ─────\x1b[0m┤`);
  const text = stripped(wide[4]).slice(1, -1);
  const [left, right] = text.split(` ${LABEL} `);
  assert.ok(Math.abs(left.length - right.length) <= 1 && /^─+$/.test(left + right), text);
  assert.equal(visible(wide[4]), 40);
  for (const columns of [30, 20, 12, 8]) {
    const out = boxTable(['A'], [['x'], ['y']], { columns, stretch: 0, dashed: true, separators: () => ({ color: '34', text: LABEL }) });
    assert.equal(out.length, 7, String(columns));                                 // one line, still
    assert.equal(visible(out[4]), columns, out[4]);
    assert.match(out[4], /^├\x1b\[34m.*\x1b\[0m┤$/);
    assert.match(stripped(out[4]), columns >= 30 ? new RegExp(LABEL) : /^├ pla[^─]*… ┤$/);
  }
});

test('ASS-358: a restyled table takes the same lines, scrolls and selects as a dashed one; the solid line is never reversed and carries the thumb', () => {
  const styled = i => (i === 1 ? { color: '32' } : i === 3 ? { color: '34', text: LABEL } : null);
  for (const options of [{ height: 9, scroll: 1 }, { height: 9, scroll: 99 }, { height: 10, scroll: 99 }, { height: 13 }, { selected: 1 }, { selected: 3 }]) {
    const dashed = boxTable(headers, five, { columns: 30, stretch: 0, ...options, dashed: true });
    const solid = boxTable(headers, five, { columns: 30, stretch: 0, ...options, dashed: true, separators: styled });
    assert.equal(solid.length, dashed.length);
    assert.deepEqual(keys(solid), keys(dashed));
    assert.equal(bar(solid).replaceAll('┤', '│'), bar(dashed));
    assert.deepEqual(solid.filter(l => l.includes('\x1b[7m')), dashed.filter(l => l.includes('\x1b[7m')));
  }
  const scrolled = boxTable(headers, five, { columns: 30, stretch: 0, height: 9, scroll: 1, dashed: true, separators: i => (i <= 2 ? { color: '32' } : null) });
  assert.match(scrolled[3], /A-2/);                                               // the line above the first row shown is not drawn
  assert.equal(scrolled[4], `├\x1b[32m${'─'.repeat(28)}\x1b[0m█`);                 // the thumb takes its border
});
