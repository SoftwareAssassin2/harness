// analytics:sync-tickets and analytics:sync-sprints (ASS-406): the ticket
// history and the board's sprints the downloader read through Jira's REST
// API, kept in projects/<project>/analytics/ through the locked writer — a
// ticket read again replaces its entry, one not read stays, so the history
// only grows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'analytics-sync-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), '{}');
  let n = 0;
  const cli = (command, ...args) => run(AGENT, [`analytics:${command}`, ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
  // sync(command, payload | text) — the command on that payload (or that text as is).
  const sync = (command, payload, project = 'p') => {
    const file = join(dir, `fetch-${n++}.json`);
    writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
    return cli(command, project, file);
  };
  const read = name => JSON.parse(readFileSync(join(dir, 'p', 'analytics', name), 'utf8'));
  return { dir, sync, cli, read, exists: name => existsSync(join(dir, 'p', 'analytics', name)) };
}
const person = name => ({ id: `acc-${name}`, name });
const ticket = (key, status, extra = {}) => ({
  key, title: `Title ${key}`, type: 'Story', created: '2026-10-01T09:00:00.000Z', points: 3, assignee: person('ada'), status, sprints: [41],
  'status-changes': [{ at: '2026-10-02T10:00:00.000Z', from: 'To Do', to: status, by: person('ada') }], 'assignee-changes': [], ...extra,
});

test('ASS-406 AC2: analytics:sync-tickets makes analytics/tickets.json, by key, with fetched-through', async () => {
  const f = fixture();
  const { stdout } = await f.sync('sync-tickets', { 'fetched-through': '2026-11-12T12:00:00.000Z', tickets: [ticket('PROJ-1', 'In Progress'), ticket('PROJ-2', 'To Do')] });
  assert.match(stdout, /synced 2 analytics tickets, 2 kept/);
  assert.deepEqual(f.read('tickets.json'), { 'fetched-through': '2026-11-12T12:00:00.000Z', tickets: { 'PROJ-1': ticket('PROJ-1', 'In Progress'), 'PROJ-2': ticket('PROJ-2', 'To Do') } });
  assert.deepEqual(readdirSync(join(f.dir, 'p')).sort(), ['analytics', 'project.json']);   // nothing else written
});

test('ASS-406 AC2: a ticket read again replaces its entry, one not read stays, and the changes are put in time order', async () => {
  const f = fixture();
  await f.sync('sync-tickets', { 'fetched-through': '2026-11-12T12:00:00.000Z', tickets: [ticket('PROJ-1', 'In Progress'), ticket('PROJ-2', 'To Do')] });
  const later = ticket('PROJ-1', 'Done', {
    'status-changes': [
      { at: '2026-10-05T10:00:00.000Z', from: 'In Progress', to: 'Done', by: person('bob') },
      { at: '2026-10-02T10:00:00.000Z', from: 'To Do', to: 'In Progress', by: person('ada') },
    ],
    'assignee-changes': [
      { at: '2026-10-04T10:00:00.000Z', from: person('ada'), to: person('bob') },
      { at: '2026-10-01T10:00:00.000Z', from: null, to: person('ada') },
    ],
  });
  const { stdout } = await f.sync('sync-tickets', { 'fetched-through': '2026-11-12T12:04:00.000Z', tickets: [later] });
  assert.match(stdout, /synced 1 analytics tickets, 2 kept/);
  const file = f.read('tickets.json');
  assert.equal(file['fetched-through'], '2026-11-12T12:04:00.000Z');
  assert.deepEqual(file.tickets['PROJ-2'], ticket('PROJ-2', 'To Do'));
  assert.equal(file.tickets['PROJ-1'].status, 'Done');
  assert.deepEqual(file.tickets['PROJ-1']['status-changes'].map(c => c.to), ['In Progress', 'Done']);
  assert.deepEqual(file.tickets['PROJ-1']['assignee-changes'].map(c => c.to.name), ['ada', 'bob']);
});

test('ASS-406 AC3: analytics:sync-sprints keeps analytics/sprints.json by id, in start order with the undated last', async () => {
  const f = fixture();
  const s = (id, state, start, end) => ({ id, name: `S${id}`, state, start, end });
  await f.sync('sync-sprints', { sprints: [s(3, 'future', null, null), s(2, 'active', '2026-10-15T09:00:00.000Z', null), s(1, 'closed', '2026-10-01T09:00:00.000Z', '2026-10-15T09:00:00.000Z')] });
  assert.deepEqual(f.read('sprints.json').sprints.map(x => x.id), [1, 2, 3]);
  // Sprint 3 started, 1 no longer on the board (kept), 2 closed.
  const { stdout } = await f.sync('sync-sprints', { sprints: [s(3, 'active', '2026-10-29T09:00:00.000Z', '2026-11-12T09:00:00.000Z'), s(2, 'closed', '2026-10-15T09:00:00.000Z', '2026-10-29T09:00:00.000Z'), { id: 4, extra: 'dropped' }] });
  assert.match(stdout, /synced 4 analytics sprints/);
  assert.deepEqual(f.read('sprints.json'), { sprints: [
    s(1, 'closed', '2026-10-01T09:00:00.000Z', '2026-10-15T09:00:00.000Z'),
    s(2, 'closed', '2026-10-15T09:00:00.000Z', '2026-10-29T09:00:00.000Z'),
    s(3, 'active', '2026-10-29T09:00:00.000Z', '2026-11-12T09:00:00.000Z'),
    { id: 4, name: '', state: null, start: null, end: null },
  ] });
});

test('ASS-406: both refuse a bad project, a missing file or a payload not of their shape, writing nothing', async () => {
  const f = fixture();
  for (const command of ['sync-tickets', 'sync-sprints']) {
    await assert.rejects(f.cli(command, '../p', join(f.dir, 'x.json')), /invalid project/);
    await assert.rejects(f.cli(command, 'q', join(f.dir, 'x.json')), /no project q/);
    await assert.rejects(f.cli(command, 'p', join(f.dir, 'x.json')), /no file/);
  }
  await assert.rejects(f.sync('sync-tickets', { tickets: [] }), /is not \{ fetched-through/);
  await assert.rejects(f.sync('sync-tickets', { 'fetched-through': '2026-11-12T12:00:00Z', tickets: [{ title: 'no key' }] }), /is not \{ fetched-through/);
  await assert.rejects(f.sync('sync-tickets', 'not json'), /is not \{ fetched-through/);
  await assert.rejects(f.sync('sync-sprints', { sprints: [{ name: 'no id' }] }), /is not \{ sprints/);
  assert.equal(f.exists('tickets.json') || f.exists('sprints.json'), false);
});
