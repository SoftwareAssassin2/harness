// ASS-413: an off-board ticket's status history, <KEY>.history.json beside
// its file — appended by ticket:create and ticket:update-status under the
// store lock, backfilled for a ticket without one, printed by ticket:history,
// and never taken for a ticket by anything that lists them. Every command
// runs through off-board.sh against a temp projects folder and a temp store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const OFF_BOARD = join(import.meta.dirname, '..', '..', 'off-board.sh');
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ob-history-'));
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'p', 'project.json'), JSON.stringify({ name: 'P', 'work-sources': [{ name: 'Off', type: 'off-board', folder: 'p-tickets', 'key-prefix': 'HD' }] }));
  const env = { ...process.env, PROJECTS_DIR: join(dir, 'projects'), OFF_BOARD_DIR: join(dir, 'off-board') };
  const folder = join(dir, 'off-board', 'p-tickets');
  return {
    folder,
    offBoard: (...args) => run(OFF_BOARD, args, { env }),
    json: async (...args) => JSON.parse((await run(OFF_BOARD, args, { env })).stdout),
    history: key => JSON.parse(readFileSync(join(folder, `${key}.history.json`), 'utf8')),
    hasHistory: key => existsSync(join(folder, `${key}.history.json`)),
    put: (key, status, created = '2020-01-01T00:00:00Z', updated = '2020-01-05T00:00:00Z') => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${key}.md`), `---\nkey: ${key}\ntype: Story\nstatus: ${status}\ncreated: ${created}\nupdated: ${updated}\n---\n# ${key} title\n\n## Acceptance criteria\n\n1. AC1: one\n`);
    },
  };
}

test('ASS-413 AC1: ticket:create starts the history with its Backlog at the created stamp; each ticket:update-status appends { at (the new updated), from, to }; setting the status it has records nothing', async () => {
  const f = fixture();
  const { key } = await f.json('ticket:create', 'p', 'Story', 'First');
  const created = (await f.json('ticket:get', 'p', key)).created;
  assert.deepEqual(f.history(key), { key: 'HD-1', 'status-changes': [{ at: created, from: null, to: 'Backlog' }] });
  await f.offBoard('ticket:update-status', 'p', 'hd-1', 'Committed');
  const committed = (await f.json('ticket:get', 'p', key)).updated;
  await f.offBoard('ticket:update-status', 'p', 'HD-1', 'Committed');   // no change
  await f.offBoard('ticket:update-status', 'p', 'HD-1', 'In Progress');
  await f.offBoard('ticket:update-status', 'p', 'HD-1', 'Done');
  const done = (await f.json('ticket:get', 'p', key)).updated;
  const changes = f.history(key)['status-changes'];
  assert.deepEqual(changes.map(c => [c.from, c.to]), [[null, 'Backlog'], ['Backlog', 'Committed'], ['Committed', 'In Progress'], ['In Progress', 'Done']]);
  for (const c of changes) assert.match(c.at, STAMP);
  assert.equal(changes[1].at, committed);
  assert.equal(changes[3].at, done);
  assert.ok(changes.every(c => !('backfilled' in c)));
  // The store lock is the one every write holds; no temp file is left beside the ticket.
  assert.deepEqual(readdirSync(f.folder).sort(), ['.lock', 'HD-1.history.json', 'HD-1.md']);
});

test('ASS-413 AC1: a failed ticket:update-status (unknown status, missing ticket) appends nothing', async () => {
  const f = fixture();
  await f.json('ticket:create', 'p', 'Story', 'First');
  const before = f.history('HD-1');
  await assert.rejects(f.offBoard('ticket:update-status', 'p', 'HD-1', 'Blocked'), /one of Backlog/);
  await assert.rejects(f.offBoard('ticket:update-status', 'p', 'HD-9', 'Done'), /no ticket HD-9/);
  assert.deepEqual(f.history('HD-1'), before);
  assert.equal(f.hasHistory('HD-9'), false);
});

test('ASS-413 AC1: history files are not tickets — ticket:list, ticket:get and ticket:create\'s next key ignore them, and ticket:history lists only tickets', async () => {
  const f = fixture();
  await f.json('ticket:create', 'p', 'Story', 'First');
  await f.json('ticket:create', 'p', 'Bug', 'Second');
  // A stray history with a higher number and no ticket does not move the next key.
  writeFileSync(join(f.folder, 'HD-40.history.json'), JSON.stringify({ key: 'HD-40', 'status-changes': [] }));
  assert.deepEqual((await f.json('ticket:list', 'p')).map(t => t.key), ['HD-1', 'HD-2']);
  assert.equal((await f.json('ticket:create', 'p', 'Spike', 'Third')).key, 'HD-3');
  await assert.rejects(f.offBoard('ticket:get', 'p', 'HD-40'), /no ticket HD-40/);
  assert.deepEqual((await f.json('ticket:history', 'p')).map(h => h.key), ['HD-1', 'HD-2', 'HD-3']);
});

test('ASS-413 AC2: a ticket with no history file is backfilled on first read — Backlog at created, then its status at updated when that differs — marked backfilled, written once and kept', async () => {
  const f = fixture();
  f.put('HD-1', 'In Progress');
  f.put('HD-2', 'Backlog');
  assert.deepEqual(await f.json('ticket:history', 'p', 'hd-1'), { key: 'HD-1', 'status-changes': [
    { at: '2020-01-01T00:00:00Z', from: null, to: 'Backlog', backfilled: true },
    { at: '2020-01-05T00:00:00Z', from: 'Backlog', to: 'In Progress', backfilled: true }] });
  assert.ok(f.hasHistory('HD-1'));
  assert.equal(f.hasHistory('HD-2'), false);   // only the one read
  const all = await f.json('ticket:history', 'p');
  assert.deepEqual(all[1], { key: 'HD-2', 'status-changes': [{ at: '2020-01-01T00:00:00Z', from: null, to: 'Backlog', backfilled: true }] });
  assert.ok(f.hasHistory('HD-2'));
  // Kept: a read after the ticket changed by hand does not backfill again.
  f.put('HD-2', 'Done', '2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z');
  assert.deepEqual((await f.json('ticket:history', 'p', 'HD-2'))['status-changes'].length, 1);
});

test('ASS-413 AC2: ticket:update-status on a ticket with no history backfills it from the state before the change, then appends the change', async () => {
  const f = fixture();
  f.put('HD-1', 'Committed');
  await f.offBoard('ticket:update-status', 'p', 'HD-1', 'Done');
  const changes = f.history('HD-1')['status-changes'];
  assert.deepEqual(changes.slice(0, 2), [
    { at: '2020-01-01T00:00:00Z', from: null, to: 'Backlog', backfilled: true },
    { at: '2020-01-05T00:00:00Z', from: 'Backlog', to: 'Committed', backfilled: true }]);
  assert.deepEqual({ ...changes[2], at: 'x' }, { at: 'x', from: 'Committed', to: 'Done' });
  assert.equal(changes[2].at, (await f.json('ticket:get', 'p', 'HD-1')).updated);
});

test('ASS-413 AC1: ticket:mark-split\'s Done is a status change, appended once; marking it again records nothing', async () => {
  const f = fixture();
  for (const title of ['Whole', 'Piece one', 'Piece two']) await f.json('ticket:create', 'p', 'Story', title);
  await f.offBoard('ticket:update-status', 'p', 'HD-1', 'Committed');
  await f.offBoard('ticket:mark-split', 'p', 'HD-1', 'HD-2', 'HD-3');
  await f.offBoard('ticket:mark-split', 'p', 'HD-1', 'HD-2', 'HD-3');
  const changes = f.history('HD-1')['status-changes'];
  assert.deepEqual(changes.map(c => [c.from, c.to]), [[null, 'Backlog'], ['Backlog', 'Committed'], ['Committed', 'Done']]);
  assert.equal(changes[2].at, (await f.json('ticket:get', 'p', 'HD-1')).updated);
});

test('ASS-413: ticket:history skips a malformed ticket with a warning, prints [] for an empty store, and fails on a missing ticket or project', async () => {
  const f = fixture();
  assert.deepEqual(await f.json('ticket:history', 'p'), []);
  f.put('HD-1', 'Backlog');
  writeFileSync(join(f.folder, 'HD-2.md'), 'no front matter\n');
  const { stdout, stderr } = await f.offBoard('ticket:history', 'p');
  assert.deepEqual(JSON.parse(stdout).map(h => h.key), ['HD-1']);
  assert.match(stderr, /skipping .*HD-2\.md/);
  assert.equal(f.hasHistory('HD-2'), false);
  await assert.rejects(f.offBoard('ticket:history', 'p', 'HD-9'), /no ticket HD-9 in p/);
  await assert.rejects(f.offBoard('ticket:history', 'nope'), /no project 'nope'/);
  await assert.rejects(f.offBoard('ticket:history'), /^usage: ticket:history/m);
});
