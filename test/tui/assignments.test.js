import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOADED_MS } from '../support/until.js';

const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A fresh assignments.json and a runner that returns it after a command, or the command's stderr when it fails.
function assignmentsFile() {
  const file = join(mkdtempSync(join(tmpdir(), 'tui-')), 'assignments.json');
  const assignments = [{ agent: 'Daredevil', task: 'Initial task', status: 'unassigned' }];
  writeFileSync(file, JSON.stringify({ status: 'Running', assignments }));
  const run = (...args) => {
    execFileSync(AGENT, args, { env: { ...process.env, ASSIGNMENTS_FILE: file }, stdio: 'pipe' });
    return JSON.parse(readFileSync(file, 'utf8'));
  };
  const fails = (...args) => {
    const before = readFileSync(file, 'utf8');
    assert.throws(() => run(...args), args.join(' '));
    assert.equal(readFileSync(file, 'utf8'), before, `${args.join(' ')} writes nothing`);
  };
  return { assignments, run, fails };
}
// Within LOADED_MS: the agent-cli calls between the stamp and the check are slow on a busy machine (ASS-109).
const near = (iso, ms) => assert.ok(Math.abs(Date.parse(iso) - (Date.now() + ms)) < LOADED_MS, iso);

test('assignments:pause all human / assignments:start all human hold and release the human\'s pause on every agent, keeping the assignments', () => {
  const { assignments, run } = assignmentsFile();
  const paused = run('assignments:pause', 'all', 'human');
  assert.equal(paused.status, 'Paused');
  assert.deepEqual(Object.keys(paused.pauses), ['all']);
  near(paused.pauses.all.human.since, 0);
  assert.deepEqual(paused.assignments, assignments);
  assert.deepEqual(run('assignments:start', 'all', 'human'), { status: 'Running', pauses: {}, assignments });
});

test('assignments:pause and assignments:start fail, writing nothing, without a scope and kind, on an unknown one, or an AI pause without its agent, reason or whole minutes', () => {
  const { fails } = assignmentsFile();
  fails('assignments:pause');
  fails('assignments:start');
  fails('assignments:pause', 'human');
  fails('assignments:pause', 'all', 'robot');
  fails('assignments:start', 'all', 'robot');
  fails('assignments:pause', 'all', 'ai');
  fails('assignments:pause', 'all', 'ai', 'Ripley', '', '20');
  fails('assignments:pause', 'all', 'ai', 'Ripley', 'Rotating', 'soon');
  fails('assignments:pause', 'all', 'ai', 'Ripley', 'Rotating', '0');
  fails('assignments:pause', 'all', 'human', 'extra');
});
