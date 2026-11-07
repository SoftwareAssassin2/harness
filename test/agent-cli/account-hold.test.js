// project:set-account-hold / project:clear-account-hold (ASS-26): why control
// starts none of a project's agents — its expected-account is not the account
// its Claude config is logged in to — recorded in project.json for the dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'ah-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P' }, null, 4));
  return dir;
}
const cli = (dir, ...args) => run(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } });
const read = dir => JSON.parse(readFileSync(join(dir, 'p', 'project.json'), 'utf8'));

test('project:set-account-hold writes account-hold { since, expected, actual, config-dir } (null for -); setting it again keeps since; clear removes it', async () => {
  const dir = projects();
  await cli(dir, 'project:set-account-hold', 'p', 'work@example.com', 'me@example.com', '/x/projects/p/.claude');
  const first = read(dir)['account-hold'];
  assert.match(first.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual({ ...first, since: 'now' }, { since: 'now', expected: 'work@example.com', actual: 'me@example.com', 'config-dir': '/x/projects/p/.claude' });
  await cli(dir, 'project:set-account-hold', 'p', 'work@example.com', '-', '-');
  assert.deepEqual(read(dir)['account-hold'], { since: first.since, expected: 'work@example.com', actual: null, 'config-dir': null });
  await cli(dir, 'project:clear-account-hold', 'p');
  assert.deepEqual(read(dir), { name: 'P' });
  await cli(dir, 'project:clear-account-hold', 'p');
  assert.deepEqual(read(dir), { name: 'P' });
  const before = readFileSync(join(dir, 'p', 'project.json'), 'utf8');
  await assert.rejects(cli(dir, 'project:set-account-hold', '../p', 'a', 'b', 'c'), /invalid project/);
  await assert.rejects(cli(dir, 'project:set-account-hold', 'p', 'a'), /usage/);
  await assert.rejects(cli(dir, 'project:clear-account-hold'), /usage/);
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), before);
});
