// An agent's session log: agents/<agent-name>-<created>/session.txt in the
// data folder (data/: src/data-folder.js), one per agent process, holding everything it was sent and printed
// as text. A restarted agent is a new process, so a new session.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

// sessionDir(data, name, startTime) — the folder of the session agent `name`
// started at `startTime` (any date string): <data>/agents/<name>-YYYYMMDDTHHMMSSZ.
export const sessionDir = (data, name, startTime) =>
  join(data, 'agents', `${name}-${new Date(startTime).toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')}`);

// readSession(dir) — its session.txt's lines, or null when there is none.
export function readSession(dir) {
  try {
    return readFileSync(join(dir, 'session.txt'), 'utf8').replace(/\n$/, '').split('\n');
  } catch {
    return null;
  }
}

// readSessionTail(dir, bytes) — the last lines of its session.txt: at most the
// last `bytes` of it, so following every agent's log at once (the TUI's agents
// grid, ASS-188) costs the same however long the logs grow. The first line a
// cut leaves is partial — it may even start inside a multibyte character — so
// it is dropped unless the whole file was read. Null when there is no log.
export function readSessionTail(dir, bytes = 32768) {
  const file = join(dir, 'session.txt');
  let fd;
  try {
    const { size } = statSync(file);
    const start = Math.max(0, size - bytes);
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(size - start);
    if (buffer.length) readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').replace(/\n$/, '').split('\n');
    return start ? lines.slice(1) : lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// sessionModified(dir) — when its session.txt was last written (ms), or null
// when there is none.
export function sessionModified(dir) {
  try {
    return statSync(join(dir, 'session.txt')).mtimeMs;
  } catch {
    return null;
  }
}

// eventLines(line) — a line of Claude's stream-json output as text: what the
// agent thinks (when not redacted) and says, "▶ <tool> <input>" for a tool it calls, "◀ " before
// what a tool returns, and a line for the session's start (and memory unavailable, ASS-62) and each turn's end.
// Nothing is cut; any other line is kept as it came.
export function eventLines(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return [line];
  }
  const content = [event.message?.content ?? []].flat();
  const text = c => (typeof c === 'string' ? c : [c ?? []].flat().map(part => part.text ?? JSON.stringify(part)).join('\n'));
  const lines = (first, body) => body.split('\n').map((l, i) => (i ? ' '.repeat(first.length) : first) + l);
  // Its memory (ASS-62): the hindsight MCP server failing to connect is said, as control says one not answering.
  if (event.type === 'system' && event.subtype === 'init') {
    const memory = event.mcp_servers?.find(s => s.name === 'hindsight' && s.status === 'failed');
    return [`[session ${event.session_id} started on ${event.model}]`, ...(memory ? ['[memory unavailable: the hindsight MCP server failed; this step runs without memory]'] : [])];
  }
  if (event.type === 'assistant') {
    return content.flatMap(c => (c.type === 'text' ? c.text.split('\n')
      : c.type === 'thinking' ? (c.thinking ? lines('(thinking) ', c.thinking) : [])
        : c.type === 'tool_use' ? [`▶ ${c.name} ${JSON.stringify(c.input)}`]
          : [JSON.stringify(c)]));
  }
  if (event.type === 'user' && content.every(c => c.type === 'tool_result')) {
    return content.flatMap(c => lines('◀ ', `${c.is_error ? 'error: ' : ''}${text(c.content)}`));
  }
  if (event.type === 'result') {
    return [`■ turn ended (${event.subtype}) after ${(event.duration_ms / 1000).toFixed(1)}s, $${(event.total_cost_usd ?? 0).toFixed(2)} so far`];
  }
  return [line];
}

// The hindsight MCP tools (ASS-62) as memoryUse counts them.
const MEMORY_TOOLS = { recall: 'recalls', reflect: 'recalls', retain: 'saves', delete_document: 'deletes' };

// memoryUse(lines) — how a session used its memory (ASS-147), counted from
// its session log's lines (readSession; null counts zeros): { recalls — the
// hindsight recall and reflect calls, returned — the memories each recall's
// answer listed (its results; reflect's synthesis lists none), saves — retain
// calls, deletes — delete_document calls }. Each "◀ " answer is paired with
// the oldest "▶ " call not yet answered, as Claude answers calls in order; an
// answer's own lines are those indented under it, read as JSON up to the
// longest run of them that parses, so text the agent says after it is not
// taken for part of it. An answer that is an error, or no JSON, returned none.
export function memoryUse(lines) {
  const use = { recalls: 0, returned: 0, saves: 0, deletes: 0 };
  const calls = [];
  for (let i = 0; i < (lines ?? []).length; i++) {
    const line = lines[i];
    if (line.startsWith('▶ ')) {
      const tool = line.slice(2).split(' ')[0];
      calls.push(tool);
      const name = tool.replace(/^mcp__hindsight__/, '');
      if (name !== tool && Object.hasOwn(MEMORY_TOOLS, name)) use[MEMORY_TOOLS[name]]++;
    } else if (line.startsWith('◀ ') && calls.shift() === 'mcp__hindsight__recall') {
      const body = [line.slice(2)];
      while (lines[i + 1]?.startsWith('  ')) body.push(lines[++i].slice(2));
      use.returned += returnedBy(body);
    }
  }
  return use;
}

// How many memories a recall's answer (its lines) listed: { results: [...] } or a bare list.
function returnedBy(body) {
  for (let n = body.length; n > 0; n--) {
    try {
      const answer = JSON.parse(body.slice(0, n).join('\n'));
      return (Array.isArray(answer) ? answer : answer?.results ?? []).length;
    } catch { /* fewer lines */ }
  }
  return 0;
}
