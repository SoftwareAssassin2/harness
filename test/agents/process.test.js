// The options control starts an agent with: the record's start time, the
// model and output schema flags, the dev container, and what the process
// tells control back — its session id and each turn's end with its cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionDir, readSession } from '../../src/agents/session.js';
import { startAgent, agentCommand, billed } from '../../src/agents/process.js';
import { fakeVm } from '../support/fake-vm.js';
import { until } from '../support/until.js';

// A stand-in for claude that prints its arguments, says it started, and ends a
// turn per message with a running total cost and a structured output.
const FAKE = join(import.meta.dirname, '..', 'support', 'fake-agent.js');
// startAgent for test t, with `ended` (a promise of its exit) and `stopped()`
// (stop, then its exit); whatever the test does, its process is gone when the
// test ends — its group killed and, in a VM, the process under its marker
// killed here, where the fake VM runs it — so a failing test never leaves a
// child holding npm test open (ASS-109).
function started(t, options) {
  let exit;
  const ended = new Promise(resolve => { exit = resolve; });
  const agent = startAgent({ ...options, onExit: (code, signal) => { options.onExit?.(code, signal); exit({ code, signal }); } });
  t.after(() => {
    try { process.kill(-agent.pid, 'SIGKILL'); } catch { /* gone already */ }
    if (agent.marker) spawnSync('pkill', ['-KILL', '-f', agent.marker]);
    return ended;
  });
  return Object.assign(agent, { ended, stopped: () => { agent.stop(); return ended; } });
}

test('an agent started for a record uses the record\'s start time, so the inbox agent:dispatch queued before it is the one it reads', async t => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  const agent = started(t, { name: 'Hulk', root, command: ['node', FAKE], startTime: '2026-10-07T23:52:05Z' });
  assert.equal(agent.startTime, '2026-10-07T23:52:05Z');
  assert.equal(agent.dir, sessionDir(root, 'Hulk', '2026-10-07T23:52:05Z'));
  await agent.stopped();
});

test('an agent may be given its session folder outright, in place of agents/<name>-<start> (ASS-33\'s chats)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  const agent = started(t, { name: 'chat', root, dir: join(root, 'chats', 'c1'), command: ['node', FAKE] });
  assert.equal(agent.dir, join(root, 'chats', 'c1'));
  assert.ok(await until(() => readSession(agent.dir)?.some(l => l.startsWith('[session '))));
  await agent.stopped();
});

test('agentCommand adds --model, --json-schema and --resume to the claude command; it never wraps it in docker exec — an agent runs on the host, told the container', () => {
  const base = ['claude', '-p'];
  const off = ['--settings', '{"sandbox":{"enabled":false}}'];   // last, see the ASS-108 test below
  assert.deepEqual(agentCommand({ command: base }), ['claude', '-p', ...off]);
  assert.deepEqual(agentCommand({ command: base, model: 'claude-opus-5' }), ['claude', '-p', '--model', 'claude-opus-5', ...off]);
  assert.deepEqual(agentCommand({ command: base, jsonSchema: { type: 'object' } }), ['claude', '-p', '--json-schema', '{"type":"object"}', ...off]);
  assert.deepEqual(agentCommand({ command: base, resume: 'sess-1' }), ['claude', '-p', '--resume', 'sess-1', ...off]);   // a chat's ended session, continued (ASS-33)
  assert.deepEqual(agentCommand({ command: base, model: 'm', cwd: '/w', container: 'devc' }), ['claude', '-p', '--model', 'm', ...off]);   // no docker exec, whatever is passed
  assert.deepEqual(agentCommand({ command: base, cwd: '/x' }), ['claude', '-p', ...off]);                 // locally, cwd is where it is spawned, not an argument
  assert.deepEqual(agentCommand({}).slice(0, 2), ['claude', '-p']);                 // the default command
  assert.ok(agentCommand({}).includes('--dangerously-skip-permissions'));           // headless: nobody can answer a permission prompt
});

test('agentCommand adds --append-system-prompt <text> when given a system prompt (a chat\'s rules), before --settings', () => {
  const argv = agentCommand({ command: ['claude', '-p'], resume: 's', systemPrompt: 'Ask first.' });
  assert.deepEqual(argv.slice(0, 6), ['claude', '-p', '--resume', 's', '--append-system-prompt', 'Ask first.']);
  assert.equal(argv.at(-2), '--settings');
  assert.ok(!agentCommand({ command: ['claude', '-p'] }).includes('--append-system-prompt'));
});

test('ASS-62 AC2: agentCommand adds --mcp-config <json> when given an MCP configuration, as it does --json-schema', () => {
  const base = ['claude', '-p'];
  const mcp = { mcpServers: { hindsight: { type: 'http', url: 'http://127.0.0.1:8891/mcp/harness/' } } };
  const argv = agentCommand({ command: base, model: 'm', mcpConfig: mcp });
  assert.deepEqual(argv.slice(0, 6), ['claude', '-p', '--model', 'm', '--mcp-config', JSON.stringify(mcp)]);
  assert.equal(argv.at(-2), '--settings');
  assert.ok(!agentCommand({ command: base }).includes('--mcp-config'));
});

test('a confined agent (ASS-108) starts with its settings file and without --dangerously-skip-permissions: its settings decide what it may do; any other keeps bypass and turns off a sandbox its folder\'s own .claude/settings.json may enable (the harness repo\'s, for interactive sessions)', () => {
  const confined = agentCommand({ confinedBy: '/h/projects/p/host-agent-settings.json', model: 'm' });
  assert.ok(!confined.includes('--dangerously-skip-permissions'));
  assert.deepEqual(confined.slice(-2), ['--settings', '/h/projects/p/host-agent-settings.json']);
  const other = agentCommand({ model: 'm' });
  assert.ok(other.includes('--dangerously-skip-permissions'));
  assert.deepEqual(other.slice(-2), ['--settings', '{"sandbox":{"enabled":false}}']);
});

test('the model and schema reach the process as flags; the session id is captured from the init event; each result reports its turn cost over the last', async t => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  const results = [];
  const agent = started(t, { name: 'Hulk', root, command: ['node', FAKE], model: 'claude-sonnet-5', jsonSchema: { type: 'object' }, onResult: e => results.push({ cost: agent.lastTotalCost, total: e.total_cost_usd }) });
  assert.equal(agent.sessionId, null);
  assert.ok(await until(() => agent.sessionId === 'fake-session'));
  assert.equal(agent.lastTotalCost, 0);
  agent.send('one');
  assert.ok(await until(() => results.length === 1));
  assert.deepEqual(results[0], { cost: 0, total: 0.5 });                          // inside onResult, lastTotalCost is still the previous turn's
  assert.equal(agent.lastTotalCost, 0.5);
  agent.send('two');
  assert.ok(await until(() => results.length === 2));
  assert.deepEqual(results[1], { cost: 0.5, total: 1 });
  await agent.stopped();
  const log = readSession(agent.dir);
  assert.ok(log.some(l => l.includes('args --model claude-sonnet-5 --json-schema {"type":"object"}')), log.join('\n'));
  assert.ok(log.includes('[session fake-session started on fake]'));
});

test('a command that cannot be started is logged in the session rather than thrown, and onExit still comes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  let exited = false;
  const agent = started(t, { name: 'Hulk', root, command: ['/no/such/binary'], onExit: () => { exited = true; } });
  assert.ok(await until(() => exited));
  assert.ok(readFileSync(join(agent.dir, 'session.txt'), 'utf8').includes('ENOENT'));
});

// run-location: vm (ASS-74). limactl is test/support/fake-limactl.js on PATH: it runs the command in a session of its own, as a VM does.
const running = marker => spawnSync('pgrep', ['-f', `[${marker[0]}]${marker.slice(1)}`]).status === 0;

test('an agent in a VM is the same command through `limactl shell --workdir <cwd> <vm> --`, under a marker of its own; its stream-json works as on the host', async t => {
  const root = mkdtempSync(join(tmpdir(), 'root-')), v = fakeVm();
  const results = [];
  const agent = started(t, { name: 'Hulk', root, cwd: '/repos/', vm: 'ass-74-a', command: ['node', FAKE], model: 'claude-opus-5', env: v.env, onResult: e => results.push(e) });
  agent.send('hello');
  assert.ok(await until(() => results.length === 1));
  const [call] = v.calls();
  assert.equal(call.vm, 'ass-74-a');
  assert.equal(call.workdir, '/repos/');
  assert.match(agent.marker, /^harness-step-[0-9a-f-]{36}$/);
  assert.deepEqual(call.argv.slice(0, 2), ['bash', '-c']);
  assert.deepEqual(call.argv.slice(3), [agent.marker, 'node', FAKE, '--model', 'claude-opus-5', '--settings', '{"sandbox":{"enabled":false}}']);   // the JSON whole in the VM (ASS-108)
  await agent.stopped();
});

test('stopping an agent in a VM ends the process inside it too: the local group\'s SIGTERM does not reach the VM, so control pkills its marker there', async t => {
  const root = mkdtempSync(join(tmpdir(), 'root-')), v = fakeVm();
  let exited = null;
  const agent = started(t, { name: 'Hulk', root, cwd: '/repos/', vm: 'ass-74-a', command: ['node', FAKE], env: v.env, onExit: (code, signal) => { exited = { code, signal }; } });
  assert.ok(await until(() => running(agent.marker)), 'it runs, as the VM would run it');
  agent.stop();
  assert.ok(await until(() => exited !== null), 'the local limactl shell ends');
  assert.ok(await until(() => !running(agent.marker)), 'and so does the process in the VM');
  const pkill = v.calls().find(c => c.argv[0] === 'pkill');
  assert.deepEqual(pkill, { vm: 'ass-74-a', workdir: null, argv: ['pkill', '-TERM', '-f', `[h]${agent.marker.slice(1)}`] });
});

// ── ASS-190: with a `usage` option, startAgent writes usage.json beside
// session.txt per event; fake-agent's top-level usage is 10/20/30/40, its
// result repeats it and carries total_cost_usd 0.5 and (with FAKE_CONTEXT_WINDOW)
// a modelUsage window. The estimate's own numbers are pinned in the pure
// session-usage.test.js; here the result lands in the same synchronous burst as
// the assistant event, so what polling sees is the settled end-of-turn state.
const usageOf = dir => (existsSync(join(dir, 'usage.json')) ? JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')) : null);

test('ASS-190 AC1: startAgent with usage writes usage.json beside session.txt; the result sets the exact cost and adopts the window, and does not double-count tokens', async t => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  const prices = { 'fake-model': { input: 3, output: 15, 'cache-read': 0.3, 'cache-write': 3.75 } };
  const agent = started(t, { name: 'Hulk', root, command: ['node', FAKE], usage: { prices, windows: {} }, env: { ...process.env, FAKE_CONTEXT_WINDOW: '200000' } });
  agent.send('one');
  assert.ok(await until(() => usageOf(agent.dir)?.costExact === true));
  const u = usageOf(agent.dir);
  assert.equal(u.model, 'fake-model');
  assert.equal(u.contextTokens, 80);                                                     // input 10 + cache-read 30 + cache-creation 40
  assert.deepEqual(u.tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });  // the result repeats the usage, not added
  assert.equal(u.costUsd, 0.5);
  assert.equal(u.contextWindow, 200000);
  agent.send('two');
  assert.ok(await until(() => usageOf(agent.dir)?.tokens.input === 20));
  assert.deepEqual(usageOf(agent.dir).tokens, { input: 20, output: 40, cacheRead: 60, cacheWrite: 80 });   // two turns, results not double-counted
  await agent.stopped();
});

test('ASS-190 AC1: a sub-agent event adds to cumulative tokens but leaves contextTokens and model as the top-level event set them', async t => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  const agent = started(t, { name: 'Hulk', root, command: ['node', FAKE], usage: { prices: {}, windows: {} },
    env: { ...process.env, FAKE_SUBAGENT_USAGE: JSON.stringify({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }) } });
  agent.send('one');
  assert.ok(await until(() => usageOf(agent.dir)?.costExact === true));
  const u = usageOf(agent.dir);
  assert.deepEqual(u.tokens, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
  assert.equal(u.contextTokens, 80);
  assert.equal(u.model, 'fake-model');
  await agent.stopped();
});

test('ASS-190 AC1: with no usage option, no usage.json is written — existing callers are untouched', async t => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  let results = 0;
  const agent = started(t, { name: 'Hulk', root, command: ['node', FAKE], onResult: () => { results++; } });
  agent.send('hi');
  assert.ok(await until(() => results === 1));
  assert.equal(existsSync(join(agent.dir, 'usage.json')), false);
  await agent.stopped();
});

test('ASS-216 AC1: the agent says what its session is billed to from its init event — subscription when apiKeySource is "none", else api; null until then', async t => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  const env = source => ({ ...process.env, FAKE_API_KEY_SOURCE: source });
  const subscription = started(t, { name: 'Hulk', root, command: ['node', FAKE], env: env('none') });
  assert.equal(subscription.billing, null);
  assert.ok(await until(() => subscription.billing === 'subscription'));
  const api = started(t, { name: 'Thor', root, command: ['node', FAKE], env: env('ANTHROPIC_API_KEY') });
  assert.ok(await until(() => api.billing === 'api'));
  assert.equal(billed(subscription, 0.5), 0);
  assert.equal(billed(api, 0.5), 0.5);
  assert.equal(billed({ billing: null }, 0.5), 0.5);   // no init event: its cost as today
  await subscription.stopped();
  await api.stopped();
});
