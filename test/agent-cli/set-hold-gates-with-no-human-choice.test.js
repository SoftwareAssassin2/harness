// project:set-hold-gates-with-no-human-choice (ASS-220 AC4): whether a gate on a
// human step that passes by itself, with nothing for a human to choose, holds the
// move for the operator (on) or is approved automatically (off, and absent):
// project.json's hold-gates-with-no-human-choice, the rest of the file left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const COMMAND = 'project:set-hold-gates-with-no-human-choice';

// A projects/ folder with project p, its project.json written as the tracked ones are.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'hold-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P', 'execution-state-engine': 'e', 'max-agents': 20 }, null, 4) + '\n');
  return dir;
}
const set = (dir, ...args) => run(AGENT, [COMMAND, ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const text = dir => readFileSync(join(dir, 'p', 'project.json'), 'utf8');

test(`${COMMAND} on writes "hold-gates-with-no-human-choice": true to project.json, off writes false, the rest of the file as it was`, async () => {
  const dir = projects();
  const before = text(dir);
  assert.match((await set(dir, 'p', 'on')).stdout, /p: hold gates with no human choice on/);
  assert.equal(text(dir), before.replace(/\n}\n$/, ',\n    "hold-gates-with-no-human-choice": true\n}\n'));
  assert.match((await set(dir, 'p', 'off')).stdout, /p: hold gates with no human choice off/);
  assert.equal(text(dir), before.replace(/\n}\n$/, ',\n    "hold-gates-with-no-human-choice": false\n}\n'));
});

test(`${COMMAND} refuses, writing nothing, an unknown project or value`, async () => {
  const dir = projects();
  const before = text(dir);
  await assert.rejects(set(dir, 'q', 'on'), new RegExp(`${COMMAND}: invalid project 'q'`));
  await assert.rejects(set(dir, '../p', 'on'), /invalid project/);
  await assert.rejects(set(dir, 'p', 'true'), new RegExp(`${COMMAND}: the value must be on or off, got 'true'`));
  await assert.rejects(set(dir, 'p'), new RegExp(`usage: ${COMMAND} <project> <on\\|off>`));
  assert.equal(text(dir), before);
});
