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

// tableLayout(headers, rows, { columns, stretch, min, shrink }) — { widths,
// cells }: each column's width and each row's cells as arrays of lines. A cell
// is a string, an array of strings stacked on extra lines, or (ASS-326) a
// function of its column's width returning its lines — text that wraps rather
// than clips (the sprint grid's Status): called with Infinity for the width it
// asks for, then again at the width its column ends up with. Every row counts,
// scrolled out of view or not, so columns hold still while scrolling.
// Column `stretch` takes the leftover width. `min` is its minimum width and
// `shrink` the columns that give up width (in order, never below their own
// header) to reach it; when they cannot, the stretch column keeps `min` and
// the table runs wider than `columns`, as it already may when too narrow. A
// caller measuring rows (lastStart) measures these cells: a function cell's
// height is known only once its width is.
export function tableLayout(headers, rows, { columns, stretch, min = 0, shrink = [] }) {
  const lay = (cell, w) => [typeof cell === 'function' ? cell(w) : cell ?? ''].flat();
  const natural = rows.map(row => headers.map((_, i) => lay(row[i], Infinity)));
  const widths = headers.map((h, i) => Math.max(h.length, ...natural.map(r => Math.max(...r[i].map(visible)))));
  let free = columns - widths.reduce((sum, w, i) => (i === stretch ? sum : sum + w + 3), 0) - 4;
  for (const i of shrink) {
    if (free >= min) break;
    const give = Math.min(widths[i] - headers[i].length, min - free);
    widths[i] -= give;
    free += give;
  }
  widths[stretch] = Math.max(headers[stretch].length, min, free);
  const cells = rows.map((row, r) => headers.map((_, i) => (typeof row[i] === 'function' ? lay(row[i], widths[i]) : natural[r][i])));
  return { widths, cells };
}

// boxTable(headers, rows, { columns, stretch, min, shrink, height, scroll, selected, dashed, separators }) — each row is an
// array of cells, laid out by tableLayout (its widths, `stretch`, `min` and
// `shrink`). Rows are separated by a blank line, or with `dashed` (ASS-243) a dim
// gray line of dashes every four columns, indented — the same one line. A line
// wider than its column is cut with an ellipsis.
// With `height`, the table is at most that many lines: the body starts at row
// `scroll` (no further than lastStart), lines that do not fit are left out, and
// when rows are hidden the right border carries a scrollbar thumb. Row
// `selected` is shown in reverse video.
// With `separators` (ASS-358), a function of a row's index, the line before
// row i (never the first) is restyled where it returns { color, text }: a
// solid line like the inner border (├─┤, as wide) in `color` (an SGR code, '32' green),
// `text`, if any, centred in it and cut to fit — still one line, so the
// height, scroll and selection maths are unchanged. null keeps the usual line.
export function boxTable(headers, rows, { columns, stretch, min = 0, shrink = [], height = Infinity, scroll = 0, selected, dashed = false, separators = () => null }) {
  const bodyHeight = Math.max(0, height - 4);
  const { widths, cells } = tableLayout(headers, rows, { columns, stretch, min, shrink });
  const last = lastStart(cells, bodyHeight);
  const start = Math.min(scroll, last);

  const fit = (text, w) => (visible(text) <= w ? text : `${clip(text, w - 1)}…`);
  const line = (texts, divider) => `│${texts.map((t, i) => ` ${pad(fit(t, widths[i]), widths[i])} `).join(divider)}│`;
  const rule = (left, divider, right) => left + widths.map(w => '─'.repeat(w + 2)).join(divider) + right;
  const center = (text, w) => ' '.repeat(Math.floor((w - text.length) / 2)) + text;
  // A blank (or dashed) line before every row but the first keeps stacked cells apart.
  // Reverse video between the borders, turned back on after each color reset.
  const highlight = text => `│\x1b[7m${text.slice(1, -1).replaceAll('\x1b[0m', '\x1b[0m\x1b[7m')}\x1b[0m│`;
  const inner = widths.reduce((sum, w) => sum + w + 3, -1);
  const separator = dashed ? `│\x1b[90m${pad('   -'.repeat(Math.floor((inner - 1) / 4)), inner)}\x1b[0m│` : line(headers.map(() => ''), ' ');
  const solid = ({ color, text = '' }) => {
    const label = text && inner > 2 ? ` ${fit(text, inner - 2)} ` : '';
    const left = Math.floor((inner - visible(label)) / 2);
    return `├\x1b[${color}m${'─'.repeat(left)}${label}${'─'.repeat(inner - left - visible(label))}\x1b[0m┤`;
  };
  const before = i => { const style = separators(i); return style ? solid(style) : separator; };
  const body = cells.slice(start).flatMap((r, n) => Array.from(
    { length: Math.max(...r.map(c => c.length)) + (n ? 1 : 0) },
    (_, k) => {
      if (n && !k) return before(start + n);
      const text = line(r.map(c => c[k - (n ? 1 : 0)] ?? ''), ' ');
      return start + n === selected ? highlight(text) : text;
    },
  )).slice(0, bodyHeight);
  if (last > 0 && body.length) {
    // Keep the height steady when the last rows leave room to spare.
    while (body.length < bodyHeight) body.push(line(headers.map(() => ''), ' '));
    const [top, size] = thumb(body.length, cells.reduce((sum, row) => sum + rowHeight(row) + 1, -1), start, last);
    for (let i = top; i < top + size; i++) body[i] = `${body[i].slice(0, -1)}█`;
  }
  return [rule('┌', '┬', '┐'), line(headers.map((h, i) => center(h, widths[i])), '│'), rule('├', '┴', '┤'), ...body, rule('└', '─', '┘')];
}
