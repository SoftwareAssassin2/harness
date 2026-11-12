// Helpers the screens share (ASS-201): used by two or more of src/tui/screens/,
// or by the frame every screen sizes against. Moved from app.js as they were.
import { sinceResolution, visitsInto, statusOf, changePath, isOpenQuestion, blocksTicket, markOff, switchOff, isHeld, isBlockedState, waitsOnHuman, isDoneStep } from '../../control/engine.js';
import { rankBacklog, flattenSprint } from '../../control/rank.js';
import { dependencyHold, dependencyRows } from '../../control/dependencies.js';
import { seatsOf } from '../../control/plan.js';
import { switchedOffStepErrors } from '../../workflow/validate.js';
import { stateOf, levelChanges, enginesOf, refinementSteps as refinementStepsOf } from '../status.js';
import { lastStart } from '../table.js';
import { visible, clip, link, wrapParts } from '../text.js';
import { humanGate } from '../ticket.js';

export const ellipsis = (text, width) => (visible(text) <= width ? text : `${clip(text, width - 1)}…`);

// Whether an assignment refines the backlog (ASS-18): an agent on a ticket of its project's backlog, no run (ASS-144).
export const refining = (state, a) => a['transient-state-engine'] == null && a['work-item'] != null && (state.projects.find(p => p.id === a.project)?.backlog ?? []).some(t => t.key === a['work-item']);

// The live sprint's ticket urls by key.
export const ticketUrls = state => new Map(Object.keys(ICONS).flatMap(type => state.projects[state.project]?.sprint?.[type] ?? []).map(t => [t.key, t.url]));
// A ticket key, linked to its url when the live sprint has one.
export const ticketLink = (text, url) => (url ? link(text, url) : text);

export const NONE = '—';
// A table cell: the value as text, or NONE when it has none.
export const cell = value => (value == null ? NONE : String(value));
// Agents and Health lines are cut at this width so long feedback cannot crowd
// out the leftmost column; on the sprint screen they also give up width below
// it to keep the Ticket column's floor (ASS-207, sprint.js).
const FEEDBACK_WIDTH = 40;
export const feedback = text => (text ? ellipsis(text, FEEDBACK_WIDTH) : NONE);
// An Agents cell: one "🤖 name - status update" line per assignment — its
// ai-status-update-short, the agent's own account of what it is doing — or
// "🤖 name" until it has one; cut like feedback.
export const agentLine = a => [`🤖 ${a['agent-name']}`, a['ai-status-update-short']].filter(Boolean).join(' - ');
export const agentLines = list => (list.length
  ? list.map(a => feedback(agentLine(a)))
  : NONE);
// The selected project's assignments.
export const projectAssignments = state => state.assignments.filter(a => a.project === state.projects[state.project]?.id);
// Assignments describe the current day only, so a past day shows none.
export const liveAssignments = state => (state.day ? [] : projectAssignments(state));
// The sprint on show: a past day's end-of-day snapshot, or the live sprint.json.
export const viewedSprint = state => {
  const project = state.projects[state.project];
  return state.day ? project.days[state.day] : project?.sprint;
};
// The lowercase keys of the selected project's tickets with a question
// waiting on the operator: open and blocking (blocksTicket — one with no flag
// counts, ASS-248). assuming: those with an open non-blocking one, gone on
// with on its assumption.
const keysOf = (state, which) => new Set((state.projects[state.project]?.questions ?? [])
  .filter(which).map(q => (q['asked-on-ticket'] ?? '').toLowerCase()));
export const asking = state => keysOf(state, blocksTicket);
const assuming = state => keysOf(state, q => isOpenQuestion(q) && q.blocking === false);

// The keys of the tickets waiting on the operator (ASS-171): a variation
// control does not hold (isHeld) that is in its engine's blocked state
// (isBlockedState) or waits on a human — a sprint ticket's at its gate here
// (humanGate: a human step, bar one it passes with a single variation, a held
// gate, a pending requirements change), a backlog ticket's in its refinement
// engine as control has it (waitsOnHuman) — or a ticket with an open
// blocking question (asking; a non-blocking one alone is ticketMarks' assumed). `tickets` are sprintTickets'. The Operator Needed Tickets tile
// counts them and the sprint and backlog screens mark them (needMark), so the
// two always agree (ASS-242) — but the tile counts only those of `tickets`,
// the sprint on show (the live sprint, or a past day's): a backlog ticket
// keeps its mark on the backlog screen and is never counted (ASS-254). A
// complete ticket — a variation at a step its engine marks is-done
// (isDoneStep), or a ticket-system status of Done — waits on no one, whatever
// its other variations or open questions (ASS-247). A project its
// credentials hold (ASS-395) adds one item, CREDENTIALS_ITEM, however many
// of its tickets that holds: the project waits on the operator once.
export const CREDENTIALS_ITEM = 'credentials';
export const operatorNeeded = (state, tickets = sprintTickets(state).tickets) => {
  const shown = new Set(tickets.map(t => t.key));
  const needed = new Set([...ticketMarks(state, tickets).needed].filter(key => shown.has(key)));
  return state.projects[state.project]?.credentialsHold ? needed.add(CREDENTIALS_ITEM) : needed;
};

// ticketMarks(state, tickets) — { needed, assumed }: `needed`, operatorNeeded's
// keys; `assumed`, the keys of the tickets, open and not held, whose only call
// on the operator is an open non-blocking question (ASS-248): work goes on, on
// its assumption, so the tile does not count them. needMark marks each.
export function ticketMarks(state, tickets = sprintTickets(state).tickets) {
  const engines = enginesOf(state.workflows), asked = asking(state), assumes = assuming(state);
  const own = engines[state.projects[state.project]?.stateEngine];
  const variations = [
    ...tickets.map(t => [t, t.variation, own, t.gate != null]),
    ...backlogTickets(state).flatMap(t => (t.variations ?? []).filter(v => !v['is-deleted']).map(v => {
      const engine = engines[v['harness-status']?.['state-engine']];
      return [t, v, engine, waitsOnHuman(engine, v, engines)];
    })),
  ];
  const complete = new Set(variations.filter(([t, v, engine]) => t['ticket-system-status'] === 'Done' || isDoneStep(engine, stateOf(v))).map(([t]) => t.key));
  const open = variations.filter(([t, v]) => !complete.has(t.key) && !isHeld(t, v));
  const needed = new Set(open.filter(([t, v, engine, waits]) => waits || isBlockedState(engine, stateOf(v)) || asked.has(t.key.toLowerCase())).map(([t]) => t.key));
  const assumed = new Set(open.filter(([t]) => !needed.has(t.key) && assumes.has(t.key.toLowerCase())).map(([t]) => t.key));
  return { needed, assumed };
}
// One small mark (a text glyph, never an emoji) before the title of a ticket:
// blue for one in `needed` (operatorNeeded), whatever the kinds it waits for
// (ASS-242); else dim grey, the same glyph, for one in `assumed` — going on
// with an assumption, never red, yellow or orange (ASS-248). markKind names
// which (null for none); markDot draws a glyph in its color. The backlog
// screen's is ● with a blank after it (needMark); the sprint screen's, its c5,
// ⦿ (sprintMark, ASS-259), red for a ticket with a pending requirements change
// to accept or reject (ASS-78), whatever else it waits on.
const MARK_COLORS = { needed: '34', assumed: '2;90', change: '31' };   // color(…) codes, written out: color is defined below
const markKind = ({ needed, assumed = new Set() }, key) => (needed.has(key) ? 'needed' : assumed.has(key) ? 'assumed' : null);
export const markDot = (glyph, kind) => `\x1b[${MARK_COLORS[kind]}m${glyph}\x1b[0m`;
export const needMark = (marks, key) => (markKind(marks, key) ? `${markDot('●', markKind(marks, key))} ` : '');
// The sprint row's one-cell glyphs (ASS-259): each East Asian Width N with no
// Emoji property, so every terminal draws it one cell wide — no emoji, no
// Ambiguous-width █ or ●, nothing needing VS16. The ticket screen, backlog and
// agent tiles keep ICONS.
export const GLYPHS = { step: '▮', features: '✦', bugs: '✘', spikes: '⌕', hand: '☛', fast: '↯', mark: '⦿', agent: '⚉' };
export const sprintMark = (marks, t) => {
  const kind = t['pending-requirements-change'] ? 'change' : markKind(marks, t.key);
  return kind ? markDot(GLYPHS.mark, kind) : '';
};
// What the marks mean, for the ? menu (ASS-248): the sprint's ⦿ in its three
// colors (the backlog's ● in its two), ⚉ and the row's other glyphs (ASS-259).
export const MARK_LEGEND = [
  `${markDot(GLYPHS.mark, 'needed')} needs you — counted on Operator Needed if a sprint ticket (backlog: ${markDot('●', 'needed')})`,
  `${markDot(GLYPHS.mark, 'assumed')} going on with an assumption — not counted (backlog: ${markDot('●', 'assumed')})`,
  `${markDot(GLYPHS.mark, 'change')} a requirements change waits to be accepted or rejected`,
  `${GLYPHS.agent} an agent is working on it`,
  `${GLYPHS.features} feature  ${GLYPHS.bugs} bug  ${GLYPHS.spikes} spike  ${GLYPHS.hand} worked by hand  ${GLYPHS.fast} fast-tracked`,
];

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// The icon left of each ticket name, by its list in sprint.json.
export const ICONS = { features: '✨', bugs: '🐞', spikes: '🔬' };

// One row up or down a grid: [selected, scroll]. It scrolls up to a selection
// above the view, or down just enough that it shows in full at the bottom;
// never past where the grid can scroll.
export function move({ rows, bodyHeight }, selected, scroll, step) {
  const next = clamp(selected + step, 0, Math.max(0, rows.length - 1));
  const top = Math.max(Math.min(scroll, next), lastStart(rows.slice(0, next + 1), bodyHeight));
  return [next, Math.min(top, lastStart(rows, bodyHeight))];
}

// backlogTickets(state) — the selected project's backlog (backlog.json, less
// the sprint's), in refinement order (rankBacklog).
export const backlogTickets = state => rankBacklog(state.projects[state.project]?.backlog ?? []);
// Where a backlog ticket's live variation stands in its refinement engine
// (ASS-144): statusOf, as a sprint ticket's status, resolved in the engine its
// harness-status names, so `state` is the step's id and `step` that engine's
// step. refinementName shows it as the sprint's Status does (statusText): the
// step's name from the engine JSON, its id when that engine has no such step
// (ASS-150) — the TUI names no refinement step itself.
export const refinementOf = (state, t) => statusOf(enginesOf(state.workflows), undefined, t.variations?.find(v => !v['is-deleted']));
export const refinementName = status => status.step?.name ?? status.state;

// A backlog ticket's priority as the backlog screens show it: the operator's
// manual-backlog-priority (ASS-100) with 🪪, else the priority control gave it
// (ticket:renumber-backlog, ASS-84) — its place in the list.
export const backlogPriority = t => (t['manual-backlog-priority'] != null ? `${t['manual-backlog-priority']} 🪪` : String(t.priority ?? NONE));

// "847d 16h", "23h 21m" or "13m": the time since `start`, in its two largest units.
export function since(start, now) {
  const minutes = Math.floor((now - Date.parse(start)) / 60000);
  const [days, hours, mins] = [Math.floor(minutes / 1440), Math.floor(minutes / 60) % 24, minutes % 60];
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`;
}

// "2026-10-08 00:13:53 UTC (10h 5m ago)": when a session log was last written
// (ms), to the second, and the time since then (see since).
export const written = (ms, now) => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC (${since(new Date(ms).toISOString(), now)} ago)`;

export const indent = (width, columns) => ' '.repeat(Math.max(0, Math.floor((columns - width) / 2)));
export const center = (text, columns) => indent(visible(text), columns) + text;
// `text` centered in exactly `width` columns.
export const middle = (text, width) => {
  const left = Math.floor((width - visible(text)) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - visible(text) - left);
};
export const color = code => text => `\x1b[${code}m${text}\x1b[0m`;
export const green = color('32');
export const red = color('31');
export const gold = color('38;2;255;215;0');
export const gray = color('90');

// "Thu Oct 1 @ 4:04 PM UTC"
export function timestamp(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.weekday} ${p.month} ${p.day} @ ${p.hour}:${p.minute} ${p.dayPeriod} UTC`;
}

// What the flowchart can show under each station, in the order offered.
const FLOWCHART_VIEWS = [['tickets', 'Tickets'], ['metrics', 'Run-time metrics']];

// ←/→ on a flowchart screen's choice of what each station shows (S and B):
// `field` the state field the choice is kept in.
export function chooseView(state, field, step) {
  const at = clamp(FLOWCHART_VIEWS.findIndex(([id]) => id === state[field]) + step, 0, FLOWCHART_VIEWS.length - 1);
  return { ...state, [field]: FLOWCHART_VIEWS[at][0] };
}

// The flowchart screens' head (S and B): the choice of what each station shows
// (FLOWCHART_VIEWS), `view` marked — reversed while `focused` — and the keys'
// hint, which says how to scroll the floor focused or not (ASS-263).
export function viewChoice(view, focused) {
  const views = FLOWCHART_VIEWS.map(([id, label]) => (id !== view ? ` ${label} ` : `${focused ? '\x1b[7m' : '\x1b[4m'} ${label} \x1b[0m`));
  return [`Show:   ${views.join('   ')}`, `${focused ? '←/→ choose' : 'tab to choose'} what each station shows   ↑/↓ scroll   PgUp/PgDn Home/End`, ''];
}

// engineOf(state, project) — a loaded project's execution engine as the
// dashboard holds it (load.js loadWorkflows): its own of that name first
// (ASS-277), else engines/'s.
const engineOf = (state, project) => state.workflows.find(w => w.name === project?.stateEngine && w.project === project?.id)
  ?? state.workflows.find(w => w.name === project?.stateEngine && w.project == null)
  ?? state.workflows.find(w => w.name === project?.stateEngine);

// holdingOf(state) — what control's dependencyHold and dependencyRows
// (ASS-195, ASS-355) take of the selected project, as control builds it
// (dependencies.js holdingOf): its flag (only on the live sprint), engine and
// the engines beneath it, sprint, backlog and outside-tickets.json, and every
// other project's engine, sprint and backlog.
export function holdingOf(state) {
  const project = state.projects[state.project];
  return {
    on: !state.day && project?.waitForDependencies === true,
    engine: engineOf(state, project), engines: enginesOf(state.workflows),
    tickets: flattenSprint(project?.sprint ?? {}), backlog: project?.backlog ?? [], outside: project?.outside ?? [],
    elsewhere: state.projects.filter(p => p.id !== project?.id).map(p => ({ id: p.id, engine: engineOf(state, p), tickets: flattenSprint(p.sprint ?? {}), backlog: p.backlog ?? [] })),
  };
}

// The sprint work on show (see viewedSprint), one entry per ticket variation: the
// ticket's fields with its type icon, the variation, the key to show (KEY.NAME
// when the ticket has several variations, else KEY), its status (statusOf,
// every level resolved in the loaded engines) and the execution state
// engine step the variation's harness-status state names, `color` the
// deepest step's of its status that has one (ASS-67), `gate` what a human
// must do before it moves on (humanGate), `hold` what it waits for of the
// tickets it depends on (ASS-195, ASS-355: dependencyHold — control's own
// predicate, so the Status cell and control never disagree; only on the live
// sprint of a project with wait-for-dependencies) and `dependencyRows` each
// dependency with where it is, its status and assignee (dependencyRows,
// ASS-355). Closest to done first (highest step
// sequence, then the detailed step's within it, level by level), then by
// priority; and that engine's steps.
export function sprintTickets(state) {
  const project = state.projects[state.project];
  const engine = engineOf(state, project);
  const steps = engine?.steps ?? [];
  const engines = enginesOf(state.workflows);
  const holding = holdingOf(state);
  const tickets = Object.entries(ICONS)
    .flatMap(([type, icon]) => (viewedSprint(state)?.[type] ?? []).flatMap(t => {
      const variations = t.variations?.length ? t.variations : [{}];
      return variations.map((variation, i) => {
        const status = statusOf(engines, project?.stateEngine ?? '', variation);
        const ticket = {
          ...t,
          icon,
          kind: type,   // its list in sprint.json, for the sprint row's GLYPHS (ASS-259)
          variation,
          shownKey: variations.length > 1 ? `${t.key}.${variation.name ?? String.fromCharCode(65 + i)}` : t.key,
          status,
          step: status.step,
          color: status.chain.findLast(l => l.step?.color)?.step.color,
        };
        return { ...ticket, gate: humanGate(ticket, steps, { engines, runs: state.transientEngines ?? [], project: project?.id }), hold: dependencyHold(holding, t, variation), dependencyRows: dependencyRows(holding, t) };
      });
    }))
    .toSorted((a, b) => further(a, b) || (a.priority ?? Infinity) - (b.priority ?? Infinity) || 0);
  return { tickets, steps, done: Math.max(1, ...steps.map(s => s.sequence)) };
}

// seatHolders(state) — the "<key> <variation>" of the selected project's
// sprint variations holding a planning or an in-progress seat (ASS-357): the
// planner's own answer (control/plan.js seatsOf, its in-planning and
// in-progress; not over-the-limits), asked of the dashboard's state laid out
// as control's loadState has it (planProject), so a row's seat and control's
// never disagree. Empty on a past day: seats are live state, as assignments
// are (liveAssignments). The one thing control knows that the dashboard does
// not is its running agents' spend so far (ASS-270), so spending limits count
// the recorded spend alone.
export function seatHolders(state) {
  const selected = state.projects[state.project];
  if (state.day || !selected) return new Set();
  const projects = state.projects.map(p => planProject(state, p));
  const plan = {
    projects, allProjects: projects, assignments: state.assignments ?? [], harness: selected.limits?.harness ?? {}, running: {},
    engines: enginesOf(state.workflows.filter(w => w.project == null)),
  };
  const seats = seatsOf(plan, projects[state.project]);
  return new Set([...seats['in-progress'], ...seats['in-planning']]);
}

// planProject(state, p) — a dashboard project as control's loadState lists it,
// what its planner reads: id, json (the limits of its project.json the
// dashboard loads), engines (engines/'s with its own over them, ASS-276, its
// valid switched-off-steps switched off, ASS-209 — as loadState switches them),
// engine (its execution engine), tickets (its live sprint's, flattenSprint),
// asking (those of them, not Done, an open blocking question in their own
// questions-and-answers.json holds, as loadState's openBlocking, ASS-248), and
// what control's heldBy reads to skip a variation its dependencies hold
// (ASS-355): json's wait-for-dependencies, backlog and outside — the same
// loaded data holdingOf gives dependencyHold, so a held row has no 💺.
function planProject(state, p) {
  const seen = enginesOf(state.workflows.filter(w => w.project == null || w.project === p.id).toReversed());   // its own listed first: last wins
  const engines = switchOff(seen, (p.switchedOffSteps ?? []).filter(e => !switchedOffStepErrors(e, seen).length));
  const tickets = flattenSprint(p.sprint ?? {});
  const asking = new Set(tickets.filter(t => t['ticket-system-status'] !== 'Done' && (p.questions ?? []).some(q => q.source === t.key && blocksTicket(q))).map(t => t.key));
  const json = { ...p.limits?.project, ...(p.waitForDependencies === true ? { 'wait-for-dependencies': true } : {}) };
  return { id: p.id, json, engines, engine: engines[p.stateEngine], tickets, backlog: p.backlog ?? [], outside: p.outside ?? [], asking };
}

// Which of two sprint tickets is closer to done: the higher step sequence at
// the first level of their status where they differ (none, -1), as a sort
// comparator — so a group's tickets order by their detailed steps.
function further(a, b) {
  const sequences = t => (t.status.chain.length ? t.status.chain : [{}]).map(l => l.step?.sequence ?? -1);
  const [x, y] = [sequences(a), sequences(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (y[i] ?? -1) - (x[i] ?? -1);
  return 0;
}

// A ticket variation's Status: its step's name and stateStats, then each
// sub-status's ("Local Testing (1, 1) › Take Screenshots (1, 1)"), named from
// its own state engine (the ticket's status, see sprintTickets); a state no
// engine names shows as its id. `steps` are the project's engine's. Then what
// it waits for of the tickets it depends on (ASS-195, ASS-355, its `hold`):
// "Build — waits on ASS-180, ASS-181", in dependency order; or, with
// none holding it, the keys it cannot wait for and why — "Committed — ignores
// ASS-9 (unknown)". Nothing when it waits for nothing. One line: the ticket
// screen's Status field; the sprint grid wraps it (statusCell, ASS-326).
export const statusText = (t, steps) => {
  const { chain, hold } = statusParts(t, steps);
  return [chain.join(' › ') || NONE, t.status?.planned && PLANNED, hold && `${hold.lead} ${hold.items.join(', ')}`].filter(Boolean).join(' — ');
};

// What a Status adds for a variation whose plan is finished (ASS-362: control's
// statusOf `planned`): it holds no seat — no 💺 on its row — and only waits for
// an in-progress one to move on to Build.
export const PLANNED = 'Planned, waiting for a build seat';

// The width a sprint grid's Status wraps at (ASS-326): one ticket waiting on 9
// others made its one-line Status ~115 wide, and since a column is as wide as
// its widest cell over every row, the grid ran off the screen, cutting off
// Health and Agents.
export const STATUS_WRAP = 40;

// statusCell(t, steps) — the sprint grid's Status cell (ASS-326): a function of
// its column's width (boxTable lays it out once that is known) giving the
// lines. The step chain, wrapped between its " › " parts; under it PLANNED for a
// finished plan (ASS-362); under that, on lines
// of its own wrapped between keys, the dependencies it ignores — never what it
// waits on (ASS-360: the Ticket cell's "↳ AWAITING" line (ASS-364) under the title says
// that, sprint.js ticketRows; statusText still does); each at the narrower of the column
// and STATUS_WRAP, continuation lines indented (wrapParts). A part wider than
// STATUS_WRAP keeps its line whole, so the column is never narrower than its
// longest step; only a column narrower than that (Status giving up width after
// Health and Agents, sprint.js SHRINK) splits it — nothing is cut with "…".
export const statusCell = (t, steps) => {
  const { chain, hold } = statusParts(t, steps);
  const comma = items => items.map((item, i) => (i < items.length - 1 ? `${item},` : item));
  const sets = [
    chain.length ? chain.map((part, i) => (i < chain.length - 1 ? `${part} ›` : part)) : [NONE],
    ...(t.status?.planned ? [[PLANNED]] : []),
    ...(hold?.lead === 'ignores' ? [comma(hold.items).map((item, i) => (i ? item : `${hold.lead} ${item}`))] : []),
  ];
  return width => sets.flatMap(parts => wrapParts(parts, Math.min(width, STATUS_WRAP), width));
};

// statusParts(t, steps) — a Status in parts: `chain`, each level's "name
// (stats)", and `hold` — { lead: 'waits on' | 'ignores', items } — or null.
function statusParts(t, steps) {
  const chain = t.status.chain.map((at, i, all) => [
    at.step?.name ?? at.state,
    stateStats(t.variation, at.state, all.slice(0, i).map(c => c.state), steps, at.step),
  ].filter(Boolean).join(' '));
  return { chain, hold: holdParts(t.hold) };
}

// holdParts(hold) — what a Status says of a dependencyHold: the keys holding
// the variation, or — none holding it — the ones it ignores, each with why;
// null for neither.
const holdParts = hold => (hold?.waits?.length ? { lead: 'waits on', items: hold.waits }
  : hold?.ignores?.length ? { lead: 'ignores', items: hold.ignores.map(i => `${i.key} (${i.why})`) }
  : null);
// The assignments to a ticket and its variation (or to no variation in particular).
export const ticketAgents = (assignments, t) => assignments.filter(a => a['work-item'] === t.key && (a.variation == null || a.variation === t.variation.name));

// What a ticket's chat has cost (ASS-35): the cost-usd of its collaboration.json's turns (ASS-216), from a project's collaborations; 0 for none.
export const chatSpend = (collaborations, key) => (collaborations?.[key]?.turns ?? []).reduce((sum, turn) => sum + (turn['cost-usd'] ?? 0), 0);

// The workflows as the selected project runs them: engines/'s and its own (ASS-277: another project's own left out, its own
// ahead, as load.js loadWorkflows orders them), the steps its project.json's switched-off-steps lists switched off (markOff, ASS-209).
export const projectWorkflows = state => {
  const id = state.projects[state.project]?.id;
  const others = w => w.project != null && w.project !== id;
  const seen = state.workflows.some(others) ? state.workflows.filter(w => !others(w)) : state.workflows;
  const off = state.projects[state.project]?.switchedOffSteps ?? [];
  return off.length ? seen.map(w => ({ ...w, steps: markOff(w.name, w.steps ?? [], off) })) : seen;
};

// The steps of the engine the selected project's backlog tickets are refined through (status.js refinementSteps).
export const refinementSteps = state => refinementStepsOf(projectWorkflows(state), state.projects[state.project]?.stateEngine);

// A repository's name: its url's last segment.
export const repoName = url => url.split('/').filter(Boolean).at(-1);

// "(times in `status`, agents dispatched since it last arrived)" for a
// variation, from its state-changes at the level under `parents` (see
// levelChanges); null without state-changes. Visits are control's
// (visitsInto), counted since a human last resolved Blocked for Human in the
// project's `steps` (sinceResolution): the counts control caps. Beneath the
// top level they count within the sub-engine's run, from its latest entry on
// (ASS-66). A state-engine `step`'s dispatches are the sub-engine runs
// started from it since it last arrived (ASS-67): its entries, never its
// children's agents, which they show for themselves.
export function stateStats(v, status = stateOf(v), parents = [], steps = [], step) {
  if (!v['state-changes']) return null;
  const counted = sinceResolution({ steps }, v['state-changes']);
  const level = levelChanges({ ...v, 'state-changes': counted }, parents);
  const changes = parents.length ? level.slice(Math.max(0, level.findLastIndex(c => c['from-state'] == null))) : level;
  const arrivals = changes.filter(c => c['to-state'] === status);
  // An entry into a sub-engine comes from no state: no visit before it.
  return `(${visitsInto(changes, status, changes.length ? undefined : status)}, ${step?.action?.type === 'state-engine' ? runsStarted(counted, parents, status) : arrivals.at(-1)?.['agent-dispatch-log']?.length ?? 0})`;
}

// The sub-engine runs started from `state` at the level under `parents`
// since it last arrived there: the changes entering its sub-engine (one level
// down, from no state).
function runsStarted(changes, parents, state) {
  const depth = parents.length;
  let started = 0;
  for (const change of changes) {
    const path = changePath(change);
    if (path.length < depth + 1 || parents.some((s, i) => path[i]['to-state'] !== s) || path[depth]['to-state'] !== state) continue;
    if (path.length === depth + 1) started = 0;                     // arrived (again)
    else if (path.length === depth + 2 && path[depth + 1]['from-state'] == null) started++;
  }
  return started;
}
