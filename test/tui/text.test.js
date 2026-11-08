import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visible, clip, pad, link, markWords, wrapLine } from '../../src/tui/text.js';
const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');

test('emoji take two columns; colors and links take none', () => {
  assert.equal(visible('✨ a'), 4);
  assert.equal(visible('🐛 a'), 4);
  assert.equal(visible(`\x1b[31m${link('ab', 'http://x')}\x1b[0m`), 2);
});

test('ASS-86 AC5: a linked key — an off-board ticket\'s file:// url too — counts as its text alone in visible, clip and pad', () => {
  const key = link('ASS-86', 'file:///Volumes/src/my%20harness/src/off-board/harness/ASS-86.md');
  assert.equal(visible(key), 6);
  assert.equal(visible(pad(key, 10)), 10);
  assert.equal(pad(key, 10), `${key}    `);
  assert.equal(clip(`${key} more`, 6), `${key}`);
  assert.equal(visible(clip(`${key} more`, 8)), 8);
});

test('clip counts emoji as two columns and never splits one', () => {
  assert.equal(clip('🔬🔬x', 4), '🔬🔬');
  assert.equal(clip('🔬🔬x', 3), '🔬');
  assert.equal(clip('ab', 5), 'ab');
});

test('markWords puts each word on its color, in black or white, whichever reads, and nothing else changes', () => {
  const marks = [{ word: 'ABC-1262', color: '#ffff00' }, { word: 'ABC-7', color: '#000080' }];
  const yellow = '\x1b[48;2;255;255;0m\x1b[30mABC-1262\x1b[39;49m';
  assert.equal(markWords('see ABC-1262 and ABC-7.A, not ABC-12620 or XABC-7', marks), `see ${yellow} and \x1b[48;2;0;0;128m\x1b[97mABC-7\x1b[39;49m.A, not ABC-12620 or XABC-7`);
  const linked = link('ABC-1262: Title', 'http://t/ABC-1262');
  assert.equal(markWords(linked, marks), link(`${yellow}: Title`, 'http://t/ABC-1262'));   // the link's address is left alone
  assert.equal(visible(markWords(linked, marks)), visible(linked));
  assert.equal(markWords('change/abc-1262', marks), 'change/abc-1262');                    // as written, upper case
  assert.equal(markWords('ABC-1262', []), 'ABC-1262');
  assert.equal(markWords('ABC-1262', [{ word: 'ABC-1262', color: '#00ff00' }]), '\x1b[48;2;0;255;0m\x1b[30mABC-1262\x1b[39;49m');   // black on bright green
  assert.equal(markWords('ABC-1262', [{ word: 'ABC-1262', color: '#ff0000' }]), '\x1b[48;2;255;0;0m\x1b[97mABC-1262\x1b[39;49m');  // white on red
});

test('wrapLine leaves a line that fits as it is, a blank line one row', () => {
  assert.deepEqual(wrapLine('  keeps   its spaces', 20), ['  keeps   its spaces']);
  assert.deepEqual(wrapLine('', 20), ['']);
});

test('wrapLine breaks a wider line at the last space that fits, by display width', () => {
  assert.deepEqual(wrapLine('the quick brown fox jumps', 10), ['the quick', 'brown fox', 'jumps']);
});

test('wrapLine splits a token longer than the width at the width', () => {
  assert.deepEqual(wrapLine('see https://example.com/a/long/path', 10), ['see', 'https://ex', 'ample.com/', 'a/long/pat', 'h']);
});

test('wrapLine counts an emoji as two columns and never cuts one in half', () => {
  assert.deepEqual(wrapLine('abc🔬🔬', 4), ['abc', '🔬🔬']);
  assert.deepEqual(wrapLine('a🔬 b', 2), ['a', '🔬', 'b']);
});

test('wrapLine hangs continuation rows under the line\'s lead-in: > , ▶ , ◀ , (thinking)  or its leading spaces', () => {
  assert.deepEqual(wrapLine('> tell me more please', 12), ['> tell me', '  more', '  please']);
  assert.deepEqual(wrapLine('▶ Bash {"command":"npm test"}', 14), ['▶ Bash', '  {"command":"', '  npm test"}']);
  assert.deepEqual(wrapLine('◀ pass 7 … (3 lines)', 10), ['◀ pass 7 …', '  (3', '  lines)']);
  assert.deepEqual(wrapLine('(thinking) the tests all pass now', 20), ['(thinking) the tests', '           all pass', '           now']);
  assert.deepEqual(wrapLine('    indented output here', 14), ['    indented', '    output', '    here']);
  assert.deepEqual(wrapLine('plain words here', 6), ['plain', 'words', 'here']);   // no lead-in: no indent
});

test('wrapLine drops the indent when it leaves no room to write in', () => {
  assert.deepEqual(wrapLine('(thinking) abcdef', 12), ['(thinking)', 'abcdef']);
});

test('ASS-300 AC6: wrapLine takes an explicit hang width as a third arg, overriding the lead-in guess', () => {
  assert.deepEqual(wrapLine('⏺ hello world foo bar', 10, 2), ['⏺ hello', '  world', '  foo bar']);
  // An SGR-prefixed row where the LEAD_INS guess fails: the explicit hang still indents the continuation at 2.
  const green = '\x1b[32m', reset = '\x1b[0m';
  const rows = wrapLine(`${green}⏺${reset} Read(src/one/two/three)`, 10, 2);
  assert.ok(rows.length > 1, 'the SGR-prefixed row wraps');
  assert.ok(rows.every(r => visible(r) <= 10), rows.map(visible).join(','));
  assert.ok(rows.slice(1).every(r => strip(r).startsWith('  ')), `hang at 2: ${JSON.stringify(rows.map(strip))}`);
});

test('wrapLine wraps a colored or linked line where its visible text says, never splitting a code; each row closes what is open and the next opens it again', () => {
  const red = '\x1b[31m', reset = '\x1b[0m';
  assert.deepEqual(wrapLine(`${red}aaaa bbbb${reset} cc`, 4), [`${red}aaaa${reset}`, `${red}bbbb${reset}`, 'cc']);
  const url = 'http://x/1', open = `\x1b]8;;${url}\x1b\\`, close = '\x1b]8;;\x1b\\';
  assert.deepEqual(wrapLine(`> ${link('see this page', url)}`, 10), [`> ${open}see this${close}`, `  ${open}page${close}`]);
  const rows = wrapLine(`${red}${'x'.repeat(9)}${reset}`, 4);
  assert.deepEqual(rows.map(visible), [4, 4, 1]);
  assert.ok(rows.every(r => !/\x1b(?!\[[0-9;]*m|\]8;;[^\x1b]*\x1b\\)/.test(r)), 'every escape is a whole code');
});
