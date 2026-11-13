// analytics:sync-merge-requests (ASS-408): every merged merge request the
// downloader read, kept in projects/<project>/analytics/merge-requests.json
// through the locked writer — by "<group/project>!<iid>", one read again
// replaced, one not read again kept, each repository's fetched-through moved
// only when it was read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const APP = 'https://gitlab.com/group/app', API = 'https://gitlab.com/group/api';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-merge-requests-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), '{}');
  const file = join(dir, 'p', 'analytics', 'merge-requests.json');
  let n = 0;
  const cli = (...args) => run(AGENT, ['analytics:sync-merge-requests', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
  // sync(through, mrs | text) — the command on a payload of those (or that text as is).
  const sync = (through, mrs, project = 'p') => {
    const payload = join(dir, `fetch-${n++}.json`);
    writeFileSync(payload, typeof through === 'string' ? through : JSON.stringify({ 'fetched-through': through, 'merge-requests': mrs }));
    return cli(project, payload);
  };
  return { dir, file, sync, cli, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}
const mr = (repo, iid, extra = {}) => ({ repo, host: 'gitlab', iid, title: `Change ${iid}`, branch: `change/EX-${iid}`, author: { username: 'ada', name: 'Ada Example' }, 'merged-at': `2026-11-0${iid % 9 + 1}T10:00:00Z`, ...extra });

test('ASS-408 AC2: analytics:sync-merge-requests makes analytics/merge-requests.json, keyed <group/project>!<iid>, with each repository\'s fetched-through', async () => {
  const f = fixture();
  assert.equal(existsSync(f.file), false);
  const { stdout } = await f.sync({ [APP]: '2026-11-12T10:00:00.000Z' }, [mr('group/app', 1), { ...mr('group/app', 2), extra: 'dropped' }]);
  assert.match(stdout, /synced 2 merged merge requests \(2 kept\)/);
  assert.deepEqual(f.read(), {
    'fetched-through': { [APP]: '2026-11-12T10:00:00.000Z' },
    'merge-requests': { 'group/app!1': mr('group/app', 1), 'group/app!2': mr('group/app', 2) },
  });
});

test('ASS-408 AC2: a merge request read again replaces its entry, one not read again stays, one without a merged-at is skipped', async () => {
  const f = fixture();
  await f.sync({ [APP]: '2026-11-12T10:00:00.000Z', [API]: '2026-11-12T10:00:00.000Z' }, [mr('group/app', 1), mr('group/app', 2), mr('group/api', 1)]);
  await f.sync({ [APP]: '2026-11-12T10:04:00.000Z' }, [mr('group/app', 2, { title: 'Renamed' }), mr('group/app', 3, { 'merged-at': null }), mr('group/app', 4)]);
  const data = f.read();
  assert.deepEqual(data['fetched-through'], { [APP]: '2026-11-12T10:04:00.000Z', [API]: '2026-11-12T10:00:00.000Z' });   // api not read: stays
  assert.deepEqual(data['merge-requests'], {
    'group/app!1': mr('group/app', 1), 'group/app!2': mr('group/app', 2, { title: 'Renamed' }), 'group/api!1': mr('group/api', 1), 'group/app!4': mr('group/app', 4),
  });
});

test('ASS-408 AC2: a GitHub pull request is kept as <owner/repo>#<number>, beside a GitLab merge request of the same number', async () => {
  const f = fixture();
  const pr = mr('group/site', 1, { host: 'github', author: { username: 'ada', name: 'Ada Example' } });
  await f.sync({ 'https://github.com/group/site': '2026-11-12T10:00:00.000Z' }, [pr, mr('group/app', 1)]);
  assert.deepEqual(f.read()['merge-requests'], { 'group/site#1': pr, 'group/app!1': mr('group/app', 1) });
});

test('ASS-408: analytics:sync-merge-requests refuses a bad project, a missing file or a payload not of its shape, writing nothing', async () => {
  const f = fixture();
  await assert.rejects(f.cli('../p', join(f.dir, 'x.json')), /invalid project/);
  await assert.rejects(f.cli('q', join(f.dir, 'x.json')), /no project q/);
  await assert.rejects(f.cli('p', join(f.dir, 'x.json')), /no file/);
  await assert.rejects(f.sync('{"merge-requests": []}'), /is not \{ fetched-through/);
  await assert.rejects(f.sync(JSON.stringify({ 'fetched-through': {}, 'merge-requests': [{ iid: 1 }] })), /is not \{ fetched-through/);
  await assert.rejects(f.sync(JSON.stringify({ 'fetched-through': {}, 'merge-requests': [mr('group/app', 1, { host: 'bitbucket' })] })), /is not \{ fetched-through/);
  assert.equal(existsSync(f.file), false);
});
