// An agent's session log: where it lives, what its events read as, and an
// agent process writing it as the supervisor runs one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, appendFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionDir, eventLines, readSession, sessionModified, memoryUse } from '../../src/agents/session.js';
import * as session from '../../src/agents/session.js';   // readSessionTail is ASS-188's, by the namespace so the suite still runs before it is there
import { startAgent } from '../../src/agents/process.js';
import { until } from '../support/until.js';


test('a session lives in agents/ under the root, named for its agent and the moment it was created', () => {
  assert.equal(sessionDir('/repo', 'Daredevil', '2026-10-07T23:52:05Z'), '/repo/agents/Daredevil-20261007T235205Z');
  assert.equal(sessionDir('/repo', 'Daredevil', '2026-10-07T23:52:05.123Z'), '/repo/agents/Daredevil-20261007T235205Z');
});

test('stream-json events read as text: what the agent says and thinks, the tools it calls and what they return, each turn\'s end', () => {
  const line = event => eventLines(JSON.stringify(event));
  assert.deepEqual(line({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5' }), ['[session s-1 started on claude-opus-5-5]']);
  assert.deepEqual(line({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'Check the tests.' },
    { type: 'thinking', thinking: '', signature: 'x' },               // redacted: nothing to read
    { type: 'text', text: 'Running them.\nNow.' },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
  ] } }), ['(thinking) Check the tests.', 'Running them.', 'Now.', '▶ Bash {"command":"npm test"}']);
  assert.deepEqual(line({ type: 'user', message: { content: [
    { type: 'tool_result', content: 'pass 7\nfail 0' },
    { type: 'tool_result', content: [{ type: 'text', text: 'no such file' }], is_error: true },
  ] } }), ['◀ pass 7', '  fail 0', '◀ error: no such file']);
  assert.deepEqual(line({ type: 'result', subtype: 'success', duration_ms: 36400, total_cost_usd: 1.234 }), ['■ turn ended (success) after 36.4s, $1.23 so far']);
  assert.deepEqual(line({ type: 'rate_limit_event', status: 'ok' }), ['{"type":"rate_limit_event","status":"ok"}']);   // anything else, kept as it came
  assert.deepEqual(eventLines('not json'), ['not json']);
});

test('a session is read back a line at a time, and when it was last written; one never written reads as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-'));
  writeFileSync(join(dir, 'session.txt'), '> hi\nHello.\n');
  assert.deepEqual(readSession(dir), ['> hi', 'Hello.']);
  assert.equal(readSession(join(dir, 'missing')), null);
  utimesSync(join(dir, 'session.txt'), new Date('2026-10-08T00:38:12Z'), new Date('2026-10-08T00:38:12Z'));
  assert.equal(sessionModified(dir), Date.parse('2026-10-08T00:38:12Z'));
  assert.equal(sessionModified(join(dir, 'missing')), null);
});

test('ASS-188 AC2: a session\'s tail is its last bytes — all of a short log, only the whole lines of a long one, nothing for a log never written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  const file = join(dir, 'session.txt');
  writeFileSync(file, '> hi\nHello.\n');
  assert.deepEqual(session.readSessionTail(dir), ['> hi', 'Hello.']);                   // under the limit: every line, the trailing newline stripped
  assert.equal(session.readSessionTail(join(dir, 'missing')), null);
  writeFileSync(file, 'cut me\nkeep me\n');
  assert.deepEqual(session.readSessionTail(dir, 10), ['keep me']);                      // over it: the partial line the cut left is dropped
  writeFileSync(file, `${'—'.repeat(10)}\nplain\n`);
  const cutMidCharacter = session.readSessionTail(dir, 20);                             // the cut falls inside a multibyte character
  assert.deepEqual(cutMidCharacter, ['plain']);
  assert.ok(!cutMidCharacter.join('').includes('\uFFFD'));
  writeFileSync(file, `${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')}\n`);
  const tail = session.readSessionTail(dir);                                            // ~50 KB: the last 32 KB of it
  assert.ok(Buffer.byteLength(tail.join('\n')) <= 32768, `${Buffer.byteLength(tail.join('\n'))} bytes`);
  assert.equal(tail.at(-1), 'line 4999');
  assert.ok(!tail.includes('line 0'));
  writeFileSync(file, '');
  const empty = session.readSessionTail(dir);
  assert.ok(empty == null || empty.join('') === '', JSON.stringify(empty));              // an empty log: no lines to read
});

// A stand-in for claude: says it started, then answers each message with its text and a turn's end.
const FAKE = ['node', '-e', `
  const say = e => console.log(JSON.stringify(e));
  say({ type: 'system', subtype: 'init', session_id: 's-1', model: 'fake' });
  require('readline').createInterface({ input: process.stdin }).on('line', l => {
    const text = JSON.parse(l).message.content;
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'You said ' + text }] } });
    say({ type: 'result', subtype: 'success', duration_ms: 1000, total_cost_usd: 0.5 });
  });
`, '--'];   // what agentCommand appends (--settings) goes to the script, not node

test('an agent runs as one long-lived process, every prompt and every event it prints appended to its session.txt, its end last', async t => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  const events = [];
  let exited = false;
  const agent = startAgent({ name: 'Daredevil', root, command: FAKE, onEvent: e => events.push(e), onExit: () => { exited = true; } });
  t.after(() => agent.stop());                                        // even when an assertion fails: no child left holding the run open
  assert.ok(Number.isInteger(agent.pid));
  assert.match(agent.startTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(agent.dir, sessionDir(root, 'Daredevil', agent.startTime));
  assert.deepEqual(readdirSync(join(root, 'agents')), [`Daredevil-${agent.startTime.replace(/[-:]/g, '')}`]);
  assert.ok(await until(() => events.length));                        // started, so its log reads in order
  agent.send('hello');
  assert.ok(await until(() => events.some(e => e.type === 'result')));
  assert.equal(events[0].type, 'system');
  agent.stop();
  assert.ok(await until(() => exited));
  const log = readSession(agent.dir);
  assert.deepEqual(log.slice(0, -1), ['[session s-1 started on fake]', '> hello', 'You said hello', '■ turn ended (success) after 1.0s, $0.50 so far']);
  assert.match(log.at(-1), /^\[agent exited \((SIGTERM|code \d+)\)\]$/);
});

test('each prompt queued in the session\'s inbox.jsonl, as agent-interaction:resume-thread queues it, is sent as send() sends it; a line still being written waits for its end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  const agent = startAgent({ name: 'Daredevil', root, command: FAKE });
  try {
    const inbox = join(agent.dir, 'inbox.jsonl');
    appendFileSync(inbox, Buffer.concat([Buffer.from(`${JSON.stringify({ prompt: 'first\nline' })}\n{"prompt":"sec`), Buffer.from('—').subarray(0, 1)]));
    assert.ok(await until(() => readSession(agent.dir).includes('You said first')));
    assert.ok(readSession(agent.dir).includes('> first'));
    const log = readSession(agent.dir);
    assert.equal(log[log.indexOf('> first') + 1], '  line');   // a multi-line prompt (ASS-43): one message, its later lines indented under its '> '
    assert.ok(!readSession(agent.dir).some(l => l.includes('sec')));
    appendFileSync(inbox, Buffer.concat([Buffer.from('—').subarray(1), Buffer.from('ond"}\n')]));   // the rest of the line, and of its dash
    assert.ok(await until(() => readSession(agent.dir).includes('You said sec—ond')));
    assert.ok(readSession(agent.dir).includes('> sec—ond'));
  } finally {
    agent.stop();
  }
});

test('what an agent prints on stderr is in its session too', async () => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  let exited = false;
  const agent = startAgent({ name: 'Spock', root, command: ['node', '-e', 'console.error("trouble")', '--'], onExit: () => { exited = true; } });
  assert.ok(await until(() => exited));
  assert.deepEqual(readSession(agent.dir), ['[stderr] trouble', '[agent exited (code 0)]']);
});

test('ASS-62 AC5: a session whose memory server (hindsight) failed to connect says memory was unavailable, under its start; a connected one says nothing more', () => {
  const init = servers => eventLines(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', mcp_servers: servers }));
  assert.deepEqual(init([{ name: 'hindsight', status: 'failed' }]), ['[session s1 started on m]', '[memory unavailable: the hindsight MCP server failed; this step runs without memory]']);
  assert.deepEqual(init([{ name: 'hindsight', status: 'connected' }]), ['[session s1 started on m]']);
  assert.deepEqual(init(undefined), ['[session s1 started on m]']);
});

// A session log as process.js writes it: each stream-json event through eventLines.
const logOf = events => events.flatMap(e => eventLines(JSON.stringify(e)));
const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const answer = (id, text, extra = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...extra }] } });
const said = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const units = n => JSON.stringify({ results: Array.from({ length: n }, (_, i) => ({ id: `u${i}`, text: `fact ${i}` })) }, null, 2);

test('ASS-147 AC1: memoryUse counts a session log\'s hindsight calls — recall and reflect as recalls, the memories each recall returned, retain as saves, delete_document as deletes', () => {
  const log = logOf([
    { type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5' },
    use('a', 'mcp__hindsight__recall', { query: 'pnpm toolchain' }),
    answer('a', units(3)),                                               // pretty-printed, as Hindsight's MCP answers
    said('  indented text after a result is not part of it'),
    use('b', 'Bash', { command: 'npm test' }),
    answer('b', '{"results":[1,2,3,4,5]}'),                              // another tool's answer counts nothing
    { type: 'assistant', message: { content: [                         // two calls at once, answered in order
      { type: 'tool_use', id: 'c', name: 'mcp__hindsight__recall', input: { query: 'lockfile' } },
      { type: 'tool_use', id: 'd', name: 'mcp__hindsight__reflect', input: { query: 'why' } }] } },
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: units(1) }] },
      { type: 'tool_result', tool_use_id: 'd', content: [{ type: 'text', text: '{"text":"because","based_on":[1,2]}' }] }] } },
    use('e', 'mcp__hindsight__recall', { query: 'down' }),
    answer('e', 'connection refused', { is_error: true }),              // a failed recall: a recall, nothing returned
    use('f', 'mcp__hindsight__retain', { content: 'pnpm 9', document_id: 'toolchain' }),
    answer('f', '{"status":"accepted"}'),
    use('g', 'mcp__hindsight__retain', { content: 'zot on loopback' }),
    answer('g', '{"status":"accepted"}'),
    use('h', 'mcp__hindsight__delete_document', { document_id: 'old' }),
    answer('h', '{"success":true}'),
    { type: 'result', subtype: 'success', duration_ms: 1000, total_cost_usd: 0.5 },
  ]);
  assert.deepEqual(memoryUse(log), { recalls: 4, returned: 4, saves: 2, deletes: 1 });
});

test('ASS-147 AC1: a session without memory, and one with no log at all, count zeros', () => {
  const zeros = { recalls: 0, returned: 0, saves: 0, deletes: 0 };
  assert.deepEqual(memoryUse(logOf([said('no memory here'), use('a', 'Bash', { command: 'ls' }), answer('a', units(2))])), zeros);
  assert.deepEqual(memoryUse(null), zeros);
});
