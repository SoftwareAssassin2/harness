// The dashboard's logic, free of I/O: state, key handling and rendering are
// pure functions, so the whole UI is testable without a terminal. main.js is
// the thin shell that wires them to stdin/stdout.
// Each screen's view and keys live in its own module under screens/ (ASS-201);
// this keeps the shared state, the routing between screens and the layout.
import { boxRow } from './boxes.js';
import { memoryOpened, confirmMemory } from './memory.js';
import { featureOn } from './features.js';
import { visible, clip, from, pad, markWords } from './text.js';
import { PAUSABLE, updatedOf, headerLines, platform, holding } from './screens/frame.js';
import { viewLog } from './screens/log.js';
import { refining, projectAssignments, clamp, written, center, gray, MARK_LEGEND } from './screens/shared.js';
import * as sprint from './screens/sprint.js';
import * as sprintFlow from './screens/sprint-flow.js';
import * as backlog from './screens/backlog.js';
import * as backlogFlow from './screens/backlog-flow.js';
import * as control from './screens/control.js';
import * as subflows from './screens/subflows.js';
import * as mergeRequests from './screens/merge-requests.js';
import * as repos from './screens/repos.js';
import * as updates from './screens/updates.js';
import * as agents from './screens/agents.js';
import * as chat from './screens/chat.js';
import * as memory from './screens/memory.js';
import * as ticket from './screens/ticket.js';

// Screen keys, in menu order (ASS-23): each list beside its flow — s and S
// the sprint and its flow (ASS-103), b and B the backlog and its flow. The
// project and options screens, never built, are gone (ASS-262).
const SCREENS = {
  s: 'sprint', S: 'sprint flow', b: 'backlog', B: 'backlog flow', c: 'control', f: 'sub-flows',
  m: 'merge requests', r: 'repos', u: 'updates', a: 'agents', x: 'chat', h: 'memory',
  A: 'agents for all projects',   // every project's agents (ASS-188), beside a (ASS-246), apart from the rest in the menu
};
// The screen key a keypress names: its sequence, so S is told from s; its name when it has none.
const screenKey = key => (key.sequence?.length === 1 ? key.sequence : key.name);
// The screens behind a feature flag (ASS-262, see features.js), by key: one
// whose flag is off is in no menu, and its key does nothing.
const FLAGGED = { x: 'chat-screen' };
const shown = (state, k) => Object.hasOwn(SCREENS, k) && (!FLAGGED[k] || featureOn(state, FLAGGED[k]));

// Each screen's module (ASS-201) by its key: view(state, size), its body's lines,
// and onKey(state, key, size, { step, sideways }), the next state or undefined
// to fall through to the screen keys.
const SCREEN_MODULES = { s: sprint, S: sprintFlow, b: backlog, B: backlogFlow, c: control, f: subflows, m: mergeRequests, r: repos, u: updates, a: agents, x: chat, h: memory, A: agents };

// Which of the selected project's agents a screen key counts in the menu:
// agents refining the backlog beside b; the other agents on tickets beside s,
// on transient state engines beside f; on merge requests beside m, on
// repositories beside r, checking on agents beside a.
const COUNTED = {
  s: (s, a) => a['work-item'] && !refining(s, a), b: refining, f: (s, a) => a['transient-state-engine'] && !refining(s, a),
  m: (s, a) => a['merge-request'], r: (s, a) => a.repo, a: (s, a) => a.agent,
};
// The ? menu's entries (ASS-183), [key, label, count]: the screens, with the
// selected project's agents beside the keys in COUNTED, then — a blank line
// apart, as it is about every project rather than the selected one (ASS-188) —
// `A`, then, where they work, what space and ! do to the human's pause, then
// what / does to the project menu.
function menuEntries(state) {
  const { name, mine, everyone } = holding(state);
  return [
    ...Object.entries(SCREENS).filter(([k]) => k !== 'A' && shown(state, k)).map(([k, label]) => [k, label, COUNTED[k] ? `🤖x${projectAssignments(state).filter(a => COUNTED[k](state, a)).length}` : '']),
    ['', '', ''], ['A', SCREENS.A, ''],
    ...(PAUSABLE.has(state.screen) ? [['space', `${mine ? 'release' : 'pause'} ${name}`, ''], ['!', `${everyone ? 'release' : 'pause'} every project`, '']] : []),
    ['/', `${state.menuHidden ? 'show' : 'hide'} project menu`, ''], ['Q', 'quit', ''],
  ];
}
// The menu key a keypress names: space by its name, the rest as screen keys.
const menuKey = key => (key.name === 'space' ? 'space' : screenKey(key));
// The menu keys that stand in a group of their own (ASS-188): written out as
// one phrase rather than lined up in the other entries' columns.
const APART = new Set(['A']);
// The ? menu drawn: a box, an entry a line, its columns lined up; under them,
// a blank line apart, what the ticket marks mean (MARK_LEGEND, ASS-248).
function menuBox(state, columns) {
  const entries = menuEntries(state);
  const lined = entries.filter(([k]) => !APART.has(k));
  const widths = [0, 1].map(i => Math.max(...lined.map(e => visible(e[i]))));
  return boxRow([[...entries.map(([k, label, count]) => (APART.has(k) ? `${k} ${label}` : `${pad(k, widths[0])}  ${pad(label, widths[1])}  ${count}`)), '', ...MARK_LEGEND]], columns);
}
// The bottom line: the ? menu's hint, a restart's drain (ASS-200), or the shut-down under way.
const legend = state => {
  if (state.quitting) return `${state.restart ? 'restarting' : 'shutting down'}: stopping control, the downloader and every agent — ctrl-c forces it`;
  const n = Object.values(state.draining).reduce((sum, count) => sum + count, 0);
  if (n) return `restarting: waiting for ${n} agent${n === 1 ? ' to end its turn' : 's to end their turns'}`;
  return state.restart ? 'restarting: waiting for every control to exit' : 'press ? for menu';
};

// The past days that can be viewed: the snapshots inside the active sprint, oldest first.
const pastDays = project => Object.keys(project?.days ?? {})
  .filter(date => project.sprint && date >= project.sprint.start && date <= project.sprint.end)
  .toSorted();

// projects: [{ id (its data/projects/ folder), name, stateEngine, sprint: sprint.json | null,
//   days: { 'YYYY-MM-DD': end-of-day sprint snapshot } }].
// assignments: from assignments.json; each names its project by folder.
// focus: the component the arrow keys move — 'menu', 'day', 'tickets', 'repos', 'agents', 'updates' or 'flowchart'.
// day: the past day on show ('YYYY-MM-DD'), or null for the current day.
// selected / repoSelected / agentSelected: each grid's selected row; scroll /
// repoScroll / agentScroll: the first one shown. The dashboard's selected and
// scroll are null until the operator moves the grid (gridAt places it).
// workflows: [{ name, steps }], one per state engine, by its engines/ folder.
// assignments, pauses: from assignments.json; pauses holds a human's pause
// (`human`, which space holds and releases) and an AI's (`ai`: { reason, eta }),
// each only while it holds. selfHealing: the self-healing fixes under way, by
// fix ticket — each { since, summary, ticket, ticket-url, project, paused } —
// {} for none; the banner says SELF HEALING in place of PAUSED BY AI on the
// projects a fix holds. transientEngines: its transient-state-engines,
// the workflows control has running on the side — each { id, project,
// state-engine, state, start-time } — which the control screen draws.
// draft: the answer form being filled in — { field (the one being edited),
// answer, why-this-answer, scope } — or null. submit: a filled-in form to save,
// which main.js hands the agent-cli and clears. message: what the last save said.
// controlLog: the controls' latest output, [{ text, stream, at, project }] —
// project the control's (one per project, ASS-9), none for the downloader's
// and the dashboard's own — kept by main.js; controlLogFiles: each project's
// control's log file, by project (controlLogFile: a single control's).
// flowchartView: what the flowchart shows under each station, 'tickets' or
// 'metrics' (see FLOWCHART_VIEWS); flowchartScroll: its first line shown.
// backlogFlowScroll: the backlog flow's first line shown, its own;
// backlogFlowView: what its stations show, as flowchartView, its own choice.
// updatesSince: the moment the updates screen lists progress since (ms), or
// ticket: the ticket open on the dashboard's ticket screen — { key, variation
// (its name) } — or null; priorityDraft:
// the manual priority being typed for it, or null; reasonDraft: the reason a
// backlog ticket is rejected for being typed, or null; returnDraft: the step a
// Human Review rejection goes back to being chosen — { reason, at } (ASS-228) — or null; gatesDraft: the states it
// is being gated on leaving — { ids checked, at (the step the cursor is on) } — or null.
// Across its tabs (ASS-184, see ticketView): ticketTab, the tab open (TABS);
// ticketScroll, ticketHistoryScroll and ticketQuestionsScroll, the first line
// shown of the details, the history and the questions, each its tab's own;
// ticketStatesScroll, the states' beside the history — null for the state it
// is in to be centred; ticketQuestionSelected, the question
// enter answers; ticketChoice, the human action selected; decide, a choice to
// record — the agent-cli command and its
// arguments — which main.js runs and clears; ticketMessage, what recording the last one said.
// demoRun: the Demo action asked for (ASS-76) — vm:demo and its arguments —
// which main.js runs and clears; demos: how each one went, by
// "<KEY>.<variation>" — { status: starting, ready or failed, message }.
// null; updatesForm: its date and time being set — { field, date, time } — or
// null; updatesScroll: its first line shown; updatesMessage: what is wrong.
// sessionWritten: when each agent's session log was last written (ms), by
// agent-name, which main.js reads; an agent without one is not in it.
// The agents screens (a and *, ASS-188): agentsGrid, how many tiles the grid
// holds — { agentsGridColumns, agentsGridRows }, from harness.json (load.js
// loadHarness); agentsTable, whether t swapped the grid for the old table;
// agentPage, the page of tiles on show, and agentTile, the focused tile on it;
// sessionTails, the last lines of every tiled agent's session log, by its
// agent-name or chat id, which main.js reads; usage, each one's usage.json
// (ASS-190: its context in use and spend so far) keyed the same way, which
// main.js reads; pending, by agent-name, { texts, notRead } — texts the TUI
// sent that have not reached that agent's log yet (the tile's `queued` mark)
// and whether an unread send has been stranded (the sticky `not read` mark),
// see screens/agents.js settlePending (ASS-189).
// agent: the agent whose session log is open on the agents screen — { name,
// start (its start-time) } — or null; agentLog: that log's lines, which main.js
// reads, or null when it has none; agentLogScroll: its first line shown, or
// null to follow its end; agentDraft, agentCursor: the prompt being typed and
// where in it the cursor sits (code points, ASS-41), each keyed by agent name
// (ASS-189) — the tile input and the zoom share one draft per agent;
// agentTyping: whether a focused tile has its one-row input open (ASS-189);
// keyTail: a prompt's modifyOtherKeys shift+enter being gathered, or null (ASS-43);
// agentPrompt: one to send — the agent-cli command and its arguments — which
// main.js runs and clears; agentMessage: what sending the last one said;
// agentEvents: whether the log shows its JSON event lines. quitting: Q was
// pressed, so main.js is shutting everything down (see src/tui/shutdown.js);
// restart: a control asked for a restart, so it then exits with 75 (see
// controlExited). controlsDown: each control that has ended on its own, by
// project — { code, line (the one it logged before its exit line) }.
// menuOpen: the ? menu (ASS-183) is drawn over the screen.
// chats: chats.json's chats (ASS-33), every project's; chatsRunning: the ids
// whose agent runs; chatsWritten: when each one's log was last written (ms),
// by id — both from main.js; chatSelected, chatScroll: the chat list's
// selection (0 is + New chat) and first row shown; chat: the chat open —
// { id }, null for one not yet made — or null; chatLog, chatLogScroll,
// chatDraft, chatCursor, chatMessage, chatEvents: its log and prompt, as the agent's;
// features: the feature flags (ASS-262), features.json's, which main.js reads
// once at start — none given, every flag off (see features.js featureOn);
// chatSend: a message to send — { project, id (null: make the chat first),
// text } — and chatDelete: a chat id to delete, which main.js runs and
// clears; chatConfirm: the chat whose deletion is being asked about, or null.
// ticketConfirm: the ticket screen's action being asked about before it is
// recorded (ASS-131: Block this ticket; ASS-104: Delete ticket) — { decision,
// decide, closes } — or null; decideCloses: whether `decide`, once it has run
// without error, closes the ticket screen (see decided).
// The ticket screen's chat (ASS-35, its Chat tab: see ticketView): ticketChatOpen, the ticket
// whose screen opened — { project, key } — for main.js to start or catch up its
// chat; ticketChatLog, its log, which main.js reads; ticketChatScroll,
// ticketChatDraft, ticketChatCursor, ticketChatMessage, as the agent's; ticketChatSend, a message
// to send — { project, key, text } — which main.js runs and clears.
export const initialState = ({ projects = [], workflows = [], assignments = [], transientEngines = [], pauses = {}, selfHealing = {}, menuHidden = false, chats = [], chatsRunning = [], chatsWritten = {}, agentsGrid = agents.AGENTS_GRID, features = {} } = {}) => ({
  screen: 's', features, projects, project: 0, focus: menuHidden ? 'day' : 'menu', menuHidden, day: null,
  selected: null, scroll: null, repoSelected: 0, repoScroll: 0, workflows, assignments, transientEngines, pauses, selfHealing, quit: false,
  draft: null, submit: null, message: '',
  controlLog: [], flowchartView: 'metrics', flowchartScroll: 0, backlogFlowScroll: 0, backlogFlowView: 'tickets',
  updatesSince: null, updatesForm: null, updatesScroll: 0, updatesMessage: '',
  ticket: null, ...ticket.OPENED_TICKET, priorityDraft: null, reasonDraft: null, returnDraft: null, gatesDraft: null, decide: null, decideCloses: false, demoRun: null, demos: {},
  backlogSelected: 0, backlogScroll: 0, subflowStart: 0, subflowScroll: 0, agentSelected: 0, agentScroll: 0, agentsGrid, agentsTable: false, agentPage: 0, agentTile: 0, sessionWritten: {}, sessionTails: {}, pending: {}, agent: null, agentLog: null, agentLogScroll: null, agentDraft: {}, agentCursor: {}, agentTyping: false, keyTail: null, agentPrompt: null, agentMessage: '', agentEvents: false, quitting: false, restart: false, draining: {}, controlsDown: {}, menuOpen: false,
  chats, chatsRunning, chatsWritten, chatSelected: 0, chatScroll: 0, chat: null, chatLog: null, chatLogScroll: null, chatDraft: '', chatCursor: 0, chatMessage: '', chatEvents: false, chatSend: null, chatDelete: null, chatConfirm: null,
  memories: {}, memorySelected: 0, memoryScroll: 0, memoryConfirm: null, memoryDelete: null, memoryLoad: null, memoryMessage: '',
  ticketConfirm: null, ticketChatOpen: null, ticketChatLog: null, ticketChatScroll: null, ticketChatDraft: '', ticketChatCursor: 0, ticketChatMessage: '', ticketChatSend: null,
});

// The components tab cycles through, in order: the project menu unless it is
// hidden, the day, the ticket grid only on the
// dashboard, the repository grid only on the repos screen, the agents grid
// on the agents screen (a) and the all-projects screen (*, ASS-188), the view choice only on the flowchart.
const focusable = state => [
  ...(state.menuHidden ? [] : ['menu']), 'day',
  ...(state.screen === 's' ? ['tickets'] : []),
  ...(state.screen === 'r' ? ['repos'] : []),
  ...(state.screen === 'a' || state.screen === 'A' ? ['agents'] : []),
  ...(state.screen === 'b' ? ['backlog'] : []),
  ...(state.screen === 'u' ? ['updates'] : []),
  ...(state.screen === 'S' ? ['flowchart'] : []),
  ...(state.screen === 'B' ? ['backlogflow'] : []),
  ...(state.screen === 'f' ? ['subflows'] : []),
  ...(state.screen === 'x' ? ['chats'] : []),
  ...(state.screen === 'h' ? ['memories'] : []),
];

// handleKey(state, key, { columns, rows }) — `key` is a node:readline keypress
// ({ name, ctrl, shift }). Tab moves the focus, shift-tab back; the arrow keys move only the focused
// component. The screen size decides when a grid must scroll to keep its
// selected row in view.
export function handleKey(state, key, size = {}) {
  if (key.ctrl && key.name === 'c') return { ...state, quit: true };
  if (state.quitting) return state;   // shutting down: nothing else to do
  // The ? menu open: ? or esc closes it; a menu key closes it and does its action; any other key does nothing.
  if (state.menuOpen) {
    if (key.sequence === '?' || key.name === 'escape') return { ...state, menuOpen: false };
    return !key.ctrl && menuEntries(state).some(([k]) => k === menuKey(key)) ? handleKey({ ...state, menuOpen: false }, key, size) : state;
  }
  if (state.draft != null) return ticket.editAnswer(state, key);
  if (state.updatesForm) return updates.editUpdates(state, key);
  if (state.agent != null) return viewLog(state, key, size, agents.AGENT_LOG);   // its keys are a prompt's text, space too, and ←/→ move its cursor rather than a component (ASS-41)
  if (state.chat != null) return viewLog(state, key, size, chat.CHAT_LOG);
  if (state.agentTyping) {
    const own = agents.typeKey(state, key, size);
    if (own !== undefined) return own;   // typing's text keys; nav keys drop through below with typing off (ASS-189)
    state = { ...state, agentTyping: false };
  }
  if (state.chatConfirm != null) return chat.confirmDelete(state, key);
  if (state.memoryConfirm != null) return confirmMemory(state, key);
  if (state.ticketConfirm != null) return ticket.confirmTicket(state, key);
  if (state.priorityDraft != null) return ticket.editPriority(state, key);
  if (state.reasonDraft != null) return ticket.editReason(state, key, size);
  if (state.returnDraft != null) return ticket.editReturn(state, key, size);
  if (state.gatesDraft != null) return ticket.editGates(state, key, size);
  if (state.ticket != null && state.ticketTab === 'chat') return ticket.viewTicketChat(state, key, size);   // its keys are text, as a chat's
  // ? (not while typing: it is text there) opens the menu, drawn over the screen (ASS-183).
  if (key.sequence === '?' && !key.ctrl) return { ...state, menuOpen: true };
  // Q (not while typing: it is text there) shuts down, on the control screen, where it is logged.
  if (key.sequence === 'Q' && !key.ctrl) {
    const next = { ...state, quitting: true, screen: 'c', ticket: null };
    return { ...next, focus: focusable(next).includes(state.focus) ? state.focus : focusable(next)[0] };
  }
  // / hides the project menu, or shows it again; hidden, it gives up the focus.
  if (key.sequence === '/' && !key.ctrl) {
    const next = { ...state, menuHidden: !state.menuHidden };
    return { ...next, focus: focusable(next).includes(state.focus) ? state.focus : focusable(next)[0] };
  }
  // space holds or releases the human's pause on the selected project, ! on all agents (assignments.json pauses, by scope).
  const pauseScope = key.name === 'space' ? state.projects[state.project]?.id : key.sequence === '!' && !key.ctrl ? 'all' : null;
  if (pauseScope && PAUSABLE.has(state.screen)) {
    const { human, ...rest } = state.pauses[pauseScope] ?? {};
    const scoped = human ? rest : { ...rest, human: {} };
    const { [pauseScope]: _, ...others } = state.pauses;
    return { ...state, pauses: Object.keys(scoped).length ? { ...others, [pauseScope]: scoped } : others };
  }
  if (state.ticket != null) return ticket.viewTicket(state, key, size);
  // Tab steps the agents grid's tiles while it has the focus (ASS-188); only at
  // its page ends does it give the key up, for the focus cycle below.
  if (key.name === 'tab' && state.focus === 'agents') {
    const own = agents.onKey(state, key, size, {});
    if (own !== undefined) return own;
  }
  if (key.name === 'tab') {
    const order = focusable(state);
    const step = key.shift ? -1 : 1;   // shift-tab goes back
    return { ...state, focus: order[(order.indexOf(state.focus) + step + order.length) % order.length] };
  }
  const step = { left: -1, right: 1, up: -1, down: 1 }[key.name];
  const sideways = key.name === 'left' || key.name === 'right';
  const top = { selected: null, scroll: null, repoSelected: 0, repoScroll: 0, agentSelected: 0, agentScroll: 0, agentPage: 0, agentTile: 0, flowchartScroll: 0, backlogFlowScroll: 0, subflowStart: 0, subflowScroll: 0 };
  if (sideways && state.focus === 'menu') {
    return { ...state, ...top, day: null, project: clamp(state.project + step, 0, state.projects.length - 1) };
  }
  if (sideways && state.focus === 'day') {
    // The current day sits after the last past day.
    const days = pastDays(state.projects[state.project]);
    const at = clamp((state.day ? days.indexOf(state.day) : days.length) + step, 0, days.length);
    return { ...state, selected: null, scroll: null, day: days[at] ?? null };
  }
  // The screen's own keys (its module's onKey), else the screen keys.
  const own = SCREEN_MODULES[state.screen]?.onKey?.(state, key, size, { step, sideways });
  if (own !== undefined) return own;
  if (!key.ctrl && shown(state, screenKey(key))) {
    // The updates, repos and agents screens open on their own component;
    // elsewhere the focus stays where it can, else goes to the menu (the day while it is hidden).
    const next = screenKey(key) === 'h' ? memoryOpened({ ...state, screen: 'h' }) : { ...state, screen: screenKey(key) };
    const own = { u: 'updates', r: 'repos', a: 'agents', A: 'agents', b: 'backlog', B: 'backlogflow', f: 'subflows', x: 'chats', h: 'memories' }[next.screen];
    return { ...next, focus: own ?? (focusable(next).includes(state.focus) ? state.focus : focusable(next)[0]) };
  }
  return state;
}

// render(state, { columns, rows, now }) — exactly `rows` lines, the legend
// last, none wider than `columns`.
export function render(state, { columns, rows, now }) {
  const header = headerLines(state, columns, now);
  const footer = [...platform(state, columns, now), center(legend(state), columns),
    ...(updatedOf(state) ? [center(gray(`last updated: ${written(updatedOf(state), now)}`), columns)] : [])];
  const space = Math.max(0, rows - footer.length);
  const lines = [...header, ...body(state, { columns, rows, now })].slice(0, space);
  // On a screen too short for the footer, its top is cut off.
  const screen = [...lines, ...Array(space - lines.length).fill(''), ...footer].slice(-rows);
  return (state.menuOpen ? over(screen, menuBox(state, columns)) : screen).map(line => clip(line, columns));
}

// over(lines, box) — the box (centered lines, as boxRow draws them) drawn over
// the middle of the lines, the lines showing at its left and right.
function over(lines, box) {
  const top = Math.max(0, Math.floor((lines.length - box.length) / 2));
  const left = visible(box[0]) - visible(box[0].trimStart()), right = visible(box[0]);
  return lines.map((line, i) => {
    const row = box[i - top];
    return row == null ? line : `${pad(clip(line, left), left)}\x1b[0m${row.trimStart()}${from(line, right)}`;
  });
}

// controlExited(state, id, code, waiting) — project id's control has ended
// with code (null for a signal), as main.js hears it; `waiting` the controls
// the restart request names that still run. While quitting, nothing: it was
// stopped. 75 asks for a restart (ASS-193); once no named control still
// runs — each drains its agents first (ASS-200) — it is quitting, so main.js
// shuts everything down and exits with 75. Any other code marks it down, with
// the line it logged before its exit line (startControl's, which comes last).
export function controlExited(state, id, code, waiting = 0) {
  if (state.quitting) return state;
  const { [id]: _, ...draining } = state.draining;
  const line = state.controlLog.filter(l => l.project === id).at(-2)?.text ?? '';
  const next = code === 75 ? { ...state, restart: true, draining } : { ...state, draining, controlsDown: { ...state.controlsDown, [id]: { code, line } } };
  return next.restart && !waiting ? { ...next, quitting: true } : next;
}

// controlDraining(state, id, text) — a line of project id's control: its
// restart's "restart waiting for N agents …" (see src/control/tick.js
// drained) records N for the legend; any other line changes nothing.
export function controlDraining(state, id, text) {
  const n = text.match(/^\S+ restart waiting for (\d+) agents? /)?.[1];
  return n == null ? state : { ...state, draining: { ...state.draining, [id]: Number(n) } };
}

// Screens where a highlighted ticket's number is marked, wherever it shows.
const MARKED = new Set(['s', 'S', 'B', 'u', 'c', 'a', 'A']);

// The screen's body, with each of the project's highlighted ticket numbers on
// its color on the screens that mark them.
function body(state, size) {
  const lines = screenBody(state, size);
  if (!MARKED.has(state.screen)) return lines;
  const marks = (state.projects[state.project]?.highlights ?? []).map(h => ({ word: h.ticket, color: h.color }));
  return lines.map(line => markWords(line, marks));
}

function screenBody(state, size) {
  if ((state.screen === 's' || state.screen === 'b') && state.ticket != null) return ticket.view(state, size);
  return SCREEN_MODULES[state.screen].view(state, size);
}

// What main.js and the tests import from here, kept where it moved (ASS-201).
export { decided } from './screens/ticket.js';
export { fitRows } from './screens/log.js';
