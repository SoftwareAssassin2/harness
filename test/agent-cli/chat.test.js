// chat:create, chat:set-session, chat:delete (ASS-33): the chat screen's chats in
// data/chats.json, through the locked writer, apart from all else; chat:add-spend
// (ASS-271): what each of their turns cost, in its project's chat-spend.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-'));
  const file = join(dir, 'chats.json');
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
  const spend = join(dir, 'projects', 'p', 'chat-spend.json');
  const cli = (...args) => run(AGENT, args, { env: { ...process.env, CHATS_FILE: file, PROJECTS_DIR: join(dir, 'projects') } });
  return { file, spend, cli, json: async (...args) => JSON.parse((await cli(...args)).stdout), read: () => JSON.parse(readFileSync(file, 'utf8')), turns: () => JSON.parse(readFileSync(spend, 'utf8')).turns };
}

test('chat:create adds a chat — id, project, title, created, no session yet — making chats.json when missing, and prints it', async () => {
  const f = fixture();
  assert.equal(existsSync(f.file), false);
  const chat = await f.json('chat:create', 'example', 'Why is EX-1201 blocked?');
  assert.match(chat.id, /^[0-9a-f-]{36}$/);
  assert.match(chat.created, STAMP);
  assert.deepEqual({ ...chat, id: 'x', created: 'c' }, { id: 'x', project: 'example', title: 'Why is EX-1201 blocked?', created: 'c', 'session-id': null });
  const second = await f.json('chat:create', 'harness', 'Another');
  assert.deepEqual(f.read().chats.map(c => c.id), [chat.id, second.id]);
  assert.match(readFileSync(f.file, 'utf8'), /^\{\n {4}"chats"/);
});

test('chat:set-session records its Claude session id; chat:delete removes it from the list, the rest kept', async () => {
  const f = fixture();
  const a = await f.json('chat:create', 'p', 'A');
  const b = await f.json('chat:create', 'p', 'B');
  await f.cli('chat:set-session', a.id, 'sess-1');
  assert.equal(f.read().chats[0]['session-id'], 'sess-1');
  await f.cli('chat:delete', a.id);
  assert.deepEqual(f.read().chats.map(c => c.id), [b.id]);
});

test('every chat command fails, writing nothing, on a bad project, a blank title, an unknown chat or bad arguments', async () => {
  const f = fixture();
  await f.cli('chat:create', 'p', 'A');
  const before = readFileSync(f.file, 'utf8');
  await assert.rejects(f.cli('chat:create', '../p', 'x'), /invalid project/);
  await assert.rejects(f.cli('chat:create', 'p', '  '), /the title is empty/);
  await assert.rejects(f.cli('chat:create', 'p'), /usage/);
  await assert.rejects(f.cli('chat:set-session', 'nope', 's'), /no chat nope/);
  await assert.rejects(f.cli('chat:delete', 'nope'), /no chat nope/);
  await assert.rejects(f.cli('chat:delete'), /usage/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('ASS-271 AC1: chat:add-spend records a chat-screen turn against its project — its time, chat, billing and cost, 0 on a subscription — in chat-spend.json, made when missing', async () => {
  const f = fixture();
  assert.equal(existsSync(f.spend), false);
  await f.cli('chat:add-spend', 'p', 'c1', '0.5', 'api');
  await f.cli('chat:add-spend', 'p', 'c1', '0.25', 'subscription');
  await f.cli('chat:add-spend', 'p', 'c2', '0.125');   // its session never said what it was billed to
  for (const turn of f.turns()) assert.match(turn.timestamp, STAMP);
  assert.deepEqual(f.turns().map(({ timestamp, ...rest }) => rest), [
    { chat: 'c1', billing: 'api', 'cost-usd': 0.5 }, { chat: 'c1', billing: 'subscription', 'cost-usd': 0 }, { chat: 'c2', 'cost-usd': 0.125 },
  ]);
  assert.match(readFileSync(f.spend, 'utf8'), /^\{\n {4}"turns"/);
});

test('ASS-271 AC2: chat:add-spend --estimate records a turn stopped mid-way at its usage.json estimate, marked as one', async () => {
  const f = fixture();
  await f.cli('chat:add-spend', '--estimate', 'p', 'c1', '0.1', 'api');
  await f.cli('chat:add-spend', '--estimate', 'p', 'c2', '0.3', 'subscription');
  assert.deepEqual(f.turns().map(({ timestamp, ...rest }) => rest), [
    { chat: 'c1', billing: 'api', 'cost-usd': 0.1, estimate: true }, { chat: 'c2', billing: 'subscription', 'cost-usd': 0, estimate: true },
  ]);
});

test('ASS-271: chat:add-spend fails, writing nothing, on a bad or missing project, a bad chat id, a cost not a number from 0, another billing or bad arguments', async () => {
  const f = fixture();
  await f.cli('chat:add-spend', 'p', 'c1', '1', 'api');
  const before = readFileSync(f.spend, 'utf8');
  await assert.rejects(f.cli('chat:add-spend', '../p', 'c1', '1'), /invalid project/);
  await assert.rejects(f.cli('chat:add-spend', 'nope', 'c1', '1'), /no project nope/);
  await assert.rejects(f.cli('chat:add-spend', 'p', 'a/b', '1'), /invalid chat/);
  await assert.rejects(f.cli('chat:add-spend', 'p', 'c1', 'lots'), /not a number/);
  await assert.rejects(f.cli('chat:add-spend', 'p', 'c1', '-1'), /not a number/);
  await assert.rejects(f.cli('chat:add-spend', 'p', 'c1', '1', 'free'), /billing/);
  await assert.rejects(f.cli('chat:add-spend', 'p', 'c1'), /usage/);
  await assert.rejects(f.cli('chat:add-spend', '--estimate', 'p'), /usage/);
  assert.equal(readFileSync(f.spend, 'utf8'), before);
  assert.equal(existsSync(join(f.spend, '..', '..', 'nope')), false);
});
