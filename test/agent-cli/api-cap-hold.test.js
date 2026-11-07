// project:set-api-cap-hold (ASS-217): the API cap that holds a project's
// fallback to its API key — recorded in project.json for the dashboard.
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
  const dir = mkdtempSync(join(tmpdir(), 'ach-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P' }, null, 4));
  return dir;
}
const cli = (dir, ...args) => run(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } });
const read = dir => JSON.parse(readFileSync(join(dir, 'p', 'project.json'), 'utf8'));

test('project:set-api-cap-hold writes api-cap-hold { since, cap, spend-usd, limit-usd }; again keeps since and updates the rest; - removes it', async () => {
  const dir = projects();
  await cli(dir, 'project:set-api-cap-hold', 'p', 'day', '10.5', '10');
  const hold = read(dir)['api-cap-hold'];
  assert.match(hold.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(hold, { since: hold.since, cap: 'day', 'spend-usd': 10.5, 'limit-usd': 10 });
  await cli(dir, 'project:set-api-cap-hold', 'p', 'sprint', '51', '50');
  assert.deepEqual(read(dir)['api-cap-hold'], { since: hold.since, cap: 'sprint', 'spend-usd': 51, 'limit-usd': 50 });
  await cli(dir, 'project:set-api-cap-hold', 'p', '-');
  assert.deepEqual(read(dir), { name: 'P' });
});

test('project:set-api-cap-hold refuses a bad project, cap, amount or usage, writing nothing', async () => {
  const dir = projects();
  for (const args of [['../p', 'day', '1', '1'], ['p', 'week', '1', '1'], ['p', 'day', 'x', '1'], ['p', 'day', '1'], ['p']]) {
    await assert.rejects(cli(dir, 'project:set-api-cap-hold', ...args), /invalid|usage|must be/, args.join(' '));
  }
  assert.deepEqual(read(dir), { name: 'P' });
});
