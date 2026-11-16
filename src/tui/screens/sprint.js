// The sprint screen (s): its ticket grid under the progress bar (ASS-201: moved from app.js).
import { progressBar, stateColor } from '../progress.js';
import { runsBefore } from '../since.js';
import { boxTable, lastStart, tableLayout } from '../table.js';
import { link, visible, clip } from '../text.js';
import { workedByHand, tokenSpend, testCounts } from '../ticket.js';
import { below, headerLines, platform } from './frame.js';
import { usesWorkstations } from '../../control/dev-environments.js';
import { NONE, agentLines, liveAssignments, ticketMarks, sprintMark, markDot, GLYPHS, move, green, red, gold, gray, sprintTickets, statusCell, ticketAgents, chatSpend, seatPlan, runsScript } from './shared.js';
import { openTicket } from './ticket.js';
import { slotKind } from '../../control/plan.js';
import { enginesOf } from '../status.js';

// ASS-437: no Build or MR column — a ticket's branch, worktree and merge requests are on its screen's Merge
// requests tab — and no Health column: the variation's ai-feedback-short is the quick-details panel's Health line
// and in full the Details tab's Health; a ticket worked by hand keeps its ☛ (the Ticket cell's c3) and the panel's By hand.
// ASS-454: no Priority column — each row's Ticket cell starts with its priority (priorityPrefix), so the Ticket
// header starts with the same four-cell indent: centered (boxTable) over the rest of the column, over the text.
const PRIORITY_CELLS = 3;
const PRIORITY_CAP = 999;
const TABLE_HEADERS = [`${' '.repeat(PRIORITY_CELLS + 1)}Ticket`, 'Status', 'Points', 'Dev', 'Testing', 'Total Token Spend', 'Assignee', 'Agents'];
// The Ticket column is the most important one (ASS-207): it keeps at least the
// key and TITLE_CHARS characters of title, Agents giving up its width to leave
// room first (Health did before it, until ASS-437 took that column) — then Status (ASS-326), re-wrapping its lines narrower
// (statusCell) rather than letting the grid run off the screen. Declared after
// TABLE_HEADERS, which SHRINK reads.
const TITLE_CHARS = 24;
const SHRINK = ['Agents', 'Status'].map(h => TABLE_HEADERS.indexOf(h));
// The Ticket column's floor: over the rows, the width of the key/icon prefix
// plus TITLE_CHARS title characters (or the whole title if shorter), and one
// more for the ellipsis when the title is cut. Measured off the already-built
// Ticket cell's first line and its title, so the prefix (the priority's three
// cells and a blank, ASS-454, the five one-cell icon columns, the two-cell 🤖/💻 (ASS-456) and the two-cell seat, PAUSED or UNASSIGNED, the linked key: see
// ticketRows) is not re-derived. A held row's cell is two lines (ASS-360): its
// "↳ AWAITING" line (ASS-364; was WAITING ON), never cut, floors the column at its own width alone, so
// it widens the column only when wider than the first line's floor; so does a
// row's "↳ AWAITING MERGE" line (ASS-363), its third when it has both. No rows → 0 (no floor).
const ticketFloor = (rows, tickets) => Math.max(0, ...rows.map((row, i) => {
  const [first, ...more] = [row[0]].flat();
  const title = tickets[i].title ?? '';   // an empty seat row (ASS-451) has none: its whole line floors the column
  return Math.max(visible(first) - visible(title) + visible(clip(title, TITLE_CHARS)) + (visible(title) > TITLE_CHARS ? 1 : 0), ...more.map(visible));
}));

// The dashboard grid's [selected, scroll]: stored numbers as they are; `null`
// (not scrolled yet, as agentLogScroll is) resolved to where the grid opens
// (ASS-60) — the last Done row at the top of the view, or as far as the grid
// can scroll, whichever is the higher row, and that row selected. No Done
// row, no not-done row (the Done-first sort puts the last Done row last) or
// every row fitting: the top.
// ASS-402: when the project's engines (its own and every sub-engine its steps
// run, as far down as they go) have an is-qa step, the last row at a QA step
// (isQa, any level of its chain) takes the last Done row's place; no such row:
// the last Done row, as before; a past day opens as before. Read by the flag, never a step's id or name.
function gridAt(state, { rows, bodyHeight }, tickets, done, steps = []) {
  const qa = !state.day && hasQaStep(state, steps) ? tickets.findLastIndex(isQa) : -1;
  const last = qa >= 0 ? qa : tickets.findLastIndex(t => t.step?.sequence === done);
  const open = last < 0 || last >= rows.length - 1 ? 0 : Math.min(last, lastStart(rows, bodyHeight));
  return [ticketRowNear(tickets, state.selected ?? open), state.scroll ?? open];
}

// ticketRowNear(rows, at) — `at`, or when that row is an empty seat (ASS-451: never selected) the nearest ticket row
// below it, else above it; `at` itself when the grid has no ticket row (nothing is selected then: layout).
function ticketRowNear(rows, at) {
  if (!isEmptySeat(rows[at])) return at;
  const below = rows.findIndex((row, i) => i > at && !isEmptySeat(row));
  if (below >= 0) return below;
  const above = rows.findLastIndex(row => !isEmptySeat(row));
  return above >= 0 ? above : at;
}

// ASS-402: whether the project's engine (its `steps`, as sprintTickets
// resolves it), or any sub-engine reached through a state-engine action, as
// far down as they go, has a step with is-qa.
function hasQaStep(state, steps) {
  const engines = enginesOf(state.workflows);
  const seen = new Set();
  const has = listed => listed.some(s => s?.['is-qa'] === true) || listed.some(s => s?.action?.type === 'state-engine' && visit(s.action.engine));
  const visit = name => {
    if (typeof name !== 'string' || seen.has(name) || !engines[name]) return false;
    seen.add(name);
    return has(Object.values(engines[name]).filter(Array.isArray).flat());
  };
  return has(steps);
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
  const seats = seatPlan(state);
  const { rows: grid, place } = withEmptySeats(tickets, seats);
  const bottom = below(state) + Math.max(1, platform(state, columns, now).length);
  const settings = state.projects[state.project]?.devEnvironments;
  const key = iconKey(columns, Boolean(usesWorkstations(settings?.mode) && settings.workstations?.length));
  const free = rows - headerLines(state, columns, now).length - bottom - 5 - key.length;
  const cells = ticketRows(grid, liveAssignments(state), steps, state.projects[state.project]?.collaborations, ticketMarks(state, tickets), seats, t => runsScript(state, t));
  const fit = { columns, stretch: 0, min: ticketFloor(cells, grid), shrink: SHRINK };
  const ticketGrid = { rows: tableLayout(TABLE_HEADERS, cells, fit).cells, bodyHeight: free - 4 };
  const [selected, scroll] = gridAt(state, ticketGrid, grid, done, steps);
  const selectable = tickets.length > 0;   // ASS-451: empty seat rows alone — nothing to select
  // The same rows and fit as ticketGrid's: boxTable lays them out alike.
  const table = boxTable(TABLE_HEADERS, cells.length ? cells : [['No tickets in this sprint']], {
    ...fit, height: ticketGrid.bodyHeight + 4, scroll, dashed: true, separators: boundaries(tickets, place),
    selected: state.focus === 'tickets' && selectable ? selected : undefined,
  });
  return { tickets, grid, steps, done, ticketGrid, table, key, room: Math.max(0, free), selected: selectable ? selected : undefined, scroll };
}

// The grid's section lines (ASS-358), for boxTable's `separators`: solid
// green under the last Done row (its step is-done), when other rows follow, labelled
// "in progress ↓ · ↑ done" like the blue one (ASS-371); solid blue, labelled,
// over the first planning-pool row below the last in-progress-pool one
// (slotKind; rows in neither pool — done, blocked, queued — are skipped).
// Every other line between rows stays dashed. Each label reads "<section below> ↓ · ↑
// <section above>", each side's name followed by its row count (ASS-426, boundaries).
const DONE_LINE = { color: '32', below: 'in progress', above: 'done' };
const POOL_LINE = { color: '34', below: 'planning', above: 'in progress' };
// ASS-401: solid purple under the last row whose variation's status chain is, at any level, at a step
// with is-qa (never the step's id or name), when other rows follow; the green line over QA rows then
// reads "in QA ↓ · ↑ done".
const QA_LINE = { color: '35', below: 'in progress', above: 'in QA' };
const DONE_OVER_QA = { ...DONE_LINE, below: 'in QA' };
const isQa = t => (t.status?.chain ?? [{ step: t.step }]).some(l => l.step?.['is-qa'] === true);
// ASS-426: "in progress (6) ↓ · ↑ done (2)" — each side's count is the grid's rows (every one, scrolled
// into view or not) between the line and the next line drawn on that side, or the grid's top or bottom
// edge, so read down the grid every row is counted once. Where lines go is ASS-358/371/401's, unchanged;
// only lines boxTable draws (before rows 1 to n-1, never the first) bound a section.
// ASS-451: worked out over the ticket rows alone — the counts and where each line falls among them never change
// for empty seat rows — then drawn before the grid row `place` (withEmptySeats) gives: above the empty seats just
// before that ticket row that belong below the line (every one under the green and purple lines; the planning ones
// under the blue line, the in-progress ones staying above it). No `place`: the ticket rows are the grid's.
function boundaries(tickets, place = i => i) {
  const kinds = tickets.map(t => slotKind(t.step, t.status));
  const doneEnd = tickets.findLastIndex(t => t.step?.['is-done'] === true) + 1;
  const qaEnd = tickets.findLastIndex(isQa) + 1;
  const progress = kinds.lastIndexOf('progress');
  const planning = progress < 0 ? -1 : kinds.indexOf('planning', progress);
  const done = doneEnd < tickets.length && isQa(tickets[doneEnd]) ? DONE_OVER_QA : DONE_LINE;
  const line = i => (i === doneEnd ? done : i === qaEnd && qaEnd > 0 ? QA_LINE : i === planning ? POOL_LINE : null);
  const at = [...new Set([doneEnd, qaEnd, planning])].filter(i => i > 0 && i < tickets.length && line(i)).sort((a, b) => a - b);
  const labelled = new Map(at.map((i, n) => {
    const { color, below, above } = line(i);
    const down = (at[n + 1] ?? tickets.length) - i, up = i - (at[n - 1] ?? 0);
    return [i, { color, text: `${below} (${down}) ↓ · ↑ ${above} (${up})` }];
  }));
  const drawn = new Map([...labelled].map(([i, label]) => [place(i, line(i) === POOL_LINE), label]));
  return i => drawn.get(i) ?? null;
}

// ASS-451: an empty seat row — one per free in-progress and per free planning seat (seatPlan's free, freeSeats) on
// the live sprint's grid; none on a past day (seatPlan: no seats then). It is no ticket: never selected (the
// cursor, ↑/↓, Enter skip it: ticketRowNear, step), not counted (boundaries, the header's tiles and totals read the
// ticket rows); scrolling counts it as a row.
const isEmptySeat = row => row?.emptySeat != null;
// withEmptySeats(tickets, seats) — { rows, place }: `rows`, the grid's rows, the tickets (sprintTickets' order)
// with each free seat's { emptySeat: kind } among them: the in-progress ones right after the last row holding an
// in-progress seat (seats.progress), or with none at the start of the in-progress section — the first
// in-progress-pool row (slotKind) under the done and QA rows, else the first planning-pool row there, else just
// under them; the planning ones right after the last row holding a planning seat (seats.planning) and never above
// the in-progress ones, or with none at the start of the planning section — the first planning-pool row at or
// after the in-progress ones, else just after the last in-progress-pool row and them. Every ticket row keeps its
// order. `place(i, pool)`, the grid row a section line over ticket row i is drawn before (boundaries): over the
// empty seats inserted just before it, or — `pool`, the blue planning line — over the planning ones alone.
export function withEmptySeats(tickets, { progress = [], planning = [], free = {} } = {}) {
  if (!free.progress && !free.planning) return { rows: tickets, place: i => i };
  const id = t => `${t.key} ${t.variation?.name}`;
  const kinds = tickets.map(t => slotKind(t.step, t.status));
  const top = Math.max(tickets.findLastIndex(t => t.step?.['is-done'] === true), tickets.findLastIndex(isQa)) + 1;
  const first = (kind, from) => kinds.findIndex((k, i) => i >= from && k === kind);
  const lastHolder = held => tickets.findLastIndex(t => held.includes(id(t)));
  const progressAt = lastHolder(progress) >= 0 ? lastHolder(progress) + 1 : [first('progress', top), first('planning', top), top].find(i => i >= 0);
  const planningAt = lastHolder(planning) >= 0 ? Math.max(progressAt, lastHolder(planning) + 1)
    : [first('planning', progressAt), Math.max(progressAt, kinds.lastIndexOf('progress') + 1)].find(i => i >= 0);
  const rows = [], at = [];
  for (let i = 0; i <= tickets.length; i++) {
    at.push({ progress: rows.length });
    rows.push(...Array.from({ length: i === progressAt ? free.progress : 0 }, () => ({ emptySeat: 'progress' })));
    at[i].planning = rows.length;
    rows.push(...Array.from({ length: i === planningAt ? free.planning : 0 }, () => ({ emptySeat: 'planning' })));
    if (i < tickets.length) rows.push(tickets[i]);
  }
  return { rows, place: (i, pool) => at[i][pool ? 'planning' : 'progress'] };
}
const EMPTY_SEAT = 'empty seat';

const PAUSED = '\x1b[34mPAUSED\x1b[0m';   // blue, before a paused variation's key (ASS-259)
const UNASSIGNED = red('UNASSIGNED');   // red (ASS-355; was PAUSED's blue), before a reassigned ticket's key, in PAUSED's place (ASS-345)
// waitingOn(keys) — gold (ASS-355), for a variation its dependencies hold, on the Ticket cell's second line after
// "↳ " (ASS-360; AWAITING, was WAITING ON, ASS-364; it was in PAUSED's place on the first): "AWAITING EX-1, EX-2"; past WAITING_KEYS keys the rest
// counted ("AWAITING EX-1, EX-2 +7"), so the Ticket column, floored at that line's width (ticketFloor), never pushes
// the grid off the screen — the ticket screen's Status field (statusText) lists every one. Each key shown is followed
// by whose it is (ASS-360 AC7, waitingWho): "AWAITING EX-1 (Sam), EX-2 (unassigned)".
const WAITING_KEYS = 2;
const waitingOn = (keys, who = () => '') => gold(`AWAITING ${keys.slice(0, WAITING_KEYS).map(k => `${k}${who(k)}`).join(', ')}${keys.length > WAITING_KEYS ? ` +${keys.length - WAITING_KEYS}` : ''}`);
// waitingWho(t)(key) — the suffix after a held ticket's waited-on key (ASS-360 AC7), from the assignee the ticket
// screen names it with (t.dependencyRows, control's dependencyRows: the sprint's, backlog's, other loaded projects'
// or outside-tickets.json's ticket-system-assignment, a display name): " (<first name>)" for someone other than the
// operator — whom the held ticket itself is assigned to, compared by name, as outside tickets carry no account id —
// " (unassigned)" for nobody, and nothing for the operator or a key found nowhere (where 'unknown').
export const waitingWho = t => key => {
  const row = (t.dependencyRows ?? []).find(r => r.key.toUpperCase() === key.toUpperCase());
  if (!row || row.where === 'unknown') return '';
  if (row.assignee == null) return ' (unassigned)';
  return row.assignee === t['ticket-system-assignment'] ? '' : ` (${row.assignee.trim().split(/\s+/)[0]})`;
};
// mergeTrains(t) — the merge trains of a variation held at a merge wait (ASS-363), [] for none: each an array of its
// merge requests, starting with an awaited one and going on in depends-on order. Only at a step that says so — any
// level of its status chain (t.status.chain) at a step with shows-merge-train: true (grouped-build's Await Sequential
// Merge), never a step id or name compared. From the variation's recorded merge-request list alone (no forge call),
// with merge-request:await-dependencies' own test (MR_DEPS): a merge request awaited is one that a merge request of
// the variation — with an id, neither Merged nor Closed — depends on, found in the list (the first with that id), in
// another repository, and neither Merged nor Closed itself. Its train goes on through every merge request of the
// variation that depends on it, directly or not, each placed once all it depends on in the train are (list order
// among those ready; a cycle's rest at the end).
export function mergeTrains(t) {
  if (!(t.status?.chain ?? []).some(l => l.step?.['shows-merge-train'] === true)) return [];
  const mrs = (t.variation?.['merge-request'] ?? []).filter(m => m?.id != null);
  const done = m => m.status === 'Merged' || m.status === 'Closed';
  const byId = new Map();
  for (const m of mrs) if (!byId.has(m.id)) byId.set(m.id, m);
  const deps = m => (m['depends-on'] ?? []).map(id => byId.get(id)).filter(Boolean);
  const awaited = [...new Set(mrs.filter(m => !done(m)).flatMap(m => deps(m).filter(d => !done(d) && d.repository !== m.repository)))];
  const reach = head => {
    const reached = new Set([head]);
    for (let grew = true; grew;) {
      grew = false;
      for (const m of byId.values()) if (!reached.has(m) && deps(m).some(d => reached.has(d))) { reached.add(m); grew = true; }
    }
    return reached;
  };
  const reaches = new Map(awaited.map(head => [head, reach(head)]));
  // An awaited one already in an earlier-starting train (web !7 awaited by lib !4, itself awaiting api !12) is shown
  // there, in order: no train of its own.
  const heads = awaited.filter((head, i) => !awaited.some((other, j) => other !== head && reaches.get(other).has(head) && !(reaches.get(head).has(other) && j > i)));
  return heads.map(head => {
    const reached = reaches.get(head);
    const train = [head];
    for (let rest = [...byId.values()].filter(m => m !== head && reached.has(m)); rest.length;) {
      const next = rest.find(m => deps(m).every(d => !reached.has(d) || train.includes(d))) ?? rest[0];
      train.push(next);
      rest = rest.filter(m => m !== next);
    }
    return train;
  });
}
// awaitingMerge(trains) — the AWAITING MERGE line's text (ASS-363), "AWAITING MERGE" in gold then each train's merge
// requests joined by " → ", trains by "; ": each "<repo> <key>", the repository url's last path segment linked to
// that url and the key to the merge request's url where known; "MR <id>" for a planned one with no key yet —
// "AWAITING MERGE api !12 → web !7" (for acme/api and acme/web). repoName is exported for the open MRs screen's
// text, which names a repository the same way (ASS-366).
export const repoName = url => (url ?? '').replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop();
const awaitingMerge = trains => `${gold('AWAITING MERGE')} ${trains.map(train => train.map(m => {
  const repo = repoName(m.repository), key = m.key ?? `MR ${m.id}`;
  return [repo && (/^https?:\/\//.test(m.repository) ? link(repo, m.repository.replace(/\.git$/, '')) : repo), m.url && m.key ? link(key, m.url) : key].filter(Boolean).join(' ');
}).join(' → ')).join('; ')}`;
const dim = text => `\x1b[2m${text}\x1b[0m`;
// A priority set by hand (manual-priority) is drawn in bright magenta (ASS-454; ' 🪪' after it before): no step
// color is near it — stateColor's greens and the engines' own colors (red, orange, gold, and Self Healing's deep sky
// blue #00bfff, too close to cyan, the color the ticket suggested) — nor any glyph's on the rows.
const byHand = text => `\x1b[95m${text}\x1b[0m`;
// priorityPrefix(priority, manual) — what starts every ticket row (ASS-454): the priority right-aligned in
// PRIORITY_CELLS cells, padded with spaces ("  1", " 42", "137"), past PRIORITY_CAP shown as it ("999", no "+";
// the key says so), bright magenta when set by hand; then one blank. No priority (null: an unranked ticket, or a row that
// is no ticket, such as an empty seat): blanks, so the icon columns still start four cells in.
export const priorityPrefix = (priority, manual = false) => {
  const n = Number(priority);
  const text = priority == null || priority === '' ? '' : (Number.isFinite(n) ? String(Math.min(n, PRIORITY_CAP)) : String(priority)).slice(0, PRIORITY_CELLS);
  return `${' '.repeat(PRIORITY_CELLS - text.length)}${text && manual ? byHand(text) : text} `;
};
// A variation holding a planning or in-progress seat (ASS-357): an emoji, two
// cells wide (text.js visible counts it so), its column two blanks without.
const SEAT = '💺';
// ASS-469: a variation in progress holding a workstation seat (control's seats.json): ⛅, two cells too, in 💺's place.
const WS_SEAT = '⛅';

// The key under the ticket grid (ASS-259): the priority the rows start with
// (ASS-454), in bright magenta when set by hand, then each of the rows' glyphs as they
// are drawn there — ⦿ in each of its colors, PAUSED in blue, UNASSIGNED in red, AWAITING in gold (on its own line under the ticket, ASS-360),
// AWAITING MERGE in gold (on its own line after that, ASS-363) — with what it
// means, in dim text; entries two blanks apart, wrapped at `columns` between
// entries, never inside one.
const KEY = [
  [dim('137'), `priority (${PRIORITY_CAP} = ${PRIORITY_CAP} or more)`], [byHand('137'), 'priority set by hand'],
  [dim(GLYPHS.step), 'step'], [dim(GLYPHS.features), 'feature'], [dim(GLYPHS.bugs), 'bug'], [dim(GLYPHS.spikes), 'spike'],
  [dim(GLYPHS.hand), 'by hand'], [dim(GLYPHS.fast), 'fast-tracked'], [markDot(GLYPHS.mark, 'change'), 'requirements change'],
  [markDot(GLYPHS.mark, 'needed'), 'needs you'], [markDot(GLYPHS.mark, 'assumed'), 'assumption'], [GLYPHS.agent, 'agent working'], [GLYPHS.script, 'script running'],
  [SEAT, 'holds a seat (planning or in progress)'],
  [PAUSED, 'paused'], [UNASSIGNED, 'reassigned away'], [gold('AWAITING'), 'a dependency not done yet'], // ASS-364: was WAITING ON
  [gold('AWAITING MERGE'), 'MRs to merge, in order'],
].map(([glyph, meaning]) => `${glyph}${dim(` ${meaning}`)}`);
// ASS-469: ⛅'s entry, after 💺's, only for a project whose tickets run on GCP workstations (`workstations`).
const WS_KEY = `${WS_SEAT}${dim(' holds a workstation seat')}`;
function iconKey(columns, workstations = false) {
  const lines = [];
  const entries = workstations ? KEY.flatMap(e => (e.startsWith(SEAT) ? [e, WS_KEY] : [e])) : KEY;
  for (const entry of entries) {
    const last = lines.at(-1);
    if (last != null && visible(last) + 2 + visible(entry) <= columns) lines[lines.length - 1] = `${last}  ${entry}`;
    else lines.push(entry);
  }
  return lines;
}

// One table row per ticket variation (see sprintTickets). Status is its
// statusCell, wrapped at its column's width (ASS-326). The Ticket cell leads with a square in that step's
// progress-bar color, the deepest step's own when it has one (`steps` set its shade). Points and assignee come from the ticket; Agents
// lists its assignments from assignments.json (no Health since ASS-437: ai-feedback-short is the ticket screen's);
// Total Token Spend its tokenSpend, the ticket's chat's spend (ASS-35) on its first variation's row alone.
// The Ticket cell starts with the ticket's priority in three cells and a blank (ASS-454: priorityPrefix, bright
// magenta when set by hand — no Priority column, no 🪪); its text starts after that and five one-cell columns (ASS-259), each its
// glyph (GLYPHS: East Asian Width N, no emoji, bar c1's █, Ambiguous: one cell
// where the terminal draws ambiguous-width characters narrow, the default
// outside CJK locales, ASS-453) or a blank, side by side and one blank before
// the text, so it lines up down the grid: c1 █ (ASS-453; was ▮) in the step's
// progress-bar color; c2 the type, ✦ ✘ ⌕; c3 ☛ for a ticket worked by hand
// (ASS-166; who since when is the ticket screen's By hand, workedByHand); c4 ↯ for a
// fast-tracked one (ASS-83); c5 its ⦿ (sprintMark) — blue for a pending
// requirements change (ASS-78), else red waiting on the operator (ASS-430)
// (`marks.needed`, see ticketMarks, ASS-242), else dim grey going on with an
// assumption alone (`marks.assumed`, ASS-248), on every variation's row; then a
// two-cell column (ASS-456; c6's one-cell ⚉ before it): 🤖 while one or more agents
// work on the row's ticket and variation (its Agents; one 🤖 however many), else 💻
// while a script step runs on it (`scripts`: runsScript, the progress bar's and S
// floor's rule — not at its gate, not held, not on a past day), else two blanks; then a
// two-cell column, 💺 when the variation holds a planning or in-progress seat
// (ASS-357: `seats`, seatPlan's holders — the planner's, none on a past day),
// ⛅ instead for an in-progress seat on a GCP workstation (ASS-469: seatPlan's
// kinds, control's seats.json; 💺 then a VM seat). A
// paused variation's (is-paused) text starts "PAUSED " in blue; a ticket
// reassigned away from the operator's account (ASS-345: ticket:sync's
// reassigned, to another person or to nobody) "UNASSIGNED " in red in its
// place, on every variation's row: the reassignment says more. One its
// dependencies hold (its `hold`, ASS-355: control's own predicate), paused too
// or not, gets a second line (ASS-360; before it, "AWAITING" took PAUSED's
// place on the first): "↳ AWAITING <KEY> (<who>), <KEY>" in gold (ASS-364) (waitingOn, waitingWho),
// indented by the priority, icon and seat columns so the ↳ starts under the key — none
// on an UNASSIGNED row; an unheld row's cell stays one line. A variation at a
// step with shows-merge-train whose merge requests await one in another
// repository (mergeTrains, ASS-363) gets one more line, after any AWAITING
// one and indented as it is: "↳ AWAITING MERGE <repo> <key> → <repo> <key>"
// (awaitingMerge). iconKey says what each means, under the grid.
// An empty seat row (ASS-451, withEmptySeats) is one line: blanks where the priority and icon columns are, a dim 💺
// in the seat column, then "empty seat" in dim gray; every other cell blank.
function ticketRows(tickets, assignments, steps, collaborations = {}, marks = { needed: new Set() }, { holders = new Set(), kinds = new Map() } = {}, scripts = () => false) {
  const seatMark = id => (!holders.has(id) ? '  ' : kinds.get(id) === 'workstation' ? WS_SEAT : SEAT);
  return tickets.map(t => {
    if (isEmptySeat(t)) return [`${priorityPrefix(null)}${' '.repeat(5)}  ${dim(SEAT)} ${dim(gray(EMPTY_SEAT))}`, ...TABLE_HEADERS.slice(1).map(() => '')];
    // One line per assignment to this ticket and this row's variation (or to no
    // variation in particular).
    const agents = ticketAgents(assignments, t);
    const name = `${t.shownKey}: ${t.title}`;
    const icons = [
      t.step ? `${stateColor({ sequence: t.step.sequence, color: t.color }, steps)}${GLYPHS.step}\x1b[0m` : '',
      GLYPHS[t.kind] ?? '', workedByHand(t) ? GLYPHS.hand : '', t['fast-track'] === true ? GLYPHS.fast : '', sprintMark(marks, t),
    ];
    const working = agents.length ? GLYPHS.agent : scripts(t) ? GLYPHS.script : '  ';
    const lead = `${priorityPrefix(t['manual-priority'] ?? t.priority, t['manual-priority'] != null)}${icons.map(icon => icon || ' ').join('')}${working}${seatMark(`${t.key} ${t.variation.name}`)} `;
    const held = t.reassigned ? `${UNASSIGNED} ` : t.variation['is-paused'] === true ? `${PAUSED} ` : '';
    const line = `${lead}${held}${t.url ? link(name, t.url) : name}`;
    const waits = !t.reassigned && t.hold?.waits?.length ? t.hold.waits : null;
    const trains = mergeTrains(t);
    const under = [waits && waitingOn(waits, waitingWho(t)), trains.length && awaitingMerge(trains)].filter(Boolean).map(text => `${' '.repeat(visible(lead))}↳ ${text}`);
    return [
      under.length ? [line, ...under] : line,
      statusCell(t, steps),
      String(t.points ?? NONE),
      ...variationCells(t.variation),
      tokenSpend(t.variation, t.variation === t.variations?.[0] ? chatSpend(collaborations, t.key) : 0) ?? NONE,
      t['ticket-system-assignment'] ?? NONE,
      agentLines(agents),
    ];
  });
}

// A variation's Dev and Testing cells: a circle per acceptance criterion, Dev
// with "x/y automated tests" beneath when both counts are known (testCounts).
// (ASS-437: the Build and MR cells went to the ticket screen's Merge requests tab.)
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
  return [
    dev.length ? dev : NONE,
    circles('testing-status'),
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
  // day, as no robots (liveAssignments). ASS-416: runsScript, shared with S.
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
    scripts: list.filter(t => runsScript(state, t)).length }));
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
    const { grid, selected } = layout(state, size);
    const ticket = selected == null || isEmptySeat(grid[selected]) ? null : grid[selected];
    return ticket ? openTicket(state, { key: ticket.key, variation: ticket.variation.name }) : state;
  }
  if (step && !sideways && state.screen === 's' && state.focus === 'tickets') {
    const grid = layout(state, size);
    if (grid.selected == null) return { ...state, scroll: move(grid.ticketGrid, grid.scroll, grid.scroll, step)[1] };
    const [selected, scroll] = skipEmptySeats(grid, step);
    return { ...state, selected, scroll };
  }
}

// skipEmptySeats(layout, step) — [selected, scroll] after ↑/↓ (move): the next ticket row that way, past any empty
// seat rows (ASS-451: never selected), scrolled into view with them; none that way, the selection stays and the
// grid scrolls as far as that way goes, so empty seats at the grid's top or bottom still come into view.
function skipEmptySeats({ grid, ticketGrid, selected, scroll }, step) {
  let next = selected + step;
  while (next >= 0 && next < grid.length && isEmptySeat(grid[next])) next += step;
  if (next >= 0 && next < grid.length) return move(ticketGrid, selected, scroll, next - selected);
  const end = step < 0 ? 0 : grid.length - 1;
  return [selected, move(ticketGrid, selected, scroll, end - selected)[1]];
}
