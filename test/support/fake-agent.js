#!/usr/bin/env node
// A stand-in for `claude -p --dangerously-skip-permissions --input-format stream-json --output-format
// stream-json` for the tests: prints an init event (session "fake-session"),
// then a line "args <its arguments>" and one "config <its CLAUDE_CONFIG_DIR, or ->", and answers each user message on stdin
// with an assistant line and a result event — total_cost_usd running up by 0.5
// a turn, a turn's usage, and structured_output from FAKE_OUTPUT (JSON) when
// set. With FAKE_RATE_LIMIT (epoch seconds) each turn is instead what a
// rate-limited Claude prints: a rejected rate_limit_event resetting then, and
// a result with no output and no cost. With FAKE_ERROR each turn ends in an
// error result (is_error); with FAKE_EXIT the process dies on its first
// message, no result. With FAKE_HOLD (a file path) each answer waits while
// that file exists, so a test decides when a turn ends; with FAKE_HOLD_RESULT
// (a file path) only its result waits, its assistant event already said, so a
// turn can be caught mid-way (ASS-271). With FAKE_MEMORY (a
// JSON list of { tool, arguments }) each turn first makes those MCP tool calls
// on the hindsight server its --mcp-config names (ASS-62), as a JSON-RPC
// tools/call to its url — printed as Claude prints an MCP call, a tool_use of
// mcp__hindsight__<tool> and its tool_result (ASS-147) — then saying "memory <tool> <what it returned>" for each,
// or "memory <tool> unreachable" when the server cannot be reached; with no
// --mcp-config, "memory: no MCP configuration". `auth status` answers
// as claude auth status does (FAKE_AUTH, below). The top-level "You said"
// assistant event carries parent_tool_use_id: null, message.model (FAKE_MODEL,
// default "fake-model") and the turn's message.usage (ASS-190); with
// FAKE_SUBAGENT_USAGE (a JSON { input_tokens, ... }) a sub-agent assistant
// event (parent_tool_use_id: "sub1") with that usage comes first. With
// FAKE_CONTEXT_WINDOW (a token count) the result event's modelUsage names it
// for the turn's model. With FAKE_PENDING (a keyword of PENDING_TOOLS, below,
// ASS-334) a turn first says a tool_use of a tool that works in the background,
// so its turn ends with work pending; FAKE_PENDING_UNTIL (a turn number) limits
// that to that turn and the ones before it. With FAKE_NO_START it cannot start (ASS-167): says
// "claude: command not found" on stderr and exits 127, no init event. With
// FAKE_API_KEY_SOURCE the init event names it as its apiKeySource (ASS-216):
// "none" is a subscription login. With FAKE_UNFINISHED (a turn number, ASS-268)
// that turn and every later one says its assistant line and never ends: no
// result, as an agent killed or dying mid-turn. Ends when stdin does. Under test/support/, which npm test's pattern
// (test/**/*.test.js) leaves alone: run as a test it would wait on stdin forever.
import { existsSync } from 'node:fs';
// `auth status`, as claude auth status answers it: logged in as fake@example.com;
// FAKE_AUTH=logged-out not logged in (exit 1, as claude), FAKE_AUTH=broken a failure, no JSON,
// FAKE_AUTH=api-key logged in with authMethod api_key (an Anthropic Console key login, ASS-215).
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  if (process.env.FAKE_AUTH === 'broken') { process.stderr.write('auth: something broke\n'); process.exit(1); }
  const loggedIn = process.env.FAKE_AUTH !== 'logged-out';
  const authMethod = process.env.FAKE_AUTH === 'api-key' ? 'api_key' : 'claude.ai';
  process.stdout.write(`${JSON.stringify(loggedIn ? { loggedIn, authMethod, email: 'fake@example.com', orgName: 'Fake Org', subscriptionType: 'max', configDirectory: process.env.CLAUDE_CONFIG_DIR ?? null } : { loggedIn })}\n`);
  process.exit(loggedIn ? 0 : 1);   // as claude does: not logged in exits 1, its JSON still printed
}
if (process.env.FAKE_NO_START) { process.stderr.write('claude: command not found\n'); process.exit(127); }
const say = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const model = process.env.FAKE_MODEL ?? 'fake-model';
// What FAKE_PENDING names (ASS-334), said as a tool_use assistant block before
// the turn's result: the five shapes that leave work pending — bash, schedule,
// monitor, workflow, agent — and two that do not, schedule-stop (a wakeup
// cancelled) and agent-foreground (a sub-agent run in the foreground).
const PENDING_TOOLS = {
  bash: { name: 'Bash', input: { command: 'sleep 1', run_in_background: true } },
  schedule: { name: 'ScheduleWakeup', input: { delaySeconds: 60 } },
  monitor: { name: 'Monitor', input: { until: 'done', timeoutSeconds: 60 } },
  workflow: { name: 'Workflow', input: { script: 'export const meta = {}' } },
  agent: { name: 'Agent', input: { prompt: 'go' } },
  'schedule-stop': { name: 'ScheduleWakeup', input: { stop: true } },
  'agent-foreground': { name: 'Agent', input: { prompt: 'go', run_in_background: false } },
};
let turns = 0, buffer = '';
say({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake', ...(process.env.FAKE_API_KEY_SOURCE ? { apiKeySource: process.env.FAKE_API_KEY_SOURCE } : {}) });
say({ type: 'assistant', message: { content: [{ type: 'text', text: `args ${process.argv.slice(2).join(' ')}` }] } });
say({ type: 'assistant', message: { content: [{ type: 'text', text: `config ${process.env.CLAUDE_CONFIG_DIR ?? '-'}` }] } });
process.stdin.setEncoding('utf8');
const held = () => process.env.FAKE_HOLD && existsSync(process.env.FAKE_HOLD);
const answerWhenFree = lines => (held() ? setTimeout(answerWhenFree, 20, lines) : answer(lines));
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  answerWhenFree(lines);
});
// The MCP tool calls FAKE_MEMORY lists, made on --mcp-config's hindsight server, in order.
async function remember() {
  const at = process.argv.indexOf('--mcp-config');
  if (at < 0) return say({ type: 'assistant', message: { content: [{ type: 'text', text: 'memory: no MCP configuration' }] } });
  const { url } = JSON.parse(process.argv[at + 1]).mcpServers.hindsight;
  for (const [i, { tool, arguments: args }] of JSON.parse(process.env.FAKE_MEMORY).entries()) {
    let text;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: tool, arguments: args } }) });
      text = (await res.json()).result.content[0].text;
    } catch { text = 'unreachable'; }
    say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `m${i}`, name: `mcp__hindsight__${tool}`, input: args }] } });
    say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `m${i}`, content: [{ type: 'text', text }], ...(text === 'unreachable' ? { is_error: true } : {}) }] } });
    say({ type: 'assistant', message: { content: [{ type: 'text', text: `memory ${tool} ${text}` }] } });
  }
}
async function answer(lines) {
  for (const line of lines.filter(Boolean)) {
    const text = JSON.parse(line).message.content;
    turns++;
    if (process.env.FAKE_MEMORY) await remember();
    if (process.env.FAKE_PENDING && (!process.env.FAKE_PENDING_UNTIL || turns <= Number(process.env.FAKE_PENDING_UNTIL))) {
      say({ type: 'assistant', parent_tool_use_id: null, message: { model, content: [{ type: 'tool_use', id: `p${turns}`, ...PENDING_TOOLS[process.env.FAKE_PENDING] }] } });
    }
    if (process.env.FAKE_EXIT) process.exit(1);
    if (process.env.FAKE_ERROR) {
      say({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 500, total_cost_usd: turns * 0.5, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
      continue;
    }
    if (process.env.FAKE_RATE_LIMIT) {
      say({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Number(process.env.FAKE_RATE_LIMIT), rateLimitType: 'five_hour', overageStatus: 'rejected' } });
      say({ type: 'result', subtype: 'success', duration_ms: 800, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
      continue;
    }
    if (process.env.FAKE_SUBAGENT_USAGE) {
      say({ type: 'assistant', parent_tool_use_id: 'sub1', message: { model, usage: JSON.parse(process.env.FAKE_SUBAGENT_USAGE), content: [{ type: 'text', text: 'sub-agent' }] } });
    }
    say({ type: 'assistant', parent_tool_use_id: null, message: { model, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, content: [{ type: 'text', text: `You said ${text.slice(0, 40)}` }] } });
    while (process.env.FAKE_HOLD_RESULT && existsSync(process.env.FAKE_HOLD_RESULT)) await new Promise(resolve => setTimeout(resolve, 20));
    if (process.env.FAKE_UNFINISHED && turns >= Number(process.env.FAKE_UNFINISHED)) continue;
    say({
      type: 'result', subtype: 'success', duration_ms: 1000, total_cost_usd: turns * 0.5,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
      ...(process.env.FAKE_CONTEXT_WINDOW ? { modelUsage: { [model]: { contextWindow: Number(process.env.FAKE_CONTEXT_WINDOW) } } } : {}),
      ...(process.env.FAKE_OUTPUT ? { structured_output: JSON.parse(process.env.FAKE_OUTPUT) } : {}),
    });
  }
}
process.stdin.on('end', () => process.exit(0));
