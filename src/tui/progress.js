// The dashboard's progress bar: one run of blocks per workflow state, sized by
// its ticket count, ordered by sequence (Done on the right) and colored by
// stateColor.
import { clip, visible } from './text.js';

// progressBar([{ sequence, count, color?, agents?, scripts?, name?, change? }], { steps, columns }) —
// the box, three lines exactly `columns` wide, then a line of state names. Its
// bottom border carries a robot per agent under each state's run, from where
// it starts, then a computer per variation at a script step (ASS-237); a group
// that would overlap the one before it is pushed right.
// Under the box, each run's name starts where the run does, cut a column short
// of the next run's start, with its change since yesterday's snapshot when it
// has one (ASS-260, see label). `steps` are the engine's top-level steps, which set
// the runs' shades (stateColor).
export function progressBar(segments, { steps, columns }) {
  const inner = columns - 2;
  const filled = segments.filter(s => s.count > 0).toSorted((a, b) => a.sequence - b.sequence);
  const widths = share(filled.map(s => s.count), inner);
  const bar = filled.map((s, i) => `${stateColor(s, steps)}${'█'.repeat(widths[i])}`).join('');
  const empty = inner - widths.reduce((a, b) => a + b, 0);
  let robots = '', start = 0;
  // 🤖 and 💻 are two UTF-16 units and two columns wide, so length counts columns here.
  filled.forEach((s, i) => {
    if (s.agents || s.scripts) robots = robots.padEnd(start) + '🤖'.repeat(s.agents ?? 0) + '💻'.repeat(s.scripts ?? 0);
    start += widths[i];
  });
  const bottom = clip(robots, inner).padEnd(inner).replaceAll(' ', '─');
  let names = '';
  start = 0;
  filled.forEach((s, i) => {
    const room = i < filled.length - 1 ? widths[i] - 1 : widths[i];
    names = names.padEnd(start) + label(s, Math.max(0, room));
    start += widths[i];
  });
  return [`┌${'─'.repeat(inner)}┐`, `│${bar}\x1b[0m${' '.repeat(empty)}│`, `└${bottom}┘`, names && ` ${names}`];
}

// label({ name, change }, room) — a run's name, then its change since
// yesterday's snapshot: "Done +2", "Setup Review -1"; the name alone for no
// change (0) or none known (no earlier snapshot), never "+0". Cut to `room`
// columns, the name first, so the change stays (the name gone, then the change
// cut). Uncolored, as the names are: no red or green (ASS-260).
function label({ name = '', change }, room) {
  if (!change) return clip(name, room);
  const delta = `${change > 0 ? '+' : ''}${change}`;
  if (visible(name) + 1 + delta.length <= room) return `${name} ${delta}`;
  const cut = clip(name, room - delta.length - 1).trimEnd();
  return cut ? `${cut} ${delta}` : clip(delta, room);
}

// share(counts, total) — whole widths in proportion to counts, summing to
// `total`; the leftover columns go to the largest fractions.
function share(counts, total) {
  const sum = counts.reduce((a, b) => a + b, 0);
  if (!sum) return [];
  const exact = counts.map(c => (c / sum) * total);
  const widths = exact.map(Math.floor);
  const leftover = total - widths.reduce((a, b) => a + b, 0);
  exact.map((e, i) => [e - widths[i], i]).sort((a, b) => b[0] - a[0]).slice(0, leftover).forEach(([, i]) => widths[i]++);
  return widths;
}

// Done's green, #3A703A, as [r, g, b].
const DONE = [0x3a, 0x70, 0x3a];

// stateColor({ sequence, color }, steps) — a state's color as a terminal code:
// its own `color` ("#rrggbb") from the state engine when it has one (Blocked,
// Blocked for Human, Self Healing…); else Done's green scaled down, all three
// channels, linearly by sequence from full at Done (the highest sequence in
// `steps`, the engine's top-level steps) to black at the colorless step
// furthest from it. So each step back from Done is darker, channel by channel,
// and the furthest is black — invisible on a black terminal, as the operator
// chose (ASS-48). Paints the progress bar, the ticket table's status squares
// and the flowchart's.
export function stateColor({ sequence, color }, steps) {
  const rgb = color ? [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)) : shade(sequence, steps);
  return `\x1b[38;2;${rgb.join(';')}m`;
}

// Done's green at `sequence`'s place between the furthest colorless step (0)
// and Done (1), clamped.
function shade(sequence, steps) {
  const done = Math.max(...steps.map(s => s.sequence));
  const furthest = Math.min(...steps.filter(s => !s.color).map(s => s.sequence));
  const f = done > furthest ? Math.min(1, Math.max(0, (sequence - furthest) / (done - furthest))) : 1;
  return DONE.map(c => Math.round(c * f));
}
