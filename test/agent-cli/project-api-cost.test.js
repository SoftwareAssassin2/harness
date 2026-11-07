// project:set-api-cost — a project's own Anthropic API organization's
// month-to-date spend (ASS-221), as control reads it with the project's admin
// key, recorded in projects/<p>/api-cost.json (live data, never the tracked
// project.json) for the dashboard's models box.
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
  const dir = mkdtempSync(join(tmpdir(), 'pac-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P' }, null, 4));
  return dir;
}
const cli = (dir, ...args) => run(AGENT, ['project:set-api-cost', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const cost = dir => (existsSync(join(dir, 'p', 'api-cost.json')) ? JSON.parse(readFileSync(join(dir, 'p', 'api-cost.json'), 'utf8')) : undefined);

test('project:set-api-cost writes { month, usd, as-of } to the project\'s api-cost.json, a plain overwrite; project.json untouched', async () => {
  const dir = projects();
  const before = readFileSync(join(dir, 'p', 'project.json'), 'utf8');
  await cli(dir, 'p', '2026-10', '12.34');
  assert.match(cost(dir)['as-of'], STAMP);
  assert.deepEqual({ ...cost(dir), 'as-of': 'now' }, { month: '2026-10', usd: 12.34, 'as-of': 'now' });
  await cli(dir, 'p', '2026-11', '0');
  assert.deepEqual({ ...cost(dir), 'as-of': 'now' }, { month: '2026-11', usd: 0, 'as-of': 'now' });
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), before);
});

test('project:set-api-cost fails, writing nothing, on a bad project, a month not YYYY-MM or an amount not a number of dollars', async () => {
  const dir = projects();
  for (const args of [['nope', '2026-10', '1'], ['../p', '2026-10', '1'], ['p', '2026-1', '1'], ['p', 'October', '1'], ['p', '2026-10', '-1'], ['p', '2026-10', 'ten'], ['p', '2026-10'], ['p'], []]) {
    await assert.rejects(cli(dir, ...args), undefined, args.join(' '));
    assert.equal(cost(dir), undefined, args.join(' '));
  }
});
