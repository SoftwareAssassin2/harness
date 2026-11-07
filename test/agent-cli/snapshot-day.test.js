// ticket:snapshot-day — keeps a day's last sprint.json as sprints/days/<date>.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A projects/ folder whose project p has sprint 10 active and no day snapshots yet.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 9, 'is-active': false }, { number: 10, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), '{ "number": 10, "features": [{ "key": "ABC-1" }] }\n');
  return dir;
}
const snapshot = (dir, ...args) => run(AGENT, ['ticket:snapshot-day', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const day = (dir, date) => join(dir, 'p', 'sprints', 'days', `${date}.json`);

test('ticket:snapshot-day copies the active sprint file to sprints/days/<date>.json, making the folder', async () => {
  const dir = projects();
  const { stdout } = await snapshot(dir, 'p', '2026-10-10');
  assert.equal(readFileSync(day(dir, '2026-10-10'), 'utf8'), '{ "number": 10, "features": [{ "key": "ABC-1" }] }\n');
  assert.match(stdout, /2026-10-10\.json/);
});

test('ticket:snapshot-day never overwrites a day already kept (exit 2)', async () => {
  const dir = projects();
  mkdirSync(join(dir, 'p', 'sprints', 'days'));
  writeFileSync(day(dir, '2026-10-10'), 'kept');
  await assert.rejects(snapshot(dir, 'p', '2026-10-10'), err => err.code === 2 && /already exists/.test(err.stderr));
  assert.equal(readFileSync(day(dir, '2026-10-10'), 'utf8'), 'kept');
});

test('ticket:snapshot-day fails, writing nothing, on a bad date, project or usage', async () => {
  const dir = projects();
  await assert.rejects(snapshot(dir, 'p', '10/10/2026'), /YYYY-MM-DD/);
  await assert.rejects(snapshot(dir, 'p', '../../2026-10-10'), /YYYY-MM-DD/);
  await assert.rejects(snapshot(dir, 'p'), /usage/);
  await assert.rejects(snapshot(dir, '../p', '2026-10-10'), /invalid project/);
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [] }));
  await assert.rejects(snapshot(dir, 'p', '2026-10-10'), /no active sprint/);
  assert.ok(!existsSync(join(dir, 'p', 'sprints', 'days')));
});
