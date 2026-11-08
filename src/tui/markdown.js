// The markdown subset a chat message is drawn in (ASS-300): what Claude Code
// shows of an agent's reply — **bold**, *italic*, `inline code`, headings,
// bullet and numbered lists, block quotes, fenced code blocks and tables —
// hand-rolled, as the repo takes no dependencies. markdown(lines, width)
// returns rows already fitted to `width` (wrapLine keeps each row's hang), so
// a caller hands them straight to a box that wraps rather than clips.
import { pad, visible, wrap, wrapLine } from './text.js';

const sgr = code => text => `\x1b[${code}m${text}\x1b[0m`;
const BOLD = sgr(1), ITALIC = sgr(3), CODE = sgr(94), DIM = sgr(2);
// A column narrower than this holds no word, so a table that cannot keep every
// column this wide is drawn as its plain lines instead (AC2's narrow fallback).
const MIN_COL = 5;

// inline(text) — the inline markers in one line: code first (so a marker
// inside it stays literal), then bold, then italic. A marker left unclosed, or
// one inside a word (`mcp__server__tool`), is left as it was written.
export const inline = text => text
  .replace(/`([^`]+)`/g, (_, code) => CODE(code))
  .replace(/\*\*(?=\S)(.*?\S)\*\*/g, (_, bold) => BOLD(bold))
  .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, (_, it) => ITALIC(it))
  .replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, (_, it) => ITALIC(it));

const isRow = line => /^\s*\|.*\|\s*$/.test(line ?? '');
const isRule = line => /^\s*\|[\s|:-]+\|\s*$/.test(line ?? '');

// markdown(lines, width) — a message's lines as rows `width` columns wide: each
// block drawn its own way, every row wrapped with the hang its block reads
// under (a list's text column, a quote's bar, a fence's indent). A run of
// blank lines is one blank row, so a block set apart by one of its own does
// not read as a gap.
export function markdown(lines, width = Infinity) {
  const rows = [];
  for (let i = 0; i < (lines ?? []).length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*```/.test(line)) {   // a fenced block: set apart, indented two, left as it was written
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      if (rows.length && rows.at(-1) !== '') rows.push('');
      rows.push(...body.flatMap(l => wrapLine(`  ${l}`, width, 2)), '');
      continue;
    }
    if (isRow(line) && isRule(lines[i + 1])) {
      const block = [line];
      for (i += 2; i < lines.length && isRow(lines[i]); i++) block.push(lines[i]);
      i--;
      rows.push(...table(block, width));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (heading) rows.push(...wrapLine(BOLD(inline(heading[2])), width, 0));
    else if (quote) rows.push(...wrapLine(`${DIM('▎')} ${DIM(inline(quote[1]))}`, width, 2));
    else if (item) {
      const lead = `${item[1]}${item[2]} `;
      rows.push(...wrapLine(`${lead}${inline(item[3])}`, width, visible(lead)));
    } else if (line.trim() || rows.at(-1) !== '') rows.push(...wrapLine(inline(line), width, line.match(/^ */)[0].length));
  }
  return rows;
}

// A table's rows (its header, the | --- | rule dropped, then its body) drawn
// with box characters: each column as wide as its widest cell, the widest
// column shrunk a column at a time until the table fits `width` — and, when
// that would take a column under MIN_COL, the block drawn as plain rows
// instead. A cell too narrow for its text wraps inside its column.
function table(block, width) {
  const cells = block.map(line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()));
  const columns = Math.max(...cells.map(row => row.length));
  const grid = cells.map(row => Array.from({ length: columns }, (_, i) => row[i] ?? ''));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(1, ...grid.map(row => visible(row[i]))));
  const total = () => widths.reduce((sum, w) => sum + w + 2, 0) + columns + 1;
  while (total() > width) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= MIN_COL) return block.flatMap(line => wrapLine(inline(line), width, 0));
    widths[widest]--;
  }
  const rule = (left, join, right) => left + widths.map(w => '─'.repeat(w + 2)).join(join) + right;
  const body = grid.map(row => {
    const parts = row.map((cell, i) => wrap(inline(cell), widths[i]));
    return Array.from({ length: Math.max(...parts.map(p => p.length)) }, (_, k) =>
      `│${parts.map((part, i) => ` ${pad(part[k] ?? '', widths[i])} `).join('│')}│`);
  });
  return [rule('┌', '┬', '┐'), ...body[0], rule('├', '┼', '┤'), ...body.slice(1).flat(), rule('└', '┴', '┘')];
}
