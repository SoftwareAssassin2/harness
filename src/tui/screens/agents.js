// The agents screen (a): the project's agents as a tile grid (ASS-188) — `A` (ASS-246)
// shows every project's — the old table behind `t`, and an agent's session log
// (ASS-201: moved from app.js).
import { runsInVm } from '../../control/vm.js';
import { boxTable, scrollBox } from '../table.js';
import { link, visible, clip, pad } from '../text.js';
import * as chat from './chat.js';
import { below, headerLines, platform } from './frame.js';
import { foldResults, logView, promptRows, NEWLINE_KEYS, withKeyTail } from './log.js';
import { count } from '../metrics.js';
import { ticketUrls, ticketLink, NONE, cell, feedback, agentLines, projectAssignments, ICONS, center, clamp, ellipsis, move, since, written, repoName } from './shared.js';

const AGENT_HEADERS = ['Agent', 'Working Location', 'Model', 'Account', 'Assignment', 'State', 'Time', 'Status', 'Last Activity', 'Health', 'Agents'];

// The assignments and chats a screen shows: the selected project's on `a`,
// every project's on `A` (ASS-188, ASS-246) — the project menu does not filter `A`.
const scoped = state => (state.screen === 'A' ? state.assignments : projectAssignments(state));
const scopedChats = state => state.chats.filter(c => state.chatsRunning.includes(c.id)
  && (state.screen === 'A' || c.project === state.projects[state.project]?.id));

// The old table behind `t`: one row per assignment on show, as they are now,
// whatever the day, and the lines its body may take.
function agentLayout(state, { columns = 0, rows = Infinity, now = 0 }) {
  const repos = new Map((state.projects[state.project]?.repositories ?? []).map(r => [repoName(r.url), r.url]));
  return { rows: agentRows(scoped(state), ticketUrls(state), repos, now, state.sessionWritten), bodyHeight: bodyHeight(state, columns, rows, now) - 4 };
}

// The lines a screen's body may take: all that is left under the header and
// above the legend with the platform boxes, or a blank line, over it — both
// measured at the size's now, as render draws them (ASS-295).
const bodyHeight = (state, columns, rows, now = 0) =>
  rows - headerLines(state, columns, now).length - below(state) - Math.max(1, platform(state, columns, now).length);

export const AGENT_LOG = {
  log: 'agentLog', scroll: 'agentLogScroll', draft: 'agentDraft', cursor: 'agentCursor', events: 'agentEvents', message: 'agentMessage', back: 'the agents',
  empty: state => `no session log for ${state.agent.name}`,
  // The message is queued until its "> text" line shows in the agent's log
  // (settlePending): until then its tile is marked `queued` (ASS-189 AC3).
  send: (state, text) => ({
    agentPrompt: ['agent-interaction:resume-thread', state.agent.name, text],
    pending: queuePending(state.pending, state.agent.name, text),
  }),
  close: { agent: null, agentLog: null, agentLogScroll: null, agentMessage: '' },
  // The draft is kept per agent name (ASS-189), shared with the tile input.
  get: state => ({ draft: state.agentDraft?.[state.agent?.name] ?? '', cursor: state.agentCursor?.[state.agent?.name] ?? 0 }),
  set: (state, { draft, cursor }) => ({
    ...state,
    agentDraft: { ...state.agentDraft, [state.agent?.name]: draft },
    agentCursor: { ...state.agentCursor, [state.agent?.name]: cursor },
  }),
};

// queuePending(pending, name, text) — append `text`'s first line to the agent's
// queued texts, so settlePending can clear it when its '> ' echo shows in the
// session tail. Tolerates an undefined `pending`.
export function queuePending(pending, name, text) {
  const first = text.split('\n')[0];
  const entry = pending?.[name] ?? { texts: [], notRead: false };
  return { ...pending, [name]: { ...entry, texts: [...entry.texts, first] } };
}

// refused(pending, name) — a send that main.js's error branch rejected (eg
// the agent is no longer running): mark the agent `not read`, keeping any
// `texts` as they were. Creates the entry if it is absent (no tail will
// ever bring the '> ' echo).
export function refused(pending, name) {
  const entry = pending?.[name] ?? { texts: [], notRead: false };
  return { ...pending, [name]: { ...entry, notRead: true } };
}

// One row per assignment: its agent, where it runs (Dev Container when
// working-in-dev-container is true, else Local PC), model, what it is
// assigned to, state, time since it started, status, when its session log was
// last written (see written; `sessionWritten` by agent-name), ai-feedback-short as Health,
// and as Agents the assignments whose `agent` is its agent, checking on it.
// The assignment
// is "control" when control is true, else its ticket (KEY.VARIATION when it names a variation, linked to the url
// `urls` has for the key), else "MR !<merge-request>" (linked to its
// merge-request-url), else "Agent <name>" for the agent it checks on,
// else "repo: <name>" for its repository (linked to the url `repos` has for
// the name), else its local environment's name.
function agentRows(assignments, urls, repos, now, sessionWritten = {}) {
  const assigned = a => {
    if (a.control === true) return 'control';
    if (a['work-item']) {
      const ticket = [a['work-item'], a.variation].filter(Boolean).join('.');
      return ticketLink(ticket, urls.get(a['work-item']));
    }
    if (a['merge-request']) {
      const mr = `MR !${a['merge-request']}`;
      return a['merge-request-url'] ? link(mr, a['merge-request-url']) : mr;
    }
    if (a.agent) return `Agent ${a.agent}`;
    if (a.repo) return repos.has(a.repo) ? link(`repo: ${a.repo}`, repos.get(a.repo)) : `repo: ${a.repo}`;
    if (a['local-environment']) return a['local-environment'];
    if (a['transient-state-engine'] && a['state-engine']) return `run: ${a['state-engine'].split('/').pop()}`;   // a trigger's run on nothing in particular: named by its engine, or its *-steps list
    return NONE;
  };
  return assignments.map(a => [
    a['agent-name'],
    a['working-in-dev-container'] === true ? 'Dev Container' : 'Local PC',
    cell(a.model),
    a.account?.email ?? NONE,
    assigned(a),
    cell(a.state),
    a['start-time'] ? since(a['start-time'], now) : NONE,
    cell(a.status),
    sessionWritten[a['agent-name']] == null ? NONE : written(sessionWritten[a['agent-name']], now),
    feedback(a['ai-feedback-short']),
    agentLines(assignments.filter(b => b.agent === a['agent-name'])),
  ]);
}


// ── The tile grid (ASS-188): one tile per agent, oldest-started first.

// A tile is never drawn smaller than this; below it the grid drops a column or a row.
const TILE = { columns: 16, rows: 6 };
// The grid's shape without harness.json's agents-grid-columns / agents-grid-rows.
export const AGENTS_GRID = { agentsGridColumns: 3, agentsGridRows: 2 };

// Every agent the screen tiles, oldest-started first: the assignments it shows
// (scoped — including those still Starting, which have no session yet) and the
// chats whose agent runs (scopedChats), each { kind, key (its name or chat id),
// name (what its border says), project, at (when it started) }.
const tiledAgents = state => [
  ...scoped(state).map(a => ({ kind: 'agent', key: a['agent-name'], name: a['agent-name'], project: a.project, at: a['start-time'] ?? '', a })),
  ...scopedChats(state).map(c => ({ kind: 'chat', key: c.id, name: c.title, project: c.project, at: c.created ?? '' })),
].toSorted((x, y) => x.at.localeCompare(y.at));

// `total` columns or lines split between `n` tiles, the leftover to the leftmost.
const share = (total, n) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));

// The grid as it is drawn: `cols` × `rows` tiles, the configured shape (ASS-188:
// harness.json's agents-grid-columns / agents-grid-rows, see load.js loadHarness)
// shrunk to the smallest grid that holds the agents there are and to what keeps
// every tile at least TILE big; the last line of the body is kept for the
// "page x of y" footer. `shown` are the agents of the page on show, `at` the
// focused one among them. `narrow` when not even one tile fits.
function gridLayout(state, { columns = 0, rows = Infinity, now = 0 }) {
  const items = tiledAgents(state);
  const height = bodyHeight(state, columns, rows, now) - 1;
  const { agentsGridColumns, agentsGridRows } = state.agentsGrid ?? AGENTS_GRID;
  const cols = Math.min(agentsGridColumns, Math.max(1, items.length), Math.floor(columns / TILE.columns));
  const tileRows = Math.min(agentsGridRows, Math.ceil(items.length / Math.max(1, cols)) || 1, Math.floor(height / TILE.rows));
  if (cols < 1 || tileRows < 1) return { narrow: true, items, shown: [], at: 0 };
  const perPage = cols * tileRows;
  const pages = Math.ceil(items.length / perPage);
  const page = clamp(state.agentPage ?? 0, 0, Math.max(0, pages - 1));
  const shown = items.slice(page * perPage, (page + 1) * perPage);
  return { cols, rows: tileRows, perPage, pages, page, height, items, shown, at: clamp(state.agentTile ?? 0, 0, Math.max(0, shown.length - 1)) };
}

// Where an agent works, as its tile says it: DC in a dev container, else VM
// when the step it is on runs in one (runsInVm, the step of the engine its
// state-engine names), else the host — an engine or step the TUI does not know
// runs on the host.
function locationOf(state, a) {
  if (a['working-in-dev-container'] === true) return 'DC';
  const engine = state.workflows.find(w => w.name === String(a['state-engine'] ?? '').split('/')[0]);
  return runsInVm(engine?.steps?.find(s => s.id === a.state)) ? 'VM' : 'host';
}

// Whether an agent's ticket variation is held (is-paused, as the sprint screen
// marks it): looked up in its own project — on `A` not the selected one — in
// its active sprint or its backlog.
function pausedTile(state, a) {
  const project = state.projects.find(p => p.id === a.project);
  const tickets = [...Object.keys(ICONS).flatMap(type => project?.sprint?.[type] ?? []), ...(project?.backlog ?? [])];
  const ticket = tickets.find(t => t.key === a['work-item']);
  return (ticket?.variations ?? []).some(v => v.name === a.variation && v['is-paused'] === true);
}

// A tile's header: the ticket — KEY.VARIATION, the key alone without a
// variation — and the step it is on, or `chat` for a chat, with the marks
// (⏸️ its variation is held, ⚠️ it has said something about its health —
// ai-feedback-short, the old table's Health — `queued` / `not read` for a
// message sent from the TUI, see settlePending, ASS-189); then how long its
// session has run, where it works, on `A`, its project, and its context % and
// cost (its usage.json, which main.js keeps in usage by the tile's key: see
// contextLabel and costLabel).
function tileHeader(state, item, now) {
  const a = item.a;
  const entry = state.pending?.[item.key];
  const mark = entry?.notRead ? 'not read' : entry?.texts?.length ? 'queued' : null;
  const marks = item.kind === 'chat' ? [] : [pausedTile(state, a) && '⏸️', a['ai-feedback-short'] && '⚠️', mark];
  const what = item.kind === 'chat' ? 'chat' : [[a['work-item'], a.variation].filter(Boolean).join('.'), a.state].filter(Boolean).join(' ');
  const project = state.screen === 'A' ? state.projects.find(p => p.id === item.project)?.name ?? item.project : '';
  const where = item.kind === 'chat' ? 'host' : locationOf(state, a);
  return [[what, ...marks].filter(Boolean).join('  '), [item.at && since(item.at, now), where, project, usageLabel(state.usage?.[item.key])].filter(Boolean).join('  ')];
}

// contextLabel(usage) — an agent's context in use (ASS-190): "ctx 42%" of its
// model's window, "ctx 412k" tokens while the window is unknown; '' without
// any.
export function contextLabel(usage) {
  if (!usage?.contextTokens) return '';
  return usage.contextWindow ? `ctx ${Math.round(usage.contextTokens / usage.contextWindow * 100)}%` : `ctx ${count(usage.contextTokens)}`;
}

// costLabel(usage) — its spend so far: "~$0.08" estimated, "$0.08" once a
// turn's end made it exact; '' without a cost (a model with no price, mid-turn).
export function costLabel(usage) {
  if (usage?.costUsd == null) return '';
  return `${usage.costExact ? '' : '~'}$${usage.costUsd.toFixed(2)}`;
}

const usageLabel = usage => [contextLabel(usage), costLabel(usage)].filter(Boolean).join('  ');

// The lines a tile's body shows: its agent's session log as the full log view
// shows it (main.js keeps the last of it in sessionTails, by the tile's key) —
// event JSON hidden, tool results folded — the latest that fit, each clipped at
// the tile's edge. A log never written shows none.
const tileBody = (state, item, room) =>
  foldResults((state.sessionTails?.[item.key] ?? []).filter(line => !line.startsWith('{"type":'))).slice(-Math.max(0, room));

// typeRow(text, cursor, room) — the focused tile's one-row input (ASS-189):
// `room` cols wide, always starting with a '> ' lead-in, newlines shown as
// spaces, cursor cell in reverse video or '█' past the draft's end. Built
// from promptRows at `room` width, taking the row the cursor sits on; a
// scrolled row's '  ' lead-in is swapped for '> ' so the input is always
// visibly a prompt, and a cursor at the draft's end slides '█' to the right
// edge, filling the gap with spaces.
export function typeRow(text, cursor, room) {
  const flat = (text ?? '').replace(/\n/g, ' ');
  const rows = promptRows(flat, cursor, true, room);
  const marker = cursor >= [...flat].length ? '█' : '\x1b[7m';
  const idx = Math.max(0, rows.findIndex(r => r.includes(marker)));
  const row = idx === 0 ? rows[idx] : `> ${rows[idx].slice(2)}`;
  const padCols = Math.max(0, room - visible(row));
  if (padCols === 0) return row;
  return row.endsWith('█') ? `${row.slice(0, -1)}${' '.repeat(padCols)}█` : `${row}${' '.repeat(padCols)}`;
}

// One tile: a box `width` × `height` with its agent's name in the top border,
// reversed while the tile has the focus and clipped with an ellipsis when the
// tile is too narrow for it; its header inside, and the log under that. When
// the tile is the focused one and agentTyping is on, the last body line is a
// one-row input (ASS-189), shared with the zoom's draft.
function renderTile(state, item, { width, height, selected, now }) {
  const inner = width - 2;
  const label = ellipsis(item.name, Math.max(0, inner - 3));
  const header = tileHeader(state, item, now).filter(Boolean);
  const typing = selected && state.agentTyping && item.kind === 'agent';
  const bodyRows = Math.max(0, height - 2 - header.length - (typing ? 1 : 0));
  const text = [...header, ...tileBody(state, item, bodyRows), ...(typing ? [typeRow(state.agentDraft?.[item.key] ?? '', state.agentCursor?.[item.key] ?? 0, inner)] : [])];
  return [
    `┌─ ${selected ? `\x1b[7m${label}\x1b[0m` : label} ${'─'.repeat(Math.max(0, inner - 3 - visible(label)))}┐`,
    ...Array.from({ length: Math.max(0, height - 2) }, (_, i) => `│${pad(clip(text[i] ?? '', inner), inner)}│`),
    `└${'─'.repeat(inner)}┘`,
  ];
}

// The grid drawn: its tiles row by row, side by side with no gap between them,
// then "page x of y" while there is more than one page, and the last send's
// outcome (ASS-189: `queued for X` or a refused send's named reason).
function gridView(state, size) {
  const grid = gridLayout(state, size);
  if (grid.narrow) return ['terminal too narrow for the agents grid: press t for the table'];
  if (!grid.shown.length) {   // no agents (ASS-223)
    const where = state.screen === 'A' ? '' : ` in ${state.projects[state.project]?.name}`;
    return [`no agents running${where}`, 'press t for the table'].map(line => center(line, size.columns));
  }
  const widths = share(size.columns, grid.cols);
  const heights = share(grid.height, grid.rows);
  const lines = [];
  for (let row = 0; row < grid.rows; row++) {
    const tiles = grid.shown.slice(row * grid.cols, (row + 1) * grid.cols)
      .map((item, col) => renderTile(state, item, { width: widths[col], height: heights[row], selected: state.focus === 'agents' && row * grid.cols + col === grid.at, now: size.now }));
    if (!tiles.length) break;
    for (let i = 0; i < heights[row]; i++) lines.push(tiles.map(tile => tile[i]).join(''));
  }
  return [...lines, ...(grid.pages > 1 ? [`page ${grid.page + 1} of ${grid.pages}`] : []), ...(state.agentMessage ? [state.agentMessage] : [])];
}

// settlePending(state) — the queued-message marks as the session logs now
// stand (main.js folds them in as it reads the tails, ASS-189): a message
// stays `queued` until its "> <first line>" shows in its agent's log, which
// clears it; when the agent has exited ('[agent exited' in its tail) or its
// assignment is gone with an unread message still queued, it flips to sticky
// `not read`. Drafts for agents no longer assigned are pruned (AC1's
// "dropped when the agent leaves assignments.json").
export function settlePending(state) {
  const names = new Set(state.assignments.map(a => a['agent-name']));
  const pending = Object.fromEntries(Object.entries(state.pending ?? {}).map(([name, entry]) => {
    const tail = state.sessionTails?.[name] ?? [];
    const texts = (entry.texts ?? []).filter(text => !tail.includes(`> ${text}`));
    const exited = tail.some(l => l.startsWith('[agent exited')) || !names.has(name);
    const notRead = entry.notRead || (exited && texts.length > 0);
    return [name, { texts, notRead }];
  }));
  const prune = map => Object.fromEntries(Object.entries(map ?? {}).filter(([n]) => names.has(n)));
  return { ...state, pending, agentDraft: prune(state.agentDraft), agentCursor: prune(state.agentCursor) };
}

export function view(state, size) {
  if (state.agent != null) {
    const { head, list, boxHeight, prompt } = logView(state, size, AGENT_LOG);
    const at = state.sessionWritten[state.agent.name];
    if (at != null) head[1] = `log last written ${written(at, size.now)}`;
    const usage = usageLabel(state.usage?.[state.agent.name]);
    if (usage) head[1] = [head[1], usage].filter(Boolean).join('  ');
    return [
      ...head,
      ...scrollBox(list, { width: size.columns, height: boxHeight, scroll: state.agentLogScroll ?? Infinity, wrap: true }),
      ...prompt,
      state.agentMessage,
    ];
  }
  // A zoomed chat tile is the chat screen's own view, so esc leaves it as it does there.
  if (state.chat != null) return chat.view(state, size);
  if (!state.agentsTable) return gridView(state, size);
  const agents = agentLayout(state, size);
  return boxTable(AGENT_HEADERS, agents.rows.length ? agents.rows : [['no dev agents running']], {
    columns: size.columns, stretch: 0, height: agents.bodyHeight + 4, scroll: state.agentScroll,
    selected: state.focus === 'agents' && agents.rows.length ? state.agentSelected : undefined,
  });
}

// Its keys: t swaps the grid for the old table and back. On the grid the arrows
// move the focused tile within its page, PgUp/PgDn turn the page, tab and
// shift-tab step the tiles and wrap onto the next and previous page — past the
// last tile of the last page, or before the first of the first, it gives the key
// up so app.js carries the focus on — z zooms the focused tile to its full-screen
// log, enter opens a one-row input on an agent tile (ASS-189, see typeKey) and
// still zooms a chat tile to its chat. On the table, as before: ↑/↓ move its
// selection and enter opens the selected agent's session log.
export function onKey(state, key, size, { step, sideways }) {
  if (key.sequence === 't' && !key.ctrl) return { ...state, agentsTable: !state.agentsTable };
  if (state.agentsTable) {
    if (step && !sideways && state.focus === 'agents') {
      const [agentSelected, agentScroll] = move(agentLayout(state, size), state.agentSelected, state.agentScroll, step);
      return { ...state, agentSelected, agentScroll };
    }
    if (key.name === 'return' && state.focus === 'agents') {
      const a = scoped(state)[state.agentSelected];
      return a ? { ...state, agent: { name: a['agent-name'], start: a['start-time'] ?? null }, agentLog: null, agentLogScroll: null } : state;
    }
    return undefined;
  }
  if (state.focus !== 'agents') return undefined;
  const grid = gridLayout(state, size);
  if (!grid.shown.length) return undefined;   // no tiles: app.js's focus cycle and screen keys (ASS-223)
  if (step !== undefined) {
    const [col, row] = [grid.at % grid.cols, Math.floor(grid.at / grid.cols)];
    const next = sideways ? row * grid.cols + clamp(col + step, 0, grid.cols - 1) : clamp(row + step, 0, grid.rows - 1) * grid.cols + col;
    return { ...state, agentTile: Math.min(next, grid.shown.length - 1) };
  }
  if (key.name === 'pagedown' || key.name === 'pageup') {
    const page = clamp(grid.page + (key.name === 'pagedown' ? 1 : -1), 0, grid.pages - 1);
    return { ...state, agentPage: page, agentTile: page === grid.page ? grid.at : 0 };
  }
  if (key.name === 'tab') {
    const next = grid.page * grid.perPage + grid.at + (key.shift ? -1 : 1);
    if (next < 0 || next >= grid.items.length) return undefined;   // off the grid: app.js's focus cycle
    return { ...state, agentPage: Math.floor(next / grid.perPage), agentTile: next % grid.perPage };
  }
  if (key.sequence === 'z' && !key.ctrl) {
    const item = grid.shown[grid.at];
    return item.kind === 'chat'
      ? { ...state, chat: { id: item.key }, chatLog: null, chatLogScroll: null, chatDraft: '', chatCursor: 0, chatMessage: '' }
      : { ...state, agent: { name: item.name, start: item.a['start-time'] ?? null }, agentLog: null, agentLogScroll: null };
  }
  if (key.name === 'return') {
    const item = grid.shown[grid.at];
    return item.kind === 'chat'
      ? { ...state, chat: { id: item.key }, chatLog: null, chatLogScroll: null, chatDraft: '', chatCursor: 0, chatMessage: '' }
      : { ...state, agentTyping: true };
  }
}

// typeKey(state, key, size) — the focused agent tile's one-row input (ASS-189):
// Esc stops typing and keeps the draft; Tab/Shift-Tab/←/↑/→/↓ stop typing and
// hand the key back to app.js's handleKey (returning undefined) so the existing
// focus and tile-move logic runs unchanged; shift+enter and ctrl+j are inert
// (no newlines in a one-row input); backspace/delete edit at the cursor;
// return sends the trimmed draft and clears that agent's slot alone, queued
// through queuePending; any single printable code point inserts at the cursor.
// The modifyOtherKeys preamble is shared with viewLog through withKeyTail.
export function typeKey(state, key, size) {
  const nav = new Set(['tab', 'left', 'right', 'up', 'down']);
  if (nav.has(key.name)) return undefined;
  if (key.name === 'escape') return { ...state, agentTyping: false };
  return withKeyTail(state, key, (state, key) => {
    const sequence = key.sequence ?? '';
    if (NEWLINE_KEYS.has(sequence) || key.name === 'enter') return state;   // shift+enter / ctrl+j inert
    const grid = gridLayout(state, size);
    const item = grid.shown[grid.at];
    if (!item || item.kind !== 'agent') return state;
    const name = item.key;
    const stored = state.agentDraft?.[name] ?? '';
    const text = [...stored];
    const cursor = clamp(state.agentCursor?.[name] ?? 0, 0, text.length);
    const edit = (next, at) => ({
      ...state,
      agentDraft: { ...state.agentDraft, [name]: next.join('') },
      agentCursor: { ...state.agentCursor, [name]: at },
    });
    if (key.name === 'backspace') return cursor ? edit(text.toSpliced(cursor - 1, 1), cursor - 1) : state;
    if (key.name === 'delete') return cursor < text.length ? edit(text.toSpliced(cursor, 1), cursor) : state;
    if (key.name === 'return') {
      if (!stored.trim()) return state;
      return {
        ...state,
        agentDraft: { ...state.agentDraft, [name]: '' },
        agentCursor: { ...state.agentCursor, [name]: 0 },
        agentTyping: false,
        agentMessage: '',
        agentPrompt: ['agent-interaction:resume-thread', name, stored.trim()],
        pending: queuePending(state.pending, name, stored.trim()),
      };
    }
    if ([...sequence].length === 1 && sequence >= ' ' && sequence !== '\x7f') {
      return edit(text.toSpliced(cursor, 0, sequence), cursor + 1);
    }
    return state;
  });
}
