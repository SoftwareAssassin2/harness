// A session log open under a prompt line (ASS-201: moved from app.js) — the
// agents screen's, the chat screen's and the ticket screen's Chat tab.
import { scrollBox, scrollLast } from '../table.js';
import { chatLines } from '../chat-look.js';
import { visible } from '../text.js';
import { AGENT_LOG } from './agents.js';
import { below, headerLines, platform } from './frame.js';
import { clamp } from './shared.js';

// A session log open under a prompt line — the agent's on the agents screen
// (AGENT_LOG), or a chat's on the chat screen (CHAT_LOG, ASS-33): the state
// fields it keeps — `cursor` holds where in `draft` the cursor sits, in code
// points (ASS-41) — what sending asks main.js to do, and what closing clears.

// One chat's log lines as a chat view draws them (ASS-299, ASS-300): the
// session log rendered the way a Claude Code session reads (chat-look.js) —
// '⏺' bullets, tool calls as Claude Code names them, results and diffs under
// a '  ⎿  ' gutter, markdown in the agent's own text — in rows already fitted
// to `width`, in a box `rows` tall; `events` (ctrl+o) expands every line to
// its full self, the raw JSON event lines with it. `[empty]` for an absent log.
// The one place every chat view decides what a log shows, before the view
// hands the rows to a scrollBox or to a tile's wrap. Render-only: the lines
// themselves are never changed.
export function chatLog(lines, events, empty, { width, rows } = {}) {
  if (lines == null) return [empty];
  return chatLines(lines, { width, rows, expand: events });
}

// A chat view's help line (ASS-299): the shared wording, ctrl+o for the events
// toggle, `esc returns to ${view.back}` only when `view.back` is set.
export function helpLine(view, events) {
  const toggle = `ctrl+o ${events ? 'hides' : 'shows'} events`;
  const back = view.back ? `   esc returns to ${view.back}` : '';
  return `type a prompt, enter sends it   ←/→ move the cursor   ↑/↓ scroll   ${toggle}${back}`;
}

// The one chat component (ASS-299): what every full-screen chat view draws in
// `rows` tall × `columns` wide — help line (ctrl+o wording), log in a wrapping
// scroll box (the chat-look render, expanded when events are shown) and
// prompt rows, the box giving lines to the prompt as logView does today
// (fitRows). Returns the help line, the rendered list, the prompt's
// fit rows, and `inner` — the content rows the box has below help + blank and
// above the prompt. Callers dress the list in their own frame: the chat screen
// and the agents-screen zoom wrap it in a scrollBox; the ticket screen's Chat
// tab hands it to ticketColumn, whose outer border is the box. The grid tiles
// reach the same decisions through the component's primitives (chatLog,
// helpLine, typeRow) instead of this bordered-box composition, since a tile's
// shape — no inner border, a one-row prompt, ASS-189 — is not the shape here.
// `text` is the width the view's box lays the rows at, `columns` less its
// border and padding by default and named by a caller whose box is wider than
// the component it hands them to (ASS-300: the ticket screen's Chat tab).
export function chatBox(state, { columns = 0, rows = Infinity, text = columns - 4 }, view = AGENT_LOG) {
  const space = Math.max(2, rows - 2);
  const { draft, cursor } = view.get(state);
  const draftRows = promptRows(draft, cursor, true, columns || Infinity);
  const inner = Math.max(1, space - draftRows.length);
  const list = chatLog(state[view.log], state[view.events], view.empty(state), { width: Math.max(1, text), rows: inner });
  const prompt = fitRows(draftRows, space - inner);
  return { help: helpLine(view, state[view.events]), list, prompt, inner };
}

// A prompt line as it is drawn (ASS-41): the draft after '> ', the code point
// under the cursor in reverse video, or a █ trailing it at the draft's end —
// an empty draft and a cursor at the end look as they did before there was one.
// A draft too wide for the prompt's `width`, or holding newlines, takes as many
// rows as it needs (ASS-43): a newline ends a row, and a row that would be wider
// than the width less its 2-column lead-in and one column kept for the cursor
// (so a full row never pushes the █ off the screen) breaks before the code point
// that does not fit, by display width (an emoji takes two). The first row starts
// with '> ', the rest with two spaces, as the session log shows a sent prompt; the
// cursor is drawn on the row it falls on, a cursor on a newline as a reversed
// space at its row's end. The rows are the same whether or not the prompt has focus.
export function promptRows(draft, cursor = 0, focused = true, width = Infinity) {
  const text = [...draft];
  const at = clamp(cursor ?? 0, 0, text.length);
  const room = Math.max(1, width - 3);
  const rows = [[]];
  let used = 0;
  text.forEach((char, i) => {
    const shown = char === '\n' ? ' ' : char;
    if (char !== '\n' && used && used + visible(char) > room) { rows.push([]); used = 0; }
    if (focused && i === at) rows.at(-1).push(`\x1b[7m${shown}\x1b[0m`);
    else if (char !== '\n') rows.at(-1).push(char);
    used += visible(char);
    if (char === '\n') { rows.push([]); used = 0; }
  });
  if (focused && at === text.length) rows.at(-1).push('█');
  return rows.map((row, i) => `${i ? '  ' : '> '}${row.join('')}`);
}

// A prompt's rows in the `room` it has (ASS-43): all of them when they fit,
// else its last rows, the line above them saying how many are hidden —
// `(N more lines above)` — and so taking one of the room's lines. The hint
// costs a line, so it never hides fewer than two rows: `(1 more line above)` is
// spelled right but cannot be drawn. A room of one line shows the last row alone.
export function fitRows(rows, room) {
  if (rows.length <= room) return rows;
  const shown = Math.max(1, room - 1), hidden = rows.length - shown;
  return [...(room > 1 ? [`(${hidden} more line${hidden === 1 ? '' : 's'} above)`] : []), ...rows.slice(-shown)];
}

// The agents screen's session view: what the keys do and a blank line (for
// when the log was last written), the open agent's session log (see src/agents/session.js), the box it scrolls in — all the space above
// the platform boxes less the prompt being typed and what sending the last
// said — and `last`, the furthest it scrolls.

// The log box takes the space left above the prompt, giving up a line to each of
// the draft's rows past the first (ASS-43), down to its minimum of 3; the prompt's
// rows (`prompt`) fill what it gave up, fitRows hiding the first of those that do not fit.
// `view.get(state)` / `view.set(state, { draft, cursor })` indirect the draft and
// cursor fields (ASS-189) — a trivial flat pass-through for CHAT_LOG/TICKET_LOG,
// name-keyed on the agents screen so the tile input and the zoom share one draft.
export function logView(state, { columns = 0, rows = Infinity, now = 0 }, view = AGENT_LOG) {
  const bottom = below(state) + platform(state, columns, now).length;
  const rows_in = Math.max(4, rows - headerLines(state, columns, now).length - bottom - 3);   // box+prompt total, floored as before ASS-299 (max(3, …-4)+1)
  const chat = chatBox(state, { columns, rows: rows_in }, view);
  const boxHeight = chat.inner + 2;
  const body = scrollBox(chat.list, { width: columns, height: boxHeight, scroll: state[view.scroll] ?? Infinity, wrap: true });
  return { head: [chat.help, ''], body, prompt: chat.prompt, last: scrollLast(chat.list, { width: columns, height: boxHeight, wrap: true }) };
}

// A key on the session view: every printable key is text in the prompt, typed
// in at the cursor (ASS-41) — ←/→ move it a code point either way and stop at
// the draft's ends, home/end and ctrl-a/ctrl-e jump to them, backspace takes
// the code point before the cursor and delete the one under it;
// enter asks for the whole draft to be sent as `agentPrompt`, for main.js to hand the
// agent-cli, once it is not blank; escape clears it, or with none returns to
// the screen it was opened from (view.back) as it was; ctrl+o is the events/expand
// toggle — it expands every chat-look line to its full self (whole results, diffs
// and thinking) and shows the raw JSON event lines with them (ASS-40, ASS-299,
// ASS-300), following the end again; ↑/↓ scroll no further than the last line, and
// reaching it follows the end again as the log grows.
// Sending and clearing put the cursor back at the start.
// shift+enter puts a newline in the draft at the cursor (ASS-43), enter then
// sending the draft trimmed at its ends, its inner newlines kept. What a terminal
// sends for shift+enter is its own: escape-return (iTerm2 and VS Code once Claude
// Code's /terminal-setup has run), kitty's keyboard protocol's \x1b[13;2u (kitty,
// Ghostty, WezTerm, foot) or xterm's modifyOtherKeys \x1b[27;2;13~ are recognised
// but never asked for — turning either protocol on would change how esc and enter
// arrive too — and ctrl+j (\n, readline's `enter`) is the fallback every terminal
// sends. A plain terminal sends shift+enter as enter. readline cuts the
// modifyOtherKeys sequence after its second ';' and hands on the rest as keys, so
// those are gathered (keyTail) until its closing '~' and then read as one key.
export const NEWLINE_KEYS = new Set(['\x1b\r', '\x1b[13;2u', '\x1b[27;2;13~', '\n']);
// withKeyTail(state, key, fn) — gather the modifyOtherKeys escape sequence
// readline splits after its second ';' (ASS-43), handing `fn` the whole sequence
// as one key when the closing '~' arrives. Shared by viewLog and agents.typeKey
// (ASS-189) so the tricky absorption lives in one place.
export function withKeyTail(state, key, fn) {
  const sequence = key.sequence ?? '';
  if (state.keyTail != null && /^[0-9;~]$/.test(sequence)) {
    const tail = state.keyTail + sequence;
    return sequence === '~' ? fn({ ...state, keyTail: null }, { ...key, sequence: tail }) : { ...state, keyTail: tail };
  }
  if (state.keyTail != null) return fn({ ...state, keyTail: null }, key);
  if (/^\x1b\[27;\d+;$/.test(sequence)) return { ...state, keyTail: sequence };
  return fn(state, key);
}
export function viewLog(state, key, size, view) {
  return withKeyTail(state, key, (state, key) => {
    const sequence = key.sequence ?? '';
    const { draft, cursor: rawCursor } = view.get(state);
    const text = [...draft];
    const cursor = clamp(rawCursor ?? 0, 0, text.length);
    const edit = (next, at) => view.set(state, { draft: next.join(''), cursor: at });
    if (key.name === 'escape') return draft ? edit([], 0) : { ...state, ...view.close };
    if (key.name === 'backspace') return cursor ? edit(text.toSpliced(cursor - 1, 1), cursor - 1) : state;
    if (key.name === 'delete') return cursor < text.length ? edit(text.toSpliced(cursor, 1), cursor) : state;
    if (key.ctrl && key.name === 'o') return { ...state, [view.events]: !state[view.events], [view.scroll]: null };
    if (NEWLINE_KEYS.has(sequence) || key.name === 'enter') return edit(text.toSpliced(cursor, 0, '\n'), cursor + 1);
    if (key.name === 'return') {
      return draft.trim() ? { ...view.set(state, { draft: '', cursor: 0 }), [view.message]: '', ...view.send(state, draft.trim()) } : state;
    }
    if (key.name === 'left' || key.name === 'right') return view.set(state, { draft, cursor: clamp(cursor + (key.name === 'left' ? -1 : 1), 0, text.length) });
    if (key.name === 'home' || (key.ctrl && key.name === 'a')) return view.set(state, { draft, cursor: 0 });
    if (key.name === 'end' || (key.ctrl && key.name === 'e')) return view.set(state, { draft, cursor: text.length });
    const step = { up: -1, down: 1 }[key.name];
    if (!step) {
      return [...sequence].length === 1 && sequence >= ' ' && sequence !== '\x7f' ? edit(text.toSpliced(cursor, 0, sequence), cursor + 1) : state;
    }
    const { last } = view.last ? { last: view.last(state, size) } : logView(state, size, view);
    const at = clamp(Math.min(state[view.scroll] ?? last, last) + step, 0, last);
    return { ...state, [view.scroll]: at === last ? null : at };
  });
}
