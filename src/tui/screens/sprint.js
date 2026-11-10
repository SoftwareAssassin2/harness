// The sprint screen (s): its ticket grid under the progress bar (ASS-201: moved from app.js).
import { pathToFileURL } from 'node:url';
import { progressBar, stateColor } from '../progress.js';
import { runsBefore } from '../since.js';
import { isUnopened, unopenedAs, mrShown } from '../status.js';
import { boxTable, lastStart, tableLayout } from '../table.js';
import { pad, link, visible, clip } from '../text.js';
import { workedByHand, tokenSpend, testCounts } from '../ticket.js';
import { below, headerLines, platform } from './frame.js';
import { NONE, feedback, agentLines, liveAssignments, ticketMarks, sprintMark, markDot, GLYPHS, move, green, red, gold, gray, sprintTickets, statusCell, ticketAgents, chatSpend, seatHolders } from './shared.js';
import { openTicket } from './ticket.js';
import { isHeld } from '../../control/engine.js';
import { slotKind } from '../../control/plan.js';

const TABLE_HEADERS = ['Ticket', 'Priority', 'Status', 'Points', 'Build', 'Dev', 'Testing', 'MR', 'Total Token Spend', 'Assignee', 'Health', 'Agents'];
// The Ticket column is the most important one (ASS-207): it keeps at least the
// key and TITLE_CHARS characters of title, Health then Agents giving up their
// width to leave room — then Status (ASS-326), re-wrapping its lines narrower
// (statusCell) rather than letting the grid run off the screen. Declared after
// TABLE_HEADERS, which SHRINK reads.
const TITLE_CHARS = 24;
const SHRINK = ['Health', 'Agents', 'Status'].map(h => TABLE_HEADERS.indexOf(h));
// The Ticket column's floor: over the rows, the width of the key/icon prefix
// plus TITLE_CHARS title characters (or the whole title if shorter), and one
// more for the ellipsis when the title is cut. Measured off the already-built
// Ticket cell and its title, so the prefix (the six one-cell icon columns and
// the two-cell seat, PAUSED, WAITING ON or UNASSIGNED, the linked key: see ticketRows) is not re-derived. No rows → 0 (no floor).
const ticketFloor = (rows, tickets) => Math.max(0, ...rows.map((row, i) => {
  const title = tickets[i].title;
  return visible(row[0]) - visible(title) + visible(clip(title, TITLE_CHARS)) + (visible(title) > TITLE_CHARS ? 1 : 0);
}));

// The dashboard grid's [selected, scroll]: stored numbers as they are; `null`
// (not scrolled yet, as agentLogScroll is) resolved to where the grid opens
// (ASS-60) — the last Done row at the top of the view, or as far as the grid
// can scroll, whichever is the higher row, and that row selected. No Done
// row, no not-done row (the Done-first sort puts the last Done row last) or
// every row fitting: the top.
function gridAt(state, { rows, bodyHeight }, tickets, done) {
  const last = tickets.findLastIndex(t => t.step?.sequence === done);
  const open = last < 0 || last >= rows.length - 1 ? 0 : Math.min(last, lastStart(rows, bodyHeight));
  return [state.selected ?? open, state.scroll ?? open];
}

// The dashboard's ticket grid: its rows and the lines its body may take
// (borders take 4 more) — all that is left under the header and progress bar
// (3 lines, its state names and a blank), above the key under the grid
// (iconKey, ASS-259: the grid gives up rows, never the key) and the legend with
// the platform boxes, or a blank line, over it — and the grid drawn, `room`
// the lines it may take: too short a screen for even its headers cuts the
// grid's own lines, not the key's. The header and the platform boxes are
// measured at the size's now, the time render draws them at (ASS-295): the
// models box's API spend line shows only in now's month, so at time 0 the
// footer came out a line short and render cut the key. The grid's rows are
// kept laid out (tableLayout, ASS-326): a Status cell's height depends on the
// width its column ends up with, and scrolling (gridAt, move) counts lines.
function layout(state, { columns = 0, rows = Infinity, now = 0 }) {
  const { tickets, steps, done } = sprintTickets(state);
  const bottom = below(state) + Math.max(1, platform(state, columns, now).length);
  const key = iconKey(columns);
  const free = rows - headerLines(state, columns, now).length - bottom - 5 - key.length;
  const cells = ticketRows(tickets, liveAssignments(state), steps, state.projects[state.project]?.collaborations, ticketMarks(state, tickets), seatHolders(state));
  const fit = { columns, stretch: 0, min: ticketFloor(cells, tickets), shrink: SHRINK };
  const ticketGrid = { rows: tableLayout(TABLE_HEADERS, cells, fit).cells, bodyHeight: free - 4 };
  const [selected, scroll] = gridAt(state, ticketGrid, tickets, done);
  // The same rows and fit as ticketGrid's: boxTable lays them out alike.
  const table = boxTable(TABLE_HEADERS, cells.length ? cells : [['No tickets in this sprint']], {
    ...fit, height: ticketGrid.bodyHeight + 4, scroll, dashed: true, separators: boundaries(tickets),
    selected: state.focus === 'tickets' && ticketGrid.rows.length ? selected : undefined,
  });
  return { tickets, steps, done, ticketGrid, table, key, room: Math.max(0, free), selected, scroll };
}

// The grid's section lines (ASS-358), for boxTable's `separators`: solid
// green under the last Done row (its step is-done), when other rows follow; solid blue, labelled,
// over the first planning-pool row below the last in-progress-pool one
// (slotKind; rows in neither pool — done, blocked, queued — are skipped).
// Every other line between rows stays dashed.
const DONE_LINE = { color: '32' };
const POOL_LINE = { color: '34', text: 'planning ↓ · ↑ in progress' };
function boundaries(tickets) {
  const kinds = tickets.map(t => slotKind(t.step, t.status));
  const doneEnd = tickets.findLastIndex(t => t.step?.['is-done'] === true) + 1;
  const progress = kinds.lastIndexOf('progress');
  const planning = progress < 0 ? -1 : kinds.indexOf('planning', progress);
  return i => (i === doneEnd ? DONE_LINE : i === planning ? POOL_LINE : null);
}

const PAUSED = '\x1b[34mPAUSED\x1b[0m';   // blue, before a paused variation's key (ASS-259)
const UNASSIGNED = red('UNASSIGNED');   // red (ASS-355; was PAUSED's blue), before a reassigned ticket's key, in PAUSED's place (ASS-345)
// waitingOn(keys) — gold, before a variation its dependencies hold, in PAUSED's place (ASS-355): "WAITING ON EX-1, EX-2";
// past WAITING_KEYS keys the rest counted ("WAITING ON EX-1, EX-2 +7"), so the Ticket column, which keeps its title in
// view (ticketFloor), never pushes the grid off the screen — the Status cell lists every one.
const WAITING_KEYS = 2;
const waitingOn = keys => gold(`WAITING ON ${keys.slice(0, WAITING_KEYS).join(', ')}${keys.length > WAITING_KEYS ? ` +${keys.length - WAITING_KEYS}` : ''}`);
const dim = text => `\x1b[2m${text}\x1b[0m`;
// A variation holding a planning or in-progress seat (ASS-357): an emoji, two
// cells wide (text.js visible counts it so), its column two blanks without.
const SEAT = '💺';

// The key under the ticket grid (ASS-259): each of the rows' glyphs as they
// are drawn there — ⦿ in each of its colors, PAUSED in blue, UNASSIGNED in red, WAITING ON in gold — with what it
// means, in dim text; entries two blanks apart, wrapped at `columns` between
// entries, never inside one.
const KEY = [
  [dim(GLYPHS.step), 'step'], [dim(GLYPHS.features), 'feature'], [dim(GLYPHS.bugs), 'bug'], [dim(GLYPHS.spikes), 'spike'],
  [dim(GLYPHS.hand), 'by hand'], [dim(GLYPHS.fast), 'fast-tracked'], [markDot(GLYPHS.mark, 'change'), 'requirements change'],
  [markDot(GLYPHS.mark, 'needed'), 'needs you'], [markDot(GLYPHS.mark, 'assumed'), 'assumption'], [dim(GLYPHS.agent), 'agent working'],
  [SEAT, 'holds a seat (planning or in progress)'],
  [PAUSED, 'paused'], [UNASSIGNED, 'reassigned away'], [gold('WAITING ON'), 'a dependency not done yet'],
].map(([glyph, meaning]) => `${glyph}${dim(` ${meaning}`)}`);
function iconKey(columns) {
  const lines = [];
  for (const entry of KEY) {
    const last = lines.at(-1);
    if (last != null && visible(last) + 2 + visible(entry) <= columns) lines[lines.length - 1] = `${last}  ${entry}`;
    else lines.push(entry);
  }
  return lines;
}

// MR build-status colors; any other status stays uncolored.
const BUILD_COLORS = { Merged: gray, Closed: gray, Running: gold, Failed: red, Passed: green };

// One table row per ticket variation (see sprintTickets). Status is its
// statusCell, wrapped at its column's width (ASS-326). The Ticket cell leads with a square in that step's
// progress-bar color, the deepest step's own when it has one (`steps` set its shade). Priority, points and assignee come from the ticket; Agents
// lists its assignments from assignments.json; Health is the variation's ai-feedback-short;
// Total Token Spend its tokenSpend, the ticket's chat's spend (ASS-35) on its first variation's row alone.
// A priority set by hand (manual-priority) has 🪪 beside it.
// The Ticket cell's text starts after six one-cell columns (ASS-259), each its
// glyph (GLYPHS: East Asian Width N, no emoji) or a blank, side by side and
// one blank before the text, so it lines up down the grid: c1 ▮ in the step's
// progress-bar color; c2 the type, ✦ ✘ ⌕; c3 ☛ for a ticket worked by hand
// (ASS-166; in place of its Health, who since when: workedByHand); c4 ↯ for a
// fast-tracked one (ASS-83); c5 its ⦿ (sprintMark) — red for a pending
// requirements change (ASS-78), else blue waiting on the operator
// (`marks.needed`, see ticketMarks, ASS-242), else dim grey going on with an
// assumption alone (`marks.assumed`, ASS-248), on every variation's row; c6 ⚉
// while an agent works on the row's ticket and variation (its Agents); then a
// two-cell column, 💺 when the variation holds a planning or in-progress seat
// (ASS-357: `seats`, seatHolders — the planner's, none on a past day). A
// paused variation's (is-paused) text starts "PAUSED " in blue — one its
// dependencies hold (its `hold`, ASS-355: control's own predicate) "WAITING ON
// <KEY>, <KEY> " in gold in its place, paused too or not; a ticket
// reassigned away from the operator's account (ASS-345: ticket:sync's
// reassigned, to another person or to nobody) "UNASSIGNED " in red in place
// of either, on every variation's row: the reassignment says more; iconKey
// says what each means, under the grid.
function ticketRows(tickets, assignments, steps, collaborations = {}, marks = { needed: new Set() }, seats = new Set()) {
  return tickets.map(t => {
    // One line per assignment to this ticket and this row's variation (or to no
    // variation in particular).
    const agents = ticketAgents(assignments, t);
    const name = `${t.shownKey}: ${t.title}`;
    const icons = [
      t.step ? `${stateColor({ sequence: t.step.sequence, color: t.color }, steps)}${GLYPHS.step}\x1b[0m` : '',
      GLYPHS[t.kind] ?? '', workedByHand(t) ? GLYPHS.hand : '', t['fast-track'] === true ? GLYPHS.fast : '', sprintMark(marks, t), agents.length ? GLYPHS.agent : '',
    ];
    const held = t.reassigned ? `${UNASSIGNED} ` : t.hold?.waits?.length ? `${waitingOn(t.hold.waits)} ` : t.variation['is-paused'] === true ? `${PAUSED} ` : '';
    return [
      `${icons.map(icon => icon || ' ').join('')}${seats.has(`${t.key} ${t.variation.name}`) ? SEAT : '  '} ${held}${t.url ? link(name, t.url) : name}`,
      String(t.priority ?? NONE) + (t['manual-priority'] != null ? ' 🪪' : ''),
      statusCell(t, steps),
      String(t.points ?? NONE),
      ...variationCells(t.variation),
      tokenSpend(t.variation, t.variation === t.variations?.[0] ? chatSpend(collaborations, t.key) : 0) ?? NONE,
      t['ticket-system-assignment'] ?? NONE,
      workedByHand(t) ?? feedback(t.variation['ai-feedback-short']),
      agentLines(agents),
    ];
  });
}

// A variation's Build, Dev, Testing and MR cells. Build stacks "branch: …" over
// "worktree: …"; Dev and Testing show a circle per acceptance criterion, Dev
// with "x/y automated tests" beneath when both counts are known (testCounts);
// MR stacks one "key  build-status" line per merge request, both links — its
// status in place of the build status once Merged or Closed; "MR <id>
// planned", gray and unlinked, for one only planned (ASS-80).
function variationCells(v) {
  const criteria = v['acceptance-criteria'];
  // One circle per criterion: green Passed, red Failed, gray otherwise.
  const circles = field =>
    (criteria?.length ? criteria.map(c => ({ Passed: green, Failed: red }[c[field]] ?? gray)('●')).join(' ') : NONE);
  const tests = testCounts(v['local-testing']);
  const dev = [
    criteria?.length && circles('dev-status'),
    tests && `${tests[0]}/${tests[1]} automated tests`,
  ].filter(Boolean);
  const { branch, 'branch-url': branchUrl, worktree, 'worktree-folder': folder } = v.build ?? {};
  // Always two lines, each blank until there is a branch or worktree.
  const build = [
    branch ? `branch: ${branchUrl ? link(branch, branchUrl) : branch}` : '',
    worktree ? `worktree: ${folder ? link(worktree, pathToFileURL(folder).href) : worktree}` : '',
  ];
  const mrs = v['merge-request'] ?? [];
  const keyWidth = Math.max(0, ...mrs.filter(m => !isUnopened(m)).map(m => m.key.length));
  return [
    build,
    dev.length ? dev : NONE,
    circles('testing-status'),
    mrs.length ? mrs.map(m => (isUnopened(m) ? gray(`MR ${m.id} ${unopenedAs(m)}`)
      : `${pad(link(m.key, m.url), keyWidth)}  ${(BUILD_COLORS[mrShown(m)] ?? String)(link(mrShown(m), m['build-url'] ?? m.url))}`)) : NONE,
  ];
}

export function view(state, size) {
  const { tickets, steps, table, key, room } = layout(state, size);
  const { columns } = size;
  // One run per state holding variations, left to right in the reverse of the
  // table's order, so the bottom row's state comes first; Done is the
  // engine's highest sequence. Each run carries the agents assigned to its
  // variations: an assignment counts once, on its variation, or on the
  // ticket's first row when it names none. And a computer (ASS-237) per variation
  // whose deepest step is a script, bar one at its gate (humanGate) or held (isHeld:
  // paused, or worked by hand), which control leaves where it is; none on a past
  // day, as no robots (liveAssignments).
  // A run per step and color: a group's tickets split by their deepest steps' colors (ASS-67),
  // each named under the bar by its step.
  const shade = t => t?.step && `${t.step.id}\n${t.color ?? ''}`;
  const runs = list => Map.groupBy(list.filter(t => t.step).toReversed(), shade);
  const counts = runs(tickets);
  // Each run's change since yesterday's snapshot, counted by the same runs (ASS-260). A state emptied
  // since has no run to label, so it is left off.
  const before = runsBefore(state, size.now, runs);
  const agents = Map.groupBy(liveAssignments(state).map(a => tickets.find(t => t.key === a['work-item'] && (a.variation == null || a.variation === t.variation.name))), shade);
  const segments = [...counts.values()].map(list => ({ sequence: list[0].step.sequence, color: list[0].color, name: list[0].step.name ?? list[0].step.id, count: list.length, change: before && list.length - (before.get(shade(list[0]))?.length ?? 0), agents: agents.get(shade(list[0]))?.length ?? 0,
    scripts: state.day ? 0 : list.filter(t => t.status.detailStep?.action?.type === 'script' && t.gate == null && !isHeld(t, t.variation)).length }));
  return [
    ...progressBar(segments, { steps, columns }),
    '',
    ...table.slice(0, room),
    ...key,
  ];
}

// Its keys: ↑/↓ move the grid's selection, enter opens the selected ticket's screen.
export function onKey(state, key, size, { step, sideways }) {
  if (key.name === 'return' && state.screen === 's' && state.focus === 'tickets') {
    const { tickets, selected } = layout(state, size);
    const ticket = tickets[selected];
    return ticket ? openTicket(state, { key: ticket.key, variation: ticket.variation.name }) : state;
  }
  if (step && !sideways && state.screen === 's' && state.focus === 'tickets') {
    const grid = layout(state, size);
    const [selected, scroll] = move(grid.ticketGrid, grid.selected, grid.scroll, step);
    return { ...state, selected, scroll };
  }
}
