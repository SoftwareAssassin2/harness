// The flowchart screen: a state engine drawn as a factory floor. Every step is
// a station on one conveyor that snakes across the floor in sequence order,
// left to right and back, except steps whose area is "quarantine", which sit
// apart below it. Each station lists its tickets beneath it, one a line, each
// with its stats.
import { stateColor } from './progress.js';
import { visible, pad, clip } from './text.js';

const WIDTH = 32;          // a station, borders included
const GAP = 4;             // between stations: a conveyor, or floor
const INNER = WIDTH - 2;
const NAME = INNER - 4;    // "│ █ " … " │"
const TICKET = WIDTH - 3;  // a ticket line, after the belt's lane
// The room for a note under a station, after the belt's lane.
export const NOTE_WIDTH = TICKET;
const LEGEND = '═▶ next station   ↺n back to station n   ↷n ahead to station n   ⟳ repeats   ⊘ can block   ↩ returns where it came from';

// flowchart(steps, { tickets, notes, inside, counts, subflows, columns, legend }) —
// the floor's lines, centered in `columns`. tickets maps step ids to the
// tickets there, as { name, stats }: the name is cut to fit so the stats,
// after it, always show in full. inside maps step ids to lines shown in each
// station's box, under its name. counts maps step ids to the tally in a
// station's top border, in place of its tickets' count. notes, when given,
// maps step ids to lines shown under each station in place of its tickets,
// which its top border still counts. subflows maps the ids of steps running a
// sub-engine to that engine's floor, as these options are (its steps among
// them), drawn as a box in the station's place, titled with its name, holding
// its stations as the floor does — wrapping onto further rows when they do not
// fit beside each other — nested to any depth (ASS-245). Each station's square
// is its color among its floor's steps (stateColor). legend: false leaves out
// the line explaining the exit marks, for a floor with none.
export function flowchart(steps, { columns, legend = true, ...floor }) {
  const { lines, width } = layout(steps, floor, columns);
  const indent = ' '.repeat(Math.max(0, Math.floor((columns - width) / 2)));
  return [...(legend ? [clip(indent + LEGEND, columns), ''] : []), ...lines.map(l => (l ? indent + l : l))];
}

// A floor in `columns`, not centered: its lines and the width they take. The
// stations run in sequence order on one conveyor that snakes left to right
// and back, a row holding as many as fit; a row starts under the station the
// one above it ended at, moved in as far as its first station needs. Steps
// whose area is "quarantine" sit apart below, rows of them left to right.
function layout(steps, { tickets = {}, notes, inside = {}, counts = {}, subflows = {} }, columns) {
  const quarantined = s => s.area === 'quarantine';
  const floor = steps.filter(s => !quarantined(s)).toSorted((a, b) => a.sequence - b.sequence);
  const quarantine = steps.filter(quarantined);
  // A station's box, or its sub-flow's, and the width it takes.
  const station = s => {
    const tag = count(counts[s.id] ?? tickets[s.id]?.length ?? 0);
    const exits = marks(s, floor, steps, quarantined);
    if (!subflows[s.id]) return { s, top: box(s, tag, exits, steps, inside[s.id]), width: WIDTH };
    const sub = layout(subflows[s.id].steps, subflows[s.id], columns - 4);
    const width = Math.min(columns, Math.max(WIDTH, sub.width + 4));
    return { s, top: group(s, tag, exits, steps, inside[s.id], sub.lines, width), width };
  };
  // A station and its tickets, `width` wide. Down the station a row turns
  // at, the belt to the next row runs beside the tickets, in their first columns.
  const lane = turn => (turn ? ' ║ ' : '   ');
  const column = ({ s, top, width }, turn) => [
    ...top,
    ...(notes ? (notes[s.id] ?? []).map(note => ({ name: note })) : tickets[s.id] ?? []).map(({ name, stats }) => {
      const shown = fit(name, width - 3 - (stats ? visible(stats) + 1 : 0));
      return lane(turn) + pad(stats ? `${shown} ${stats}` : shown, width - 3);
    }),
  ];
  // A row's stations side by side from its left edge, each filled down to the
  // tallest; `belt` joins their second lines.
  const side = (row, belt, turnAt) => {
    const placed = row.toSorted((a, b) => a.x - b.x);
    const lists = placed.map(p => column(p, p === turnAt));
    const height = Math.max(...lists.map(c => c.length));
    const lead = ' '.repeat(placed[0].x);
    return Array.from({ length: height }, (_, k) =>
      lead + lists.map((c, i) => c[k] ?? lane(placed[i] === turnAt) + ' '.repeat(placed[i].width - 3)).join(k === 1 ? belt : ' '.repeat(GAP)));
  };
  // The stations into rows, each at its column x. A snaking row starts
  // where the one before it ended and runs right, or — every other row — left;
  // otherwise each row runs right from the left edge.
  const rows = (list, snake) => {
    const out = [];
    for (let i = 0, at = 0; i < list.length;) {
      const back = snake && out.length % 2 === 1;
      const row = [{ ...list[i], x: Math.max(0, Math.min(at, columns - list[i].width)) }];
      for (i++; i < list.length; i++) {
        const last = row.at(-1);
        const x = back ? last.x - GAP - list[i].width : last.x + last.width + GAP;
        if (x < 0 || x + list[i].width > columns) break;
        row.push({ ...list[i], x });
      }
      out.push(row);
      at = snake ? row.at(-1).x : 0;
    }
    return out;
  };
  const lines = [];
  const laid = rows(floor.map(station), true);
  laid.forEach((row, r) => {
    const back = r % 2 === 1;
    const more = r < laid.length - 1;
    const belt = back ? `◀${'═'.repeat(GAP - 1)}` : `${'═'.repeat(GAP - 1)}▶`;
    lines.push(...side(row, belt, more ? row.at(-1) : null));
    if (more) lines.push(`${' '.repeat(row.at(-1).x + 1)}▼`);   // down from the station the row ends at
  });
  const apart = rows(quarantine.map(station), false);
  if (apart.length) lines.push('', 'quarantine', ...apart.flatMap(row => side(row, ' '.repeat(GAP), null)));
  return { lines, width: Math.max(0, ...[...laid, ...apart].flat().map(p => p.x + p.width)) };
}

// column(steps, { current, agents }) — the engine as one column of
// stations, WIDTH wide, top down in sequence order with ▼ between them, the
// station whose id is `current` (one id, or several: each run's) marked
// ◀ now in its top border; quarantined
// steps beneath the rest, as on the floor. agents maps step ids to lines
// shown inside each station, under its name, each cut with … to fit.
export function column(steps, { current, agents = {} }) {
  const quarantined = s => s.area === 'quarantine';
  const floor = steps.filter(s => !quarantined(s)).toSorted((a, b) => a.sequence - b.sequence);
  const at = new Set([current].flat());
  const station = s => box(s, at.has(s.id) ? ' ◀ now ─' : '', marks(s, floor, steps, quarantined), steps, agents[s.id] ?? []);
  const stack = list => list.flatMap((s, i) => [...(i ? [pad(`${' '.repeat(WIDTH / 2 - 1)}▼`, WIDTH)] : []), ...station(s)]);
  const quarantine = steps.filter(quarantined);
  return [...stack(floor), ...(quarantine.length ? ['', pad('quarantine', WIDTH), ...stack(quarantine)] : [])];
}

// The top-border tag for a station's tickets.
const count = n => (n ? ` ${n} ticket${n === 1 ? '' : 's'} ─` : '');

// A station: its number and a tag (its tickets, or where the work is) in the
// top border, a square in its color with its name, then `inside`, more lines
// under the name, each cut with … to fit, and its other exits in the bottom
// border. A switched-off step (is-active false, ASS-192: passed at once) is
// marked off before its tag, every line of it dimmed.
function box(step, tag, exits, steps, inside = []) {
  const number = `─ ${step.sequence} `;
  const [first, second] = wrap(step.name);
  const shown = clip(exits, INNER - 1);
  const room = INNER - 2;
  const off = step['is-active'] === false;
  if (off) tag = ` off ─${tag}`;
  const lines = [
    `┌${number}${'─'.repeat(Math.max(0, INNER - number.length - tag.length))}${tag}┐`,
    `│ ${stateColor(step, steps)}█\x1b[0m ${pad(first, NAME)} │`,
    `│   ${pad(second, NAME)} │`,
    ...inside.map(line => `│ ${pad(fit(line, room), room)} │`),
    `└─${shown}${'─'.repeat(INNER - 1 - visible(shown))}┘`,
  ];
  // Dimmed through its color square's reset.
  return off ? lines.map(l => `${DIM}${l.replaceAll(RESET, RESET + DIM)}${RESET}`) : lines;
}
const DIM = '\x1b[2m', RESET = '\x1b[0m';

// A sub-flow's box (ASS-245), `width` wide: its number, square and name in
// its top border, then its tag (its tickets, at any depth); `inside`, more lines
// under it, as a station's; its sub-engine's floor (`floor`, its lines), each
// line cut to fit; and its exits in the bottom border. Switched off, it is
// marked and dimmed as a station is.
function group(step, tag, exits, steps, inside = [], floor, width) {
  const off = step['is-active'] === false;
  if (off) tag = ` off ─${tag}`;
  const room = width - 4;
  const title = `─ ${step.sequence} ${stateColor(step, steps)}█${RESET} ${fit(step.name, Math.max(1, width - 2 - visible(`─ ${step.sequence} █  `) - visible(tag) - 1))} `;
  const shown = clip(exits, width - 3);
  const lines = [
    `┌${title}${'─'.repeat(Math.max(0, width - 2 - visible(title) - visible(tag)))}${tag}┐`,
    ...[...inside, ...floor].map(line => `│ ${pad(fit(line, room), room)} │`),
    `└─${shown}${'─'.repeat(width - 3 - visible(shown))}┘`,
  ];
  return off ? lines.map(l => `${DIM}${l.replaceAll(RESET, RESET + DIM)}${RESET}`) : lines;
}
// The text in `room` columns: cut with … when it does not fit.
const fit = (text, room) => (visible(text) > room ? `${clip(text, room - 1)}…` : text);

// The name on two lines of NAME columns, words kept whole where they fit; what
// does not fit is cut with an ellipsis.
function wrap(name) {
  const cut = text => (text.length > NAME ? `${text.slice(0, NAME - 1)}…` : text);
  let first = '';
  const words = name.split(' ');
  while (words.length && `${first} ${words[0]}`.trim().length <= NAME) first = `${first} ${words.shift()}`.trim();
  return first ? [first, cut(words.join(' '))] : [cut(name), ''];
}

// A station's exits other than to the next station: ↺n back to station n,
// ↷n ahead to it, ⟳ to itself, ⊘ to a quarantined step, ↩ back where the
// work came from.
function marks(step, floor, steps, quarantined) {
  const next = floor[floor.indexOf(step) + 1]?.id;
  const out = (step['exit-events'] ?? []).map(exit => {
    if (exit['follow-return-to-state']) return '↩';
    const to = steps.find(s => s.id === exit['move-to-state']);
    if (!to || to.id === next) return null;
    if (to.id === step.id) return '⟳';
    if (quarantined(to)) return '⊘';
    return `${to.sequence < step.sequence ? '↺' : '↷'}${to.sequence}`;
  });
  return [...new Set(out.filter(Boolean))].join(' ');
}
