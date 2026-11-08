// project:set-last-data-download — records when the downloader last pulled a
// project's data, in the project folder's last-data-download file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A projects/ folder whose project p has never been downloaded.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'ldd-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P' }, null, 4));
  return dir;
}
const set = (dir, ...args) => run(AGENT, ['project:set-last-data-download', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const read = dir => readFileSync(join(dir, 'p', 'last-data-download'), 'utf8');

test('project:set-last-data-download writes the time, alone, to the project folder\'s last-data-download, leaving project.json be', async () => {
  const dir = projects();
  const config = readFileSync(join(dir, 'p', 'project.json'), 'utf8');
  await set(dir, 'p', '2026-10-11T03:04:05Z');
  assert.equal(read(dir), '2026-10-11T03:04:05Z');
  await set(dir, 'p', '2026-10-11T04:00:00.123Z');
  assert.equal(read(dir), '2026-10-11T04:00:00.123Z');
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), config);
});

test('project:set-last-data-download fails, writing nothing, on a bad time, project or usage', async () => {
  const dir = projects();
  const before = readFileSync(join(dir, 'p', 'project.json'), 'utf8');
  await assert.rejects(set(dir, 'p', 'yesterday'), /ISO/);
  await assert.rejects(set(dir, 'p'), /usage/);
  await assert.rejects(set(dir, '../p', '2026-10-11T03:04:05Z'), /invalid project/);
  await assert.rejects(set(dir, 'q', '2026-10-11T03:04:05Z'), /no project q/);
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), before);
  assert.equal(existsSync(join(dir, 'p', 'last-data-download')), false);
  assert.equal(existsSync(join(dir, 'q')), false);
});
