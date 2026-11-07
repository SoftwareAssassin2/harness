// The chat screen's agents (ASS-33): one plain Claude process per open chat,
// owned by the dashboard, its log in chats/<id>/, resumed by its session id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSession } from '../../src/agents/session.js';
import { chatRunner, chatSpendArgs } from '../../src/agents/chats.js';
import { until } from '../support/until.js';

const FAKE = join(import.meta.dirname, '..', 'support', 'fake-agent.js');

test('send starts a chat\'s agent in its folder with its env, logs to chats/<id>/, says its session; a running one is reused; stopped, it is resumed by its session id', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chats-'));
  const sessions = [];
  const chats = chatRunner({ data: root, command: ['node', FAKE] });
  t.after(() => chats.stopAll());
  const chat = { id: 'c1', 'session-id': null };
  chats.send(chat, 'hello', { cwd: root, env: { ...process.env, CLAUDE_CONFIG_DIR: '/x/.claude' }, onSession: id => sessions.push(id) });
  assert.equal(chats.dir('c1'), join(root, 'chats', 'c1'));
  assert.ok(await until(() => readSession(chats.dir('c1'))?.some(l => l.startsWith('■ turn ended'))));
  const log = readSession(chats.dir('c1'));
  assert.ok(log.includes('> hello'), log.join('\n'));
  assert.ok(log.includes('config /x/.claude'), log.join('\n'));
  assert.ok(!log.some(l => l.includes('--resume')));
  assert.deepEqual(sessions, ['fake-session']);
  assert.equal(chats.running('c1'), true);
  chats.send(chat, 'again', { cwd: root, onSession: id => sessions.push(id) });
  assert.ok(await until(() => readSession(chats.dir('c1')).filter(l => l.startsWith('■ turn ended')).length === 2));
  assert.equal(readSession(chats.dir('c1')).filter(l => l.startsWith('args ')).length, 1);   // the same process
  chats.stop('c1');
  assert.ok(await until(() => !chats.running('c1')));
  chats.send({ ...chat, 'session-id': 'fake-session' }, 'back', { cwd: root });
  assert.ok(await until(() => readSession(chats.dir('c1')).some(l => l.includes('args') && l.includes('--resume fake-session'))));
  assert.ok(await until(() => readSession(chats.dir('c1')).includes('> back')));
  chats.stopAll();
  assert.ok(await until(() => !chats.running('c1')));
});

test('every chat the runner starts, resumed too, carries its system prompt: the rules it works by', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chats-'));
  const chats = chatRunner({ data: root, command: ['node', FAKE], systemPrompt: 'Confirm first.' });
  t.after(() => chats.stopAll());
  const args = () => readSession(chats.dir('c3'))?.filter(l => l.startsWith('args ')) ?? [];
  chats.send({ id: 'c3', 'session-id': null }, 'hi', { cwd: root });
  assert.ok(await until(() => args().length === 1));
  chats.stop('c3');
  assert.ok(await until(() => !chats.running('c3')));
  chats.send({ id: 'c3', 'session-id': 'fake-session' }, 'back', { cwd: root });
  assert.ok(await until(() => args().length === 2));
  assert.ok(args().every(l => l.includes('--append-system-prompt Confirm first.')), args().join('\n'));
});

test('onCost gets each turn\'s own cost: the result\'s total_cost_usd less the process\'s last, which starts over with each new process (ASS-35)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chats-'));
  const costs = [];
  const chats = chatRunner({ data: root, command: ['node', FAKE] });
  const chat = { id: 'c2', 'session-id': null };
  const options = { cwd: root, onCost: usd => costs.push(usd) };
  t.after(() => chats.stopAll());
  chats.send(chat, 'one', options);
  chats.send(chat, 'two', options);
  assert.ok(await until(() => costs.length === 2));
  chats.stop('c2');
  assert.ok(await until(() => !chats.running('c2')));
  chats.send({ ...chat, 'session-id': 'fake-session' }, 'three', options);   // resumed: its total starts at zero again
  assert.ok(await until(() => costs.length === 3));
  assert.deepEqual(costs, [0.5, 0.5, 0.5]);
});

// ASS-190 (must-fix 4): a chat tile renders through the same tileHeader as an
// agent tile, so send must pass `usage` through to startAgent — else a build
// could wire only control's agents and leave every chat tile's context/cost
// permanently blank, with the suite still green. One case pins the wiring.
test('ASS-190 AC1: send with a usage option writes usage.json into chats/<id>/ beside the chat\'s session.txt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chats-'));
  const chats = chatRunner({ data: root, command: ['node', FAKE] });
  t.after(() => chats.stopAll());
  const prices = { 'fake-model': { input: 3, output: 15, 'cache-read': 0.3, 'cache-write': 3.75 } };
  chats.send({ id: 'c1', 'session-id': null }, 'hello', { cwd: root, usage: { prices, windows: {} } });
  const usageFile = join(chats.dir('c1'), 'usage.json');
  assert.ok(await until(() => existsSync(usageFile) && JSON.parse(readFileSync(usageFile, 'utf8')).model));   // written from its init event on (ASS-268: billing), its model from the first assistant event
  const u = JSON.parse(readFileSync(usageFile, 'utf8'));
  assert.equal(u.model, 'fake-model');
  assert.equal(u.contextTokens, 80);
  assert.ok(u.costUsd != null);
});

test('a chat started confined (ASS-108) runs with its settings file: the chat and ticket-expert screens write only temp (ASS-182)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chats-'));
  const chats = chatRunner({ data: root, command: ['node', FAKE] });
  t.after(() => chats.stopAll());
  chats.send({ id: 'c1', 'session-id': null }, 'hello', { cwd: root, confinedBy: '/h/projects/p/host-agent-settings.json' });
  assert.ok(await until(() => readSession(chats.dir('c1'))?.some(l => l.startsWith('args '))));
  assert.ok(readSession(chats.dir('c1')).some(l => l.startsWith('args ') && l.endsWith('--settings /h/projects/p/host-agent-settings.json')), readSession(chats.dir('c1')).join('\n'));
});

test('ASS-216 AC2: onCost also gets what the turn was billed to, and a subscription turn costs 0', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chats-'));
  const turns = [];
  const chats = chatRunner({ data: root, command: ['node', FAKE] });
  t.after(() => chats.stopAll());
  const onCost = (usd, billing) => turns.push([usd, billing]);
  chats.send({ id: 's', 'session-id': null }, 'one', { cwd: root, env: { ...process.env, FAKE_API_KEY_SOURCE: 'none' }, onCost });
  assert.ok(await until(() => turns.length === 1));
  chats.send({ id: 'a', 'session-id': null }, 'one', { cwd: root, env: { ...process.env, FAKE_API_KEY_SOURCE: 'ANTHROPIC_API_KEY' }, onCost });
  assert.ok(await until(() => turns.length === 2));
  assert.deepEqual(turns, [[0, 'subscription'], [0.5, 'api']]);
});

// ASS-271: a chat-screen turn's cost goes to chat:add-spend against the chat's
// project (main.js sendChat), as a ticket chat's goes to collaboration:add-spend.
test('ASS-271 AC1: a chat-screen turn is recorded by chat:add-spend against its chat\'s project, with its cost and billing — on api and on a subscription', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chats-'));
  const recorded = [];
  const chats = chatRunner({ data: root, command: ['node', FAKE] });
  t.after(() => chats.stopAll());
  for (const [id, source] of [['a', 'ANTHROPIC_API_KEY'], ['s', 'none']]) {
    const chat = { id, project: 'example', 'session-id': null };
    chats.send(chat, 'one', { cwd: root, env: { ...process.env, FAKE_API_KEY_SOURCE: source }, onCost: (usd, billing) => recorded.push(chatSpendArgs(chat, usd, billing)) });
    assert.ok(await until(() => recorded.length === (id === 'a' ? 1 : 2)));
  }
  assert.deepEqual(recorded, [['chat:add-spend', 'example', 'a', '0.5', 'api'], ['chat:add-spend', 'example', 's', '0', 'subscription']]);
  assert.deepEqual(chatSpendArgs({ id: 'x', project: 'p' }, 0.25, null), ['chat:add-spend', 'p', 'x', '0.25']);   // its session never said
  assert.deepEqual(chatSpendArgs({ id: 'x', project: 'p' }, 0.25, 'api', true), ['chat:add-spend', '--estimate', 'p', 'x', '0.25', 'api']);
});

// $1000 a million tokens of every kind: the fake agent's 100-token turn is an
// estimated $0.10 until its result.
const PRICES = { 'fake-model': { input: 1000, output: 1000, 'cache-read': 1000, 'cache-write': 1000 } };

// A chat on `source` whose first turn ends ($0.50) and whose second is caught
// mid-way, its assistant event said and its result held: { chats, chat, costs, estimates }.
async function midTurn(t, source) {
  const root = mkdtempSync(join(tmpdir(), 'chats-'));
  const hold = join(root, 'hold');
  const costs = [], estimates = [];
  const chats = chatRunner({ data: root, command: ['node', FAKE] });
  t.after(() => { rmSync(hold, { force: true }); chats.stopAll(); });
  const chat = { id: 'c', project: 'p', 'session-id': null };
  const options = { cwd: root, env: { ...process.env, FAKE_API_KEY_SOURCE: source, FAKE_HOLD_RESULT: hold }, usage: { prices: PRICES, windows: {} },
    onCost: (usd, billing) => costs.push([usd, billing]), onEstimate: (usd, billing) => estimates.push([usd, billing]) };
  chats.send(chat, 'one', options);
  assert.ok(await until(() => costs.length === 1));
  writeFileSync(hold, '');
  chats.send(chat, 'two', options);
  assert.ok(await until(() => JSON.parse(readFileSync(join(chats.dir('c'), 'usage.json'), 'utf8')).costExact === false));
  return { chats, costs, estimates };
}

test('ASS-271 AC2: a chat stopped mid-turn (deleted) gives onEstimate that turn\'s usage.json estimate, less what its process\'s earlier turns cost, at once and once', async t => {
  const { chats, costs, estimates } = await midTurn(t, 'ANTHROPIC_API_KEY');
  chats.stop('c');
  assert.equal(estimates.length, 1);   // at once: the dashboard may be exiting
  assert.equal(estimates[0][1], 'api');
  assert.ok(Math.abs(estimates[0][0] - 0.1) < 1e-9, String(estimates[0][0]));
  assert.ok(await until(() => !chats.running('c')));
  assert.equal(estimates.length, 1);   // not again when it exits
  assert.deepEqual(costs, [[0.5, 'api']]);
});

test('ASS-271 AC2: a chat stopped mid-turn as the dashboard exits (stopAll) gives its estimate too, 0 on a subscription', async t => {
  const { chats, estimates } = await midTurn(t, 'none');
  chats.stopAll();
  assert.deepEqual(estimates, [[0, 'subscription']]);
});

test('ASS-271 AC2: a chat stopped between turns, or one sent without usage, gives no estimate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chats-'));
  const hold = join(root, 'hold');
  const costs = [], estimates = [];
  const chats = chatRunner({ data: root, command: ['node', FAKE] });
  t.after(() => { rmSync(hold, { force: true }); chats.stopAll(); });
  const options = { cwd: root, usage: { prices: PRICES, windows: {} }, onCost: usd => costs.push(usd), onEstimate: usd => estimates.push(usd) };
  chats.send({ id: 'idle', 'session-id': null }, 'one', options);
  assert.ok(await until(() => costs.length === 1));
  chats.stop('idle');
  writeFileSync(hold, '');
  chats.send({ id: 'blind', 'session-id': null }, 'one', { ...options, usage: undefined, env: { ...process.env, FAKE_HOLD_RESULT: hold } });
  assert.ok(await until(() => readSession(chats.dir('blind'))?.some(l => l.includes('You said'))));
  chats.stop('blind');
  assert.ok(await until(() => !chats.running('idle') && !chats.running('blind')));
  assert.deepEqual(estimates, []);
});
