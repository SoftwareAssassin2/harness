// project:set-automated-test-run-minutes (ASS-329 AC4): the time limit on
// each test command run by automated-tests:verify-success — project.json's
// automated-test-run-minutes (absent, 30; null, none) — the rest of the file
// left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const COMMAND = 'project:set-automated-test-run-minutes';

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'atrm-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P', 'execution-state-engine': 'e', 'max-agents': 20 }, null, 4) + '\n');
  return dir;
}
const set = (dir, ...args) => run(AGENT, [COMMAND, ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const text = dir => readFileSync(join(dir, 'p', 'project.json'), 'utf8');

test(`${COMMAND} writes the minutes, or null for none, to project.json's automated-test-run-minutes, the rest of the file as it was`, async () => {
  const dir = projects();
  const before = text(dir);
  assert.match((await set(dir, 'p', '15')).stdout, /p: each test command run stopped after 15 minutes/);
  assert.equal(text(dir), before.replace(/\n}\n$/, ',\n    "automated-test-run-minutes": 15\n}\n'));
  await set(dir, 'p', '2.5');
  assert.equal(JSON.parse(text(dir))['automated-test-run-minutes'], 2.5);
  assert.match((await set(dir, 'p', 'none')).stdout, /p: test command runs never time out/);
  assert.equal(text(dir), before.replace(/\n}\n$/, ',\n    "automated-test-run-minutes": null\n}\n'));
});

test(`${COMMAND} refuses, writing nothing, an unknown project, a bad value or usage`, async () => {
  const dir = projects();
  const before = text(dir);
  await assert.rejects(set(dir, 'q', '30'), new RegExp(`${COMMAND}: invalid project 'q'`));
  await assert.rejects(set(dir, '../p', '30'), /invalid project/);
  for (const bad of ['0', '0.0', '-1', 'x', 'null', '']) await assert.rejects(set(dir, 'p', bad), new RegExp(`${COMMAND}: the limit must be a number of minutes above 0, or none`), bad);
  await assert.rejects(set(dir, 'p'), new RegExp(`usage: ${COMMAND} <project> <minutes\\|none>`));
  assert.equal(text(dir), before);
});
