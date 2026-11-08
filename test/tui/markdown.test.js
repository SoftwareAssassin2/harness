// ASS-300 AC2: markdown() unit tests — the Claude-Code markdown subset.
// Written first (AC6): src/tui/markdown.js does not exist yet, so these run and
// fail red until the renderer lands. Loaded through a guarded dynamic import so
// a missing file does not abort the file — each test fails on its own call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visible } from '../../src/tui/text.js';

let markdown;
try { ({ markdown } = await import('../../src/tui/markdown.js')); }
catch { markdown = () => { throw new Error('src/tui/markdown.js not built yet'); }; }

const BOLD = '\x1b[1m', ITALIC = '\x1b[3m', CODE = '\x1b[94m', DIM = '\x1b[2m';
const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
// markdown takes the message's lines and a width, returns fitted rows.
const md = (text, width = 80) => markdown(text.split('\n'), width);
const rows = (text, width) => md(text, width).map(strip);

test('ASS-300 AC2: **bold** becomes an SGR 1 run; an unclosed ** is left literal', () => {
  const r = md('a **bold** b')[0];
  assert.ok(r.includes(BOLD), r);
  assert.equal(strip(r), 'a bold b');
  assert.equal(strip(md('a **bold b')[0]), 'a **bold b');
});

test('ASS-300 AC2: *italic* and _italic_ become SGR 3; an unclosed marker is left literal', () => {
  assert.ok(md('x *it* y')[0].includes(ITALIC));
  assert.ok(md('x _it_ y')[0].includes(ITALIC));
  assert.equal(strip(md('x *it* y')[0]), 'x it y');
  assert.equal(strip(md('x *it y')[0]), 'x *it y');
});

test('ASS-300 AC2: `inline code` becomes bright-blue (SGR 94)', () => {
  const r = md('run `npm test` now')[0];
  assert.ok(r.includes(CODE), r);
  assert.equal(strip(r), 'run npm test now');
});

test('ASS-300 AC2: # … ###### headings are bold lines with the "#" stripped', () => {
  for (let n = 1; n <= 6; n++) {
    const r = md(`${'#'.repeat(n)} Heading`)[0];
    assert.ok(r.includes(BOLD), `h${n} bold`);
    assert.equal(strip(r), 'Heading', `h${n} strips the #`);
  }
});

test('ASS-300 AC2: -, *, + bullets and 1. numbered lists keep the marker and hang the text under its first column on wrap', () => {
  for (const marker of ['-', '*', '+']) {
    assert.equal(strip(md(`${marker} item`)[0]), `${marker} item`);
  }
  assert.equal(strip(md('1. first')[0]), '1. first');
  // width 14: "  - long item wraps" hangs continuation at column 4 (under the text)
  const wrapped = rows('  - long item wraps', 14);
  assert.ok(wrapped.length > 1, wrapped.join('|'));
  assert.ok(wrapped.slice(1).every(r => r.startsWith('    ')), `hang at 4: ${JSON.stringify(wrapped)}`);
  for (const r of md('  - long item wraps', 14)) assert.ok(visible(r) <= 14, r);
});

test('ASS-300 AC2: a block quote is a dim "▎ " bar, its hang kept across a wrap', () => {
  const out = md('> quoted text that is long enough to wrap at a narrow width', 16);
  assert.ok(out[0].includes(DIM), out[0]);
  assert.ok(strip(out[0]).startsWith('▎ '), strip(out[0]));
  assert.ok(out.slice(1).every(r => strip(r).startsWith('  ')), `hang kept: ${out.map(strip).join('|')}`);
  for (const r of out) assert.ok(visible(r) <= 16, r);
});

test('ASS-300 AC2: a fenced block is indented 2, not inline-parsed, its language dropped, set apart by a blank row', () => {
  const out = md('text\n```js\nconst x = **not bold**\n```\nmore');
  const txt = out.map(strip);
  const code = txt.find(r => r.includes('const x'));
  assert.ok(code.startsWith('  const x = **not bold**'), `indented 2, literal inside: ${JSON.stringify(code)}`);
  assert.ok(!txt.some(r => r.trim() === 'js'), 'the language word is dropped');
  const at = txt.findIndex(r => r.includes('const x'));
  assert.equal(txt[at - 1], '', 'blank row above the block');
});

test('ASS-300 AC2: a table is drawn with box characters, columns sized to content', () => {
  const out = md('| a | bb |\n|---|---|\n| 1 | 2222 |').map(strip);
  assert.ok(out.some(r => /[┌┬┐]/.test(r)), out.join('\n'));
  assert.ok(out.some(r => /[├┼┤]/.test(r)), 'a header separator row');
  assert.ok(out.some(r => /[└┴┘]/.test(r)), 'a bottom border');
  assert.ok(out.some(r => r.includes('2222')), 'cell content present');
});

test('ASS-300 AC2: a table too narrow for its min column width falls back to plain wrapped rows', () => {
  const out = md('| alpha | beta | gamma |\n|---|---|---|\n| one | two | three |', 20).map(strip);
  assert.ok(!out.some(r => /[┌┬┐├┼┤└┴┘]/.test(r)), `no box chars at width 20: ${out.join('\n')}`);
  for (const r of md('| alpha | beta | gamma |\n|---|---|---|\n| one | two | three |', 20)) assert.ok(visible(r) <= 20, r);
});

test('ASS-300 AC2: a wide table wraps its cells in-cell rather than clipping them', () => {
  const text = '| col one | col two | col three |\n|---|---|---|\n' +
    '| a long first cell value | a long second cell value | a long third cell value |';
  const out = md(text, 40);
  for (const r of out) assert.ok(visible(r) <= 40, `${visible(r)} > 40: ${JSON.stringify(strip(r))}`);
  assert.ok(out.some(r => /[┌┬┐]/.test(strip(r))), 'still a box table (cells wrapped, not dropped)');
  // every cell word survives the wrap (nothing clipped away)
  const joined = out.map(strip).join(' ');
  for (const word of ['first', 'second', 'third', 'value']) assert.ok(joined.includes(word), `${word} kept`);
});
