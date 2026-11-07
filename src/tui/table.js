// A boxed table exactly `columns` wide: header cells divided, body rows not.
import { visible, pad, clip, wrapLine } from './text.js';

// The lines a row takes: its tallest cell.
const rowHeight = row => Math.max(1, ...row.map(cell => [cell].flat().length));

// A scrollbar thumb for `shown` lines of `total`, scrolled `start` of at most
// `last`: [its first line, its length]. Its length is the share of the lines
// on show; it reaches the bottom at the last scroll position.
export function thumb(shown, total, start, last) {
  const size = Math.max(1, Math.round((shown * shown) / total));
  return [Math.round(((shown - size) * start) / last), size];
}

// scrollBox(lines, { width, height, scroll, wrap }) — `lines` boxed in exactly
// `width` × `height`, from row `scroll` (no further than scrollLast); when they
// do not all fit, the right border carries a scrollbar thumb whose size and
// place count rows. Without `wrap` each line is one row, cut with an ellipsis
// when it is wider than the box. With `wrap` — every AI chat's log (ASS-63) —
// a wider line goes on over as many rows as it needs (wrapLine: broken at
// spaces, hung under its lead-in, colors and links kept whole), while a line
// that fits, and a blank one, is drawn exactly as without it.
export function scrollBox(lines, { width, height, scroll, wrap = false }) {
  const inner = Math.max(0, height - 2), text = width - 4;
  const rows = boxRows(lines, { width, wrap });
  const last = Math.max(0, rows.length - inner);
  const start = Math.min(scroll, last);
  const body = Array.from({ length: inner }, (_, i) => {
    const line = rows[start + i] ?? '';
    return `│ ${pad(visible(line) <= text ? line : `${clip(line, text - 1)}…`, text)} │`;
  });
  if (last > 0 && inner) {
    const [top, size] = thumb(inner, rows.length, start, last);
    for (let i = top; i < top + size; i++) body[i] = `${body[i].slice(0, -1)}█`;
  }
  return [`┌${'─'.repeat(width - 2)}┐`, ...body, `└${'─'.repeat(width - 2)}┘`];
}

// boxRows(lines, { width, wrap }) — the rows a scrollBox `width` wide lays
// `lines` on: the lines themselves, or with `wrap` each wrapped to its text width.
export const boxRows = (lines, { width, wrap = false }) => (wrap ? lines.flatMap(line => wrapLine(line, width - 4)) : lines);

// scrollLast(lines, { width, height, wrap }) — the furthest a scrollBox of
// `lines` scrolls, in rows: the one from which its last rows fill it. What a
// caller clamps ↑/↓ to, so none counts lines itself.
export const scrollLast = (lines, { width, height, wrap = false }) => Math.max(0, boxRows(lines, { width, wrap }).length - Math.max(0, height - 2));

// lastStart(rows, bodyHeight) — the furthest a table can scroll: the first row
// from which every later row, blank lines between them included, still fits.
export function lastStart(rows, bodyHeight) {
  let start = rows.length, used = -1;
  while (start > 0 && (used += rowHeight(rows[start - 1]) + 1) <= bodyHeight) start--;
  return Math.min(start, Math.max(0, rows.length - 1));
}

// boxTable(headers, rows, { columns, stretch, min, shrink, height, scroll, selected, dashed }) — each row is an
// array of cells; a cell is a string, or an array of strings stacked on extra
// lines. Rows are separated by a blank line, or with `dashed` (ASS-243) a dim
// gray line of dashes every four columns, indented — the same one line. Column `stretch` takes the leftover
// width, its text cut with an ellipsis.
// `min` is the stretch column's minimum width and `shrink` the columns that
// give up width (in order, never below their own header) to reach it; when
// they cannot, the stretch column keeps `min` and the table runs wider than
// `columns`, as it already may when too narrow.
// With `height`, the table is at most that many lines: the body starts at row
// `scroll` (no further than lastStart), lines that do not fit are left out, and
// when rows are hidden the right border carries a scrollbar thumb. Row
// `selected` is shown in reverse video.
export function boxTable(headers, rows, { columns, stretch, min = 0, shrink = [], height = Infinity, scroll = 0, selected, dashed = false }) {
  const bodyHeight = Math.max(0, height - 4);
  const last = lastStart(rows, bodyHeight);
  const start = Math.min(scroll, last);
  const cells = rows.map(row => headers.map((_, i) => [row[i] ?? ''].flat()));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map(r => Math.max(...r[i].map(visible)))));
  let free = columns - widths.reduce((sum, w, i) => (i === stretch ? sum : sum + w + 3), 0) - 4;
  for (const i of shrink) {
    if (free >= min) break;
    const give = Math.min(widths[i] - headers[i].length, min - free);
    widths[i] -= give;
    free += give;
  }
  widths[stretch] = Math.max(headers[stretch].length, min, free);

  const fit = (text, w) => (visible(text) <= w ? text : `${clip(text, w - 1)}…`);
  const line = (texts, divider) => `│${texts.map((t, i) => ` ${pad(fit(t, widths[i]), widths[i])} `).join(divider)}│`;
  const rule = (left, divider, right) => left + widths.map(w => '─'.repeat(w + 2)).join(divider) + right;
  const center = (text, w) => ' '.repeat(Math.floor((w - text.length) / 2)) + text;
  // A blank (or dashed) line before every row but the first keeps stacked cells apart.
  // Reverse video between the borders, turned back on after each color reset.
  const highlight = text => `│\x1b[7m${text.slice(1, -1).replaceAll('\x1b[0m', '\x1b[0m\x1b[7m')}\x1b[0m│`;
  const inner = widths.reduce((sum, w) => sum + w + 3, -1);
  const separator = dashed ? `│\x1b[90m${pad('   -'.repeat(Math.floor((inner - 1) / 4)), inner)}\x1b[0m│` : line(headers.map(() => ''), ' ');
  const body = cells.slice(start).flatMap((r, n) => Array.from(
    { length: Math.max(...r.map(c => c.length)) + (n ? 1 : 0) },
    (_, k) => {
      if (n && !k) return separator;
      const text = line(r.map(c => c[k - (n ? 1 : 0)] ?? ''), ' ');
      return start + n === selected ? highlight(text) : text;
    },
  )).slice(0, bodyHeight);
  if (last > 0 && body.length) {
    // Keep the height steady when the last rows leave room to spare.
    while (body.length < bodyHeight) body.push(line(headers.map(() => ''), ' '));
    const [top, size] = thumb(body.length, rows.reduce((sum, row) => sum + rowHeight(row) + 1, -1), start, last);
    for (let i = top; i < top + size; i++) body[i] = `${body[i].slice(0, -1)}█`;
  }
  return [rule('┌', '┬', '┐'), line(headers.map((h, i) => center(h, widths[i])), '│'), rule('├', '┴', '┤'), ...body, rule('└', '─', '┘')];
}
