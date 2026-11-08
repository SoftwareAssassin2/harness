// One chat's session log drawn the way a Claude Code session reads (ASS-300).
// chatLines(lines, { width, rows, expand }) takes a session log's lines
// (src/agents/session.js eventLines) and returns the rows every chat view
// draws — already fitted to `width`, so the box around them only has to put
// them on the screen.
//
// Two passes. The first parses the lines into messages — a sent prompt, the
// agent's text, its thinking, a tool call with its input, a tool result, a
// turn's end, the session's own lines, a raw JSON event — and pairs each
// result with the oldest call not yet answered, as session.js memoryUse pairs
// them. The second draws each: a '⏺' bullet (green, red when the result is an
// error) over the tool as Claude Code names it, its result under a '  ⎿  '
// gutter as a one-line summary or its first lines, a TodoWrite as its
// checklist, an Edit/Write as a line diff, a thought as '✻ Thinking…', a
// prompt on a dim background, a blank row before each message.
//
// `expand` is the ctrl+o events toggle (log.js): with it on, every line shows
// in full — whole results, whole diffs, thinking text and the raw JSON event
// lines — as the events view did before.
import { clip, pad, visible, wrapLine } from './text.js';
import { markdown } from './markdown.js';

const sgr = code => text => `\x1b[${code}m${text}\x1b[0m`;
// Attributes and the 16-colour palette only, never 256-colour or truecolour,
// and the agent's own text in the default foreground: so the look reads on a
// light terminal theme as well as a dark one (AC5).
const DIM = sgr(2), GREEN = sgr(32), RED = sgr(31), BOLD = sgr(1);
const THINKING = text => `\x1b[2m\x1b[3m${text}\x1b[0m`;
const STRUCK = text => `\x1b[2m\x1b[9m${text}\x1b[0m`;
const SENT = text => `\x1b[100m${text}\x1b[0m`;
const BULLET = '⏺', GUTTER = '  ⎿  ', HANG = 5;
const THINK_IN = '(thinking) ';
const EXPAND = 'ctrl+o to expand';
const LCS_CELLS = 250000;   // the largest diff compared line by line; a bigger one is drawn as a flat replace
const CONTEXT = 3;          // how many unchanged lines a diff keeps either side of a change

// ── parse ──────────────────────────────────────────────────────────────────

// The messages a log's lines hold, in order. A line's kind is its lead-in, as
// session.js writes it; the lines indented under a result, a prompt or a
// thought belong to it. Consecutive lines of the agent's own text are one
// message, so its markdown (a list, a fence, a table) is drawn as one block.
// A '> ' line is a markdown quote when the line before it is the agent's text,
// and a sent prompt otherwise (accepted limit: a quote opening a message right
// after a tool result reads as a prompt).
function parse(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const under = indent => {
      const body = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith(indent)) body.push(lines[++i].slice(indent.length));
      return body;
    };
    if (line.startsWith('{"type":')) items.push({ kind: 'event', body: [line] });
    else if (line.startsWith('▶ ')) items.push(call(line));
    else if (line.startsWith('◀ ')) items.push({ kind: 'result', body: [line.slice(2), ...under('  ')] });
    else if (line.startsWith(THINK_IN)) items.push({ kind: 'thinking', body: [line.slice(THINK_IN.length), ...under(' '.repeat(THINK_IN.length))] });
    else if (line.startsWith('■ ')) items.push({ kind: 'turn', body: [line] });
    else if (/^\[.*\]$/.test(line)) items.push({ kind: 'system', body: [line] });
    else if (/^>( |$)/.test(line) && items.at(-1)?.kind !== 'text') items.push({ kind: 'prompt', body: [line.slice(2), ...under('  ')] });
    else if (items.at(-1)?.kind === 'text') items.at(-1).body.push(line);
    else items.push({ kind: 'text', body: [line] });
  }
  return pair(items);
}

// A '▶ <tool> <input JSON>' line: its tool and its input read back. A log
// written by hand could hold input that is no JSON — then the raw text stands
// in for the arguments and nothing throws.
function call(line) {
  const at = line.indexOf(' ', 2);
  const raw = at < 0 ? '' : line.slice(at + 1);
  let input = null;
  try { input = JSON.parse(raw); } catch { /* not JSON: `raw` is shown instead */ }
  return { kind: 'call', tool: at < 0 ? line.slice(2) : line.slice(2, at), input: input && typeof input === 'object' ? input : null, raw };
}

// Each result answers the oldest call not yet answered (as Claude answers them
// in order), so parallel calls pair up right. A result with no call before it —
// a log read from its tail (readSessionTail) starts mid-turn — stays on its own.
function pair(items) {
  const open = [];
  for (const item of items) {
    if (item.kind === 'call') open.push(item);
    else if (item.kind === 'result') {
      item.error = item.body[0]?.startsWith('error: ') ?? false;
      const call = open.shift();
      if (call) { call.result = item; item.under = call; }
    }
  }
  return items;
}

// ── tool names and result summaries ────────────────────────────────────────

const firstLine = text => String(text ?? '').split('\n')[0];
// What Claude Code puts in a tool's parentheses: its one telling argument.
const ARGUMENT = {
  Bash: input => firstLine(input.command),
  Read: input => input.file_path,
  Write: input => input.file_path,
  Edit: input => input.file_path,
  MultiEdit: input => input.file_path,
  Task: input => input.description,
  WebFetch: input => input.url,
  WebSearch: input => input.query,
};
const RENAMED = { Edit: 'Update', MultiEdit: 'Update' };
const EDITS = new Set(['Edit', 'MultiEdit', 'Write']);
const everyArgument = input => Object.entries(input).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');

// titleOf(item) — a tool call as Claude Code names it: `Bash(npm test)`,
// `Read(src/tui/app.js)`, `Update(a.js)` for an edit, `Grep(pattern: "foo",
// path: "src")` for a tool with no one telling argument, an MCP tool as
// `<server> - <tool> (MCP)(…)`, and TodoWrite as `Update Todos`.
function titleOf({ tool, input, raw }) {
  if (tool === 'TodoWrite') return 'Update Todos';
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
  const name = mcp ? `${mcp[1]} - ${mcp[2]} (MCP)` : RENAMED[tool] ?? tool;
  if (!input) return `${name}(${raw})`;
  return `${name}(${(mcp ? null : ARGUMENT[tool]?.(input)) ?? everyArgument(input)})`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const size = chars => (chars >= 1024 * 1024 ? `${(chars / 1024 / 1024).toFixed(1)}MB` : chars >= 1024 ? `${(chars / 1024).toFixed(1)}KB` : `${chars}B`);

// summaryOf(tool, input, body) — Claude Code's one-line answer for the tools
// that have one, or null for a result shown by its first lines.
function summaryOf(tool, input, body) {
  if (tool === 'Read') return `Read ${plural(body.length, 'line')}`;
  if (tool === 'Grep') return input?.output_mode === 'content' ? `Found ${plural(body.length, 'line')}` : `Found ${body.length} match${body.length === 1 ? '' : 'es'}`;
  if (tool === 'Glob' || tool === 'LS') return `Found ${plural(body.length, 'file')}`;
  if (tool === 'WebFetch') return `Received ~${size(body.join('\n').length)}`;
  return null;
}

// ── line diffs ─────────────────────────────────────────────────────────────

const splitLines = text => (text ? String(text).split('\n') : []);

// lineDiff(old, neu) — the change from one text's lines to another's, each row
// '-' removed, '+' added or ' ' kept, with at most CONTEXT kept lines either
// side of a change. A diff whose table of comparisons would be bigger than
// LCS_CELLS is drawn as a flat replace — every line out, then every line in —
// so a huge edit costs no more than reading it.
export function lineDiff(old, neu) {
  if (old.length * neu.length > LCS_CELLS) return [...old.map(l => `-${l}`), ...neu.map(l => `+${l}`)];
  const common = Array.from({ length: old.length + 1 }, () => new Uint32Array(neu.length + 1));
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = neu.length - 1; j >= 0; j--) {
      common[i][j] = old[i] === neu[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const script = [];
  let i = 0, j = 0;
  while (i < old.length && j < neu.length) {
    if (old[i] === neu[j]) script.push(` ${old[i++]}`), j++;
    else if (common[i + 1][j] >= common[i][j + 1]) script.push(`-${old[i++]}`);
    else script.push(`+${neu[j++]}`);
  }
  while (i < old.length) script.push(`-${old[i++]}`);
  while (j < neu.length) script.push(`+${neu[j++]}`);
  return script.filter((row, at) => row[0] !== ' ' || script.some((other, k) => other[0] !== ' ' && Math.abs(k - at) <= CONTEXT));
}

// ── draw ───────────────────────────────────────────────────────────────────

// The rows a result or an edit block sits on: the first under the '  ⎿  '
// gutter, the rest hung under it, each already painted by its caller.
const gutter = (rows, width) => rows.flatMap((row, i) => wrapLine(`${i ? ' '.repeat(HANG) : GUTTER}${row}`, width, HANG));
// The first `keep` of a block's lines, how many are left said after them.
const capped = (body, keep) => (body.length <= keep ? body : [...body.slice(0, keep), `… +${body.length - keep} lines (${EXPAND})`]);

// A tool call: its bullet and name, cut to the width with an ellipsis (shown
// in full when expanded), then what it did — a todo list's checklist, an
// edit's summary and diff, or its result under the gutter.
function callRows(item, { width, rows, expand }) {
  const head = `${(item.result?.error ? RED : GREEN)(BULLET)} ${titleOf(item)}`;
  const title = visible(head) <= width ? [head]
    : expand ? wrapLine(head, width, 2)
      : [`${clip(head, Math.max(1, width - 1))}…`];
  return [...title, ...answerRows(item, { width, rows, expand })];
}

function answerRows(item, { width, rows, expand }) {
  if (item.result?.error) return gutter(capped(item.result.body, expand ? Infinity : CONTEXT).map(RED), width);
  if (item.tool === 'TodoWrite' && Array.isArray(item.input?.todos)) return gutter(item.input.todos.map(todoRow), width);
  if (EDITS.has(item.tool) && item.input) return gutter(editRows(item, { rows, expand }), width);
  if (!item.result) return [];
  const body = item.result.body;
  if (expand) return gutter(body, width);
  const summary = summaryOf(item.tool, item.input, body);
  return gutter(summary ? [summary] : capped(body, CONTEXT), width);
}

// A todo as its checklist line: pending, in progress (bold), done (dim, struck
// through) — never the call's JSON, and never capped.
const todoRow = todo => {
  const text = todo?.content ?? '';
  if (todo?.status === 'in_progress') return BOLD(`◼ ${text}`);
  if (todo?.status === 'completed') return STRUCK(`☒ ${text}`);
  return `☐ ${text}`;
};

// An Edit, MultiEdit or Write: Claude Code's summary of the change, then the
// change itself as a line diff — removed lines red, added green, kept lines
// plain — capped at the room the box has, with how many rows are left said.
function editRows(item, { rows, expand }) {
  const input = item.input;
  const path = input.file_path ?? '';
  const edits = item.tool === 'MultiEdit' ? [input.edits ?? []].flat()
    : item.tool === 'Write' ? [{ old_string: '', new_string: input.content ?? '' }]
      : [{ old_string: input.old_string ?? '', new_string: input.new_string ?? '' }];
  const diff = edits.flatMap(edit => lineDiff(splitLines(edit.old_string), splitLines(edit.new_string)));
  const summary = item.tool === 'Write'
    ? `Wrote ${plural(splitLines(input.content ?? '').length, 'line')} to ${path}`
    : `Updated ${path} with ${plural(diff.filter(row => row[0] === '+').length, 'addition')} and ${plural(diff.filter(row => row[0] === '-').length, 'removal')}`;
  const room = expand ? Infinity : Math.max(CONTEXT, rows - 4);
  const shown = diff.slice(0, room);
  const paint = row => (row[0] === '-' ? RED(row) : row[0] === '+' ? GREEN(row) : row);
  return [summary, ...shown.map(paint), ...(diff.length > shown.length ? [`… +${diff.length - shown.length} lines (${EXPAND})`] : [])];
}

// One message's rows, blank when it draws nothing (a raw event line while
// expand is off, a result already drawn under its call).
function itemRows(item, opts) {
  const { width, expand } = opts;
  if (item.kind === 'call') return callRows(item, opts);
  if (item.kind === 'result') return item.under ? [] : gutter(capped(item.body, expand ? Infinity : CONTEXT).map(row => (item.error ? RED(row) : row)), width);
  if (item.kind === 'event') return expand ? item.body.flatMap(line => wrapLine(DIM(line), width, 2)) : [];
  if (item.kind === 'turn' || item.kind === 'system') return item.body.flatMap(line => wrapLine(DIM(line), width, 2));
  if (item.kind === 'thinking') {
    // The thought folds to its headline; a thought of one line has nothing to
    // fold under it, so it reads the same folded as it does expanded.
    const body = item.body.flatMap(line => wrapLine(THINKING(`  ${line}`), width, 2));
    return [THINKING('✻ Thinking…'), ...(expand || item.body.length <= 1 ? body : [])];
  }
  if (item.kind === 'prompt') {
    const rows = item.body.flatMap((line, i) => wrapLine(`${i ? '  ' : '> '}${line}`, width, 2));
    return rows.map(row => SENT(Number.isFinite(width) ? pad(row, width) : row));
  }
  const text = markdown(item.body, width - 2);   // the agent's own text, under its bullet
  return text.map((row, i) => (i ? (row ? `  ${row}` : '') : `${BULLET} ${row}`));
}

// One frame of a long log is drawn again on every keypress and every tick, and
// main.js replaces a log's array only when it reads the session again — so the
// last render is kept and handed back while the lines, the size and the toggle
// are the same ones.
let last = null;

// chatLines(lines, { width, rows, expand }) — a session log's lines as the rows
// a chat view draws, each at most `width` columns wide, in a box `rows` tall.
// The lines are never changed: every other reader of a session log (settlePending,
// memoryUse, finish.js, steps.js) sees the array exactly as it was given.
export function chatLines(lines, { width = Infinity, rows = Infinity, expand = false } = {}) {
  if (last && last.lines === lines && last.width === width && last.rows === rows && last.expand === expand) return last.out;
  const out = [];
  for (const item of parse(lines ?? [])) {
    const drawn = itemRows(item, { width, rows, expand });
    if (drawn.length) out.push('', ...drawn);   // a blank row before each message
  }
  last = { lines, width, rows, expand, out };
  return out;
}
