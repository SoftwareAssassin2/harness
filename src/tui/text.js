// Width-aware text helpers: colors (SGR) and links (OSC 8) take no columns,
// emoji take two.
const CODES = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const TOKENS = new RegExp(`${CODES.source}|.`, 'gu');
const width = char => (char[0] === '\x1b' ? 0 : /\p{Emoji_Presentation}/u.test(char) ? 2 : 1);

export const visible = text => (text.match(TOKENS) ?? []).reduce((sum, t) => sum + width(t), 0);

// clip(line, columns) — cut to `columns` visible columns, keeping codes and
// never splitting an emoji.
export function clip(line, columns) {
  let used = 0;
  return line.replace(TOKENS, t => (width(t) === 0 || (used += width(t)) <= columns ? t : ''));
}

// from(line, column) — the line from `column` visible columns on, keeping
// every code; an emoji cut in half leaves a space in its place.
export function from(line, column) {
  let used = 0;
  return line.replace(TOKENS, t => {
    if (!width(t)) return t;
    used += width(t);
    return used <= column ? '' : used - width(t) < column ? ' ' : t;
  });
}

export const pad = (text, width) => text + ' '.repeat(Math.max(0, width - visible(text)));

// A terminal hyperlink: `text` shown, `url` opened on click.
export const link = (text, url) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

// Words into lines of at most `width` columns; a word longer than that is split.
export function wrap(text, width) {
  const lines = [''];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let rest = word; rest; ) {
      const last = lines.at(-1);
      const room = width - visible(last) - (last ? 1 : 0);
      if (visible(rest) <= room) {
        lines[lines.length - 1] = last ? `${last} ${rest}` : rest;
        rest = '';
      } else if (!last) {
        lines[lines.length - 1] = rest.slice(0, width);
        rest = rest.slice(width);
        if (rest) lines.push('');
      } else lines.push('');
    }
  }
  return lines;
}

// wrapLine(line, columns) — one log line laid into rows of at most `columns`
// columns, for a box that wraps rather than clips (scrollBox's `wrap`). A line
// that fits, a blank line too, is one row exactly as it was: its spaces kept.
// A wider line breaks at the last space that fits, the space dropped; a token
// longer than a row splits at the width, an emoji (two columns) never in half.
// Every row after the first hangs under an indent as wide as the line's
// lead-in — `hang` when the caller names it (ASS-300: a row starting with an
// SGR code, or one whose lead-in is a markdown marker, is no string prefix to
// guess at), else `(thinking) ` (11 columns), `> `, `▶ ` or `◀ ` (2), else its
// leading spaces, else none — so a wrapped entry reads as one; an indent
// leaving under two columns to write in is dropped.
const LEAD_INS = ['(thinking) ', '> ', '▶ ', '◀ '];
const LINK_END = '\x1b]8;;\x1b\\', RESETS = new Set(['\x1b[0m', '\x1b[m']);
export function wrapLine(line, columns, hang = null) {
  if (visible(line) <= columns) return [line];
  const found = hang ?? (LEAD_INS.find(l => line.startsWith(l))?.length ?? line.match(/^ */)[0].length);
  const lead = found + 2 <= columns ? found : 0;
  const indent = Array(lead).fill(' ');
  const rows = [];
  let row = [], used = 0, space = -1;   // space: where in `row` the last space a row may break at stands
  const next = rest => { row = [...indent, ...rest]; used = lead + rest.reduce((sum, t) => sum + width(t), 0); space = -1; };
  for (const t of line.match(TOKENS)) {
    const w = width(t);
    if (w && used + w > columns) {
      if (t === ' ') { rows.push(row); next([]); continue; }
      if (space >= 0) {
        rows.push(row.slice(0, space));
        next(row.slice(space + 1));
      } else if (used > lead) { rows.push(row); next([]); }
    }
    if (t === ' ' && used > lead) space = row.length;   // never inside the lead-in or the indent
    row.push(t);
    used += w;
  }
  rows.push(row);
  // Carry colors and a link over each break: closed at the row's end, opened
  // again after the next row's indent, so nothing bleeds into the border.
  let colors = [], href = '';
  return rows.map((r, i) => {
    const reopen = i ? colors.join('') + href : '';
    for (const t of r) {
      if (t.startsWith('\x1b]8;;')) href = t === LINK_END ? '' : t;
      else if (t[0] === '\x1b') colors = RESETS.has(t) ? [] : [...colors, t];
    }
    const text = r.join('');
    return (i ? text.slice(0, lead) + reopen + text.slice(lead) : text) + (href ? LINK_END : '') + (colors.length ? '\x1b[0m' : '');
  });
}

// markWords(line, marks) — each mark's word (marks: [{ word, color: '#rrggbb' }]),
// wherever it stands whole in the line's visible text, shown on its color in
// black or white, whichever reads better on it. Codes and link addresses are
// left as they are, and nothing changes width. Words match as written.
export function markWords(line, marks) {
  const valid = marks.filter(m => m.word && /^#[0-9a-f]{6}$/i.test(m.color));
  if (!valid.length) return line;
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const words = new RegExp(`(?<![A-Za-z0-9-])(${valid.map(m => escape(m.word)).join('|')})(?![0-9])`, 'g');
  const paint = word => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(valid.find(m => m.word === word).color.slice(i, i + 2), 16));
    const ink = 0.299 * r + 0.587 * g + 0.114 * b > 128 ? 30 : 97;   // black on light, white on dark (YIQ)
    return `\x1b[48;2;${r};${g};${b}m\x1b[${ink}m${word}\x1b[39;49m`;
  };
  // Split on codes, keeping them: odd parts are codes, even parts visible text.
  return line.split(new RegExp(`(${CODES.source})`)).map((part, i) => (i % 2 ? part : part.replace(words, paint))).join('');
}
