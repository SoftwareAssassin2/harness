// A row of boxes side by side: each as wide as its widest line, all as tall as
// the tallest, four columns apart, the row centered in `columns`.
import { visible, pad, clip } from './text.js';

// boxRow([[line, …], …], columns) — the row's lines, or none without boxes.
export function boxRow(boxes, columns) {
  if (!boxes.length) return [];
  const height = Math.max(...boxes.map(box => box.length));
  const widths = boxes.map(box => Math.max(...box.map(visible)));
  const lines = [
    widths.map(w => `┌${'─'.repeat(w + 2)}┐`),
    ...Array.from({ length: height }, (_, i) => boxes.map((box, n) => `│ ${pad(box[i] ?? '', widths[n])} │`)),
    widths.map(w => `└${'─'.repeat(w + 2)}┘`),
  ].map(parts => parts.join('    '));
  const indent = ' '.repeat(Math.max(0, Math.floor((columns - visible(lines[0])) / 2)));
  return lines.map(line => indent + line);
}

// ASS-572: a card — a box of a fixed `width` (its frame included) with a title in its top border, left, and a status
// at its right end: "┌─ <title> ─────── <status> ─┐". Each line is cut (with an ellipsis) or padded to the inside
// width, so cards of one width line up whatever they hold; the title is cut first, the status kept.
// cardRow(cards, gap) — cards side by side, `gap` columns apart, each padded with blank lines to the tallest.
export function card({ title, status = '', lines = [], width }) {
  const inner = Math.max(1, width - 4);
  const side = status ? visible(status) + 2 : 0;   // "┌─ " + title + " " + ─… + " " + status + " " + "─┐"
  const name = cutTo(title, Math.max(1, width - 7 - side));
  const fill = Math.max(1, width - 6 - visible(name) - side);
  const top = `┌─ ${name} ${'─'.repeat(fill)}${status ? ` ${status} ` : ''}─┐`;
  return [top, ...lines.map(l => `│ ${pad(cutTo(l, inner), inner)} │`), `└${'─'.repeat(width - 2)}┘`];
}
export function cardRow(cards, gap = 2) {
  if (!cards.length) return [];
  const height = Math.max(...cards.map(c => c.length));
  const tall = cards.map(c => { const w = visible(c[0]); return [...c.slice(0, -1), ...Array(height - c.length).fill(`│${' '.repeat(w - 2)}│`), c.at(-1)]; });
  return Array.from({ length: height }, (_, i) => tall.map(c => c[i]).join(' '.repeat(gap)));
}
// cutTo(text, width) — the text cut to `width` columns with an ellipsis, its colors kept (clip).
const cutTo = (text, width) => (visible(text) <= width ? text : `${clip(text, Math.max(0, width - 1))}\x1b[0m…`);
