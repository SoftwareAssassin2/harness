// ticket:sync-outside (ASS-355): the Jira tickets a project's tickets depend
// on that its sprint and backlog do not hold, as the downloader read them by
// key, kept in projects/<project>/outside-tickets.json through the locked
// writer — by key, a failed read keeping the last one, an unwanted one dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-outside-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), '{}');
  const file = join(dir, 'p', 'outside-tickets.json');
  let n = 0;
  const cli = (...args) => run(AGENT, ['ticket:sync-outside', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
  // sync(keys, tickets | text) — the command on a payload of those keys and tickets (or that text as is).
  const sync = (keys, tickets, project = 'p') => {
    const payload = join(dir, `fetch-${n++}.json`);
    writeFileSync(payload, typeof keys === 'string' ? keys : JSON.stringify({ 'fetched-at': '2026-11-10T12:00:00Z', keys, tickets }));
    return cli(project, payload);
  };
  return { file, sync, cli, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}
const outside = (key, status, extra = {}) => ({ key, title: `Title ${key}`, description: 'dropped', url: `https://example.test/browse/${key}`, 'ticket-system-status': status, 'ticket-system-assignment': 'A Teammate', points: 3, ...extra });
const kept = (key, status, extra = {}) => ({ key, title: `Title ${key}`, url: `https://example.test/browse/${key}`, 'ticket-system-status': status, 'ticket-system-assignment': 'A Teammate', ...extra });

test('ASS-355 AC2: ticket:sync-outside makes outside-tickets.json with each fetched ticket\'s key, title, url, status and assignee', async () => {
  const f = fixture();
  assert.equal(existsSync(f.file), false);
  const { stdout } = await f.sync(['EX-2', 'EX-1'], [outside('EX-2', 'In Progress'), outside('EX-1', 'To Do')]);
  assert.match(stdout, /synced 2 outside tickets/);
  assert.deepEqual(f.read(), { 'fetched-at': '2026-11-10T12:00:00Z', tickets: [kept('EX-1', 'To Do'), kept('EX-2', 'In Progress')] });
});

test('ASS-355 AC2: a later sync replaces a fetched ticket, keeps one wanted but not read, drops one no longer wanted; no keys empties it', async () => {
  const f = fixture();
  await f.sync(['EX-1', 'EX-2', 'EX-3'], [outside('EX-1', 'To Do'), outside('EX-2', 'To Do'), outside('EX-3', 'To Do')]);
  await f.sync(['ex-1', 'EX-2'], [outside('EX-1', 'Done'), outside('EX-9', 'Done')]);   // EX-2's read failed; EX-3 no longer depended on; EX-9 not asked for
  assert.deepEqual(f.read().tickets, [kept('EX-1', 'Done'), kept('EX-2', 'To Do')]);
  await f.sync([], []);
  assert.deepEqual(f.read().tickets, []);
});

test('ASS-355: ticket:sync-outside refuses a bad project, a missing file or a payload not of its shape, writing nothing', async () => {
  const f = fixture();
  await assert.rejects(f.cli('../p', join(f.file, '..', 'x.json')), /invalid project/);
  await assert.rejects(f.cli('q', join(f.file, '..', 'x.json')), /no project q/);
  await assert.rejects(f.cli('p', join(f.file, '..', 'x.json')), /no file/);
  await assert.rejects(f.sync('{"tickets": []}'), /is not \{ keys/);
  await assert.rejects(f.sync(JSON.stringify({ keys: ['EX-1'], tickets: [{ title: 'no key' }] })), /is not \{ keys/);
  assert.equal(existsSync(f.file), false);
});
