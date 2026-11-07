// project:set-background-work (ASS-127 AC1): a project's background work —
// its check-health, check-variation-appeal and check-ticket-health runs —
// switched off for a test run, or on again: project.json's background-work
// (absent is on), the rest of the file left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A projects/ folder with project p, its project.json written as the tracked ones are.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'bgw-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P', 'execution-state-engine': 'e', 'work-sources': [{ name: 'T', 'key-prefix': 'ABC' }], 'max-agents': 20 }, null, 4) + '\n');
  return dir;
}
const set = (dir, ...args) => run(AGENT, ['project:set-background-work', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const text = dir => readFileSync(join(dir, 'p', 'project.json'), 'utf8');

test('project:set-background-work off writes "background-work": false to project.json, on writes true, the rest of the file as it was', async () => {
  const dir = projects();
  const before = text(dir);
  assert.match((await set(dir, 'p', 'off')).stdout, /p: background work off/);
  assert.equal(text(dir), before.replace(/\n}\n$/, ',\n    "background-work": false\n}\n'));
  assert.match((await set(dir, 'p', 'on')).stdout, /p: background work on/);
  assert.equal(text(dir), before.replace(/\n}\n$/, ',\n    "background-work": true\n}\n'));
});

test('project:set-background-work refuses, writing nothing, an unknown project or value', async () => {
  const dir = projects();
  const before = text(dir);
  await assert.rejects(set(dir, 'q', 'off'), /project:set-background-work: invalid project 'q'/);
  await assert.rejects(set(dir, '../p', 'off'), /invalid project/);
  await assert.rejects(set(dir, 'p', 'false'), /project:set-background-work: the value must be on or off, got 'false'/);
  await assert.rejects(set(dir, 'p'), /usage: project:set-background-work <project> <on\|off>/);
  assert.equal(text(dir), before);
});
