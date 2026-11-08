// The chat screen (x): the project's chats, and a chat's log (ASS-201: moved from app.js).
import { boxTable } from '../table.js';
import { below, headerLines, platform } from './frame.js';
import { logView } from './log.js';
import { NONE, move, written, red } from './shared.js';

export const CHAT_LOG = {
  log: 'chatLog', scroll: 'chatLogScroll', draft: 'chatDraft', cursor: 'chatCursor', events: 'chatEvents', message: 'chatMessage', back: 'the chats',
  empty: () => 'no messages yet: type one, enter sends it',
  send: (state, text) => ({ chatSend: { project: state.projects[state.project]?.id, id: state.chat.id, text } }),
  close: { chat: null, chatLog: null, chatLogScroll: null, chatMessage: '' },
  get: state => ({ draft: state.chatDraft, cursor: state.chatCursor }),
  set: (state, { draft, cursor }) => ({ ...state, chatDraft: draft, chatCursor: cursor }),
};

// The chat screen's list (ASS-33): + New chat, then the selected project's
// chats, newest first — title, created, last activity (its log's last write),
// running or ended — and the lines its body may take.
const CHAT_HEADERS = ['Chat', 'Created', 'Last Activity', 'Status'];
function chatLayout(state, { columns = 0, rows = Infinity, now = 0 } = {}) {
  const id = state.projects[state.project]?.id;
  const list = state.chats.filter(c => c.project === id).toSorted((a, b) => b.created.localeCompare(a.created));
  const bottom = below(state) + Math.max(1, platform(state, columns, now).length);
  const free = rows - headerLines(state, columns, now).length - bottom - 2;
  const at = iso => iso.replace('T', ' ').replace(/:\d\dZ$/, ' UTC');
  const rowsOf = [['+ New chat', '', '', ''], ...list.map(c => [
    c.title, at(c.created), state.chatsWritten[c.id] == null ? NONE : written(state.chatsWritten[c.id], now), state.chatsRunning.includes(c.id) ? 'running' : 'ended',
  ])];
  return { list, rows: rowsOf, bodyHeight: free - 4 };
}

// y deletes the chat being asked about (chatDelete, for main.js); any other key keeps it.
export function confirmDelete(state, key) {
  const yes = key.sequence === 'y' || key.name === 'y';
  return { ...state, chatConfirm: null, chatDelete: yes ? state.chatConfirm : null, chatSelected: yes ? Math.max(0, state.chatSelected - 1) : state.chatSelected };
}

export function view(state, size) {
  if (state.chat != null) {
    const { head, body, prompt } = logView(state, size, CHAT_LOG);
    const at = state.chat.id && state.chatsWritten[state.chat.id];
    if (at != null && at !== false) head[1] = `log last written ${written(at, size.now)}`;
    return [...head, ...body, ...prompt, state.chatMessage];
  }
  const chats = chatLayout(state, size);
  const asking = state.chatConfirm && chats.list.find(c => c.id === state.chatConfirm);
  return [
    state.focus === 'chats' ? '↑/↓ choose   enter opens a chat or starts a new one   delete removes a chat' : '',
    '',
    ...boxTable(CHAT_HEADERS, chats.rows, { columns: size.columns, stretch: 0, height: chats.bodyHeight + 4, scroll: state.chatScroll, selected: state.focus === 'chats' ? state.chatSelected : undefined }),
    ...(asking ? ['', red(`Delete chat '${asking.title}'? y/n`)] : state.chatMessage ? ['', state.chatMessage] : []),
  ];
}

// Its keys: ↑/↓ choose a chat, enter opens it, delete asks to remove it.
export function onKey(state, key, size, { step, sideways }) {
  if (state.focus === 'chats') {
    const { list } = chatLayout(state, size);
    if (step && !sideways) {
      const [chatSelected, chatScroll] = move(chatLayout(state, size), state.chatSelected, state.chatScroll, step);
      return { ...state, chatSelected, chatScroll };
    }
    if (key.name === 'return') return { ...state, chat: { id: state.chatSelected ? list[state.chatSelected - 1].id : null }, chatLog: null, chatLogScroll: null, chatDraft: '', chatCursor: 0, chatMessage: '' };
    if ((key.name === 'delete' || key.name === 'backspace') && state.chatSelected) return { ...state, chatConfirm: list[state.chatSelected - 1].id };
  }
}
