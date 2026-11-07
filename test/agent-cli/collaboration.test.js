// collaboration:set-session, collaboration:set-briefed, collaboration:add-spend
// (ASS-35), collaboration:set-raised (ASS-36): a ticket's chat on its screen, kept in
// projects/<project>/work/<KEY>/collaboration.json through the locked writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'collaboration-'));
  mkdirSync(join(dir, 'p'));
  const file = join(dir, 'p', 'work', 'ABC-1', 'collaboration.json');
  const cli = (...args) => run(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } });
  return { file, cli, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}

test('collaboration:set-session makes work/<KEY>/collaboration.json when missing — no session, nothing briefed, no chat turns — and records the session id', async () => {
  const f = fixture();
  assert.equal(existsSync(f.file), false);
  await f.cli('collaboration:set-session', 'p', 'ABC-1', 'sess-1');
  assert.deepEqual(f.read(), { 'session-id': 'sess-1', briefed: null, turns: [] });
  assert.match(readFileSync(f.file, 'utf8'), /^\{\n {4}"session-id"/);
  await f.cli('collaboration:set-session', 'p', 'ABC-1', 'sess-2');
  assert.equal(f.read()['session-id'], 'sess-2');
});

test('collaboration:set-briefed keeps the snapshot of what the agent was told; collaboration:add-spend records each turn with its time, billing and cost — 0 on a subscription (ASS-216 AC2)', async () => {
  const f = fixture();
  await f.cli('collaboration:set-briefed', 'p', 'ABC-1', '{"requirements":{"title":"T"}}');
  assert.deepEqual(f.read(), { 'session-id': null, briefed: { requirements: { title: 'T' } }, turns: [] });
  await f.cli('collaboration:add-spend', 'p', 'ABC-1', '0.5', 'api');
  await f.cli('collaboration:add-spend', 'p', 'ABC-1', '0.25', 'subscription');
  await f.cli('collaboration:add-spend', 'p', 'ABC-1', '0.125');   // its session never said what it was billed to
  const turns = f.read().turns;
  for (const turn of turns) assert.match(turn.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(turns.map(({ timestamp, ...rest }) => rest), [{ billing: 'api', 'cost-usd': 0.5 }, { billing: 'subscription', 'cost-usd': 0 }, { 'cost-usd': 0.125 }]);
  assert.deepEqual(f.read().briefed, { requirements: { title: 'T' } });
});

test('collaboration:set-raised keeps the problems last raised in the chat; an empty list clears them (ASS-36)', async () => {
  const f = fixture();
  await f.cli('collaboration:set-raised', 'p', 'ABC-1', '["A: blocked","A: paused"]');
  assert.deepEqual(f.read(), { 'session-id': null, briefed: null, turns: [], raised: ['A: blocked', 'A: paused'] });
  await f.cli('collaboration:set-raised', 'p', 'ABC-1', '[]');
  assert.deepEqual(f.read().raised, []);
});

test('every collaboration command fails, writing nothing, on a bad project or ticket, a snapshot not an object, reasons not strings, a cost not a number, or bad arguments', async () => {
  const f = fixture();
  await f.cli('collaboration:set-session', 'p', 'ABC-1', 's');
  const before = readFileSync(f.file, 'utf8');
  await assert.rejects(f.cli('collaboration:set-session', '../p', 'ABC-1', 's'), /invalid project/);
  await assert.rejects(f.cli('collaboration:set-session', 'p', 'a/b', 's'), /invalid ticket/);
  await assert.rejects(f.cli('collaboration:set-session', 'nope', 'ABC-1', 's'), /no project nope/);
  await assert.rejects(f.cli('collaboration:set-session', 'p', 'ABC-1'), /usage/);
  await assert.rejects(f.cli('collaboration:set-briefed', 'p', 'ABC-1', '[1]'), /not a JSON object/);
  await assert.rejects(f.cli('collaboration:set-briefed', 'p', 'ABC-1', '{'), /not a JSON object/);
  await assert.rejects(f.cli('collaboration:set-raised', 'p', 'ABC-1', '{}'), /not a JSON array of strings/);
  await assert.rejects(f.cli('collaboration:set-raised', 'p', 'ABC-1', '[1]'), /not a JSON array of strings/);
  await assert.rejects(f.cli('collaboration:add-spend', 'p', 'ABC-1', 'lots'), /not a number/);
  await assert.rejects(f.cli('collaboration:add-spend', 'p', 'ABC-1', '-1'), /not a number/);
  await assert.rejects(f.cli('collaboration:add-spend', 'p', 'ABC-1', '1', 'free'), /billing/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal(existsSync(join(f.file, '..', '..', '..', '..', 'nope')), false);
});
