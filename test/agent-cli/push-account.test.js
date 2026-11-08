// project:set-push-account (ASS-307) — the account a project's VM token pushes
// as, or why it cannot be told, as control last checked it, recorded in
// projects/<p>/push-account.json (live data, never the tracked project.json)
// for the control box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAMP } from './harness-fixture.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P' }, null, 4));
  return dir;
}
const cli = (dir, ...args) => run(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } });
const accountFile = dir => join(dir, 'p', 'push-account.json');
const recorded = dir => (existsSync(accountFile(dir)) ? JSON.parse(readFileSync(accountFile(dir), 'utf8')) : undefined);

test('ASS-307 AC2: project:set-push-account writes { project, provider, account, error, checked-at } to push-account.json; project.json untouched', async () => {
  const dir = projects();
  const before = readFileSync(join(dir, 'p', 'project.json'), 'utf8');
  await cli(dir, 'project:set-push-account', 'p', 'GitHub', 'SoftwareAssassin2', '-');
  const first = recorded(dir);
  assert.match(first['checked-at'], STAMP);
  assert.deepEqual({ ...first, 'checked-at': 'now' }, { project: 'p', provider: 'GitHub', account: 'SoftwareAssassin2', error: null, 'checked-at': 'now' });
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), before);
});

test('ASS-307 AC2: project:set-push-account: - is null for the account or the error; a second call plainly overwrites the first', async () => {
  const dir = projects();
  await cli(dir, 'project:set-push-account', 'p', 'GitHub', 'ada', '-');
  await cli(dir, 'project:set-push-account', 'p', 'GitLab', '-', 'token rejected (401)');
  assert.deepEqual({ ...recorded(dir), 'checked-at': 'now' }, { project: 'p', provider: 'GitLab', account: null, error: 'token rejected (401)', 'checked-at': 'now' });
  await cli(dir, 'project:set-push-account', 'p', 'GitLab', 'lab', '-');
  assert.deepEqual({ ...recorded(dir), 'checked-at': 'now' }, { project: 'p', provider: 'GitLab', account: 'lab', error: null, 'checked-at': 'now' });
});

test('ASS-307 AC2: project:set-push-account fails, writing nothing, on an unknown provider, both or neither of account and error, an invalid project or one without project.json', async () => {
  const dir = projects();
  const bad = [
    ['p', 'Bitbucket', 'ada', '-'],
    ['p', 'github', 'ada', '-'],
    ['p', 'GitHub', 'ada', 'token rejected (401)'],
    ['p', 'GitHub', '-', '-'],
    ['../x', 'GitHub', 'ada', '-'],
    ['p/..', 'GitHub', 'ada', '-'],
    ['nope', 'GitHub', 'ada', '-'],
    ['p', 'GitHub', 'ada'],
    ['p', 'GitHub'],
  ];
  for (const args of bad) {
    await assert.rejects(cli(dir, 'project:set-push-account', ...args), undefined, args.join(' '));
    assert.equal(recorded(dir), undefined, args.join(' '));
    assert.ok(!existsSync(join(dir, 'nope', 'push-account.json')), args.join(' '));
  }
});
