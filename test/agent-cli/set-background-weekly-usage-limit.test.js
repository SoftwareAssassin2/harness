// project:set-background-weekly-usage-limit (ASS-232 AC1): the weekly Claude
// usage percent at which control holds a project's grooming and background
// work — project.json's background-weekly-usage-limit-percent (absent, 90;
// null, never) — the rest of the file left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const COMMAND = 'project:set-background-weekly-usage-limit';

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'bwul-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P', 'execution-state-engine': 'e', 'max-agents': 20 }, null, 4) + '\n');
  return dir;
}
const set = (dir, ...args) => run(AGENT, [COMMAND, ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const text = dir => readFileSync(join(dir, 'p', 'project.json'), 'utf8');

test(`${COMMAND} writes a percent, or null for none, to project.json's background-weekly-usage-limit-percent, the rest of the file as it was`, async () => {
  const dir = projects();
  const before = text(dir);
  assert.match((await set(dir, 'p', '80')).stdout, /p: background work held at 80% weekly usage/);
  assert.equal(text(dir), before.replace(/\n}\n$/, ',\n    "background-weekly-usage-limit-percent": 80\n}\n'));
  await set(dir, 'p', '97.5');
  assert.equal(JSON.parse(text(dir))['background-weekly-usage-limit-percent'], 97.5);
  assert.match((await set(dir, 'p', 'none')).stdout, /p: background work never held for weekly usage/);
  assert.equal(text(dir), before.replace(/\n}\n$/, ',\n    "background-weekly-usage-limit-percent": null\n}\n'));
});

test(`${COMMAND} refuses, writing nothing, an unknown project, a bad value or usage`, async () => {
  const dir = projects();
  const before = text(dir);
  await assert.rejects(set(dir, 'q', '90'), new RegExp(`${COMMAND}: invalid project 'q'`));
  await assert.rejects(set(dir, '../p', '90'), /invalid project/);
  for (const bad of ['101', '-1', 'x', 'null', '']) await assert.rejects(set(dir, 'p', bad), new RegExp(`${COMMAND}: the limit must be a percent from 0 to 100, or none`), bad);
  await assert.rejects(set(dir, 'p'), new RegExp(`usage: ${COMMAND} <project> <percent\\|none>`));
  assert.equal(text(dir), before);
});
