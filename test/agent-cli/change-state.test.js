// ticket:change-state — moves a ticket variation to another state in the
// active sprint's sprint.json, recording the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExampleEngines } from '../support/engine-walk.js';
// A harness-status at `state` of the example-development engine.
const hs = state => ({ state, 'state-engine': 'example-development' });

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A projects/ folder whose project p has sprint 10 active, with a feature whose work at generate-solution is done.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  const arrived = { 'from-state': 'generate-automated-tests', 'to-state': 'generate-solution', timestamp: '2026-10-07T20:00:00Z', 'agent-dispatch-log': [], 'work-is-done': false };
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10, bugs: [],
    features: [{ key: 'ABC-3', variations: [{ name: 'A', 'harness-status': { ...hs('generate-solution'), 'sub-status': { state: 'deep', 'state-engine': 'test' } }, 'ai-feedback-short': 'Writing', 'ai-feedback-long': 'Writing it.', 'state-changes': [arrived] }, { name: 'B', 'harness-status': hs('backlog') }] }],
  }, null, 4));
  return dir;
}
const sprintFile = dir => join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
const move = (dir, ...args) => run(AGENT, ['ticket:change-state', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const variations = dir => JSON.parse(readFileSync(sprintFile(dir), 'utf8')).features[0].variations;

test('ticket:change-state moves the variation and records the change, its work not yet done; the state left is done, with any sub-status, and the health cleared', async () => {
  const dir = projects();
  await move(dir, 'p', 'abc-3', 'A', 'generate-solution', 'automated-testing');
  const [a, b] = variations(dir);
  assert.deepEqual(a['harness-status'], hs('automated-testing'));
  assert.equal(a['state-changes'].length, 2);
  const change = a['state-changes'][1];
  assert.deepEqual({ ...change, timestamp: 'T' }, { 'state-engine': 'example-development', 'from-state': 'generate-solution', 'to-state': 'automated-testing', timestamp: 'T', 'agent-dispatch-log': [], 'work-is-done': false });
  assert.match(change.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(a['state-changes'][0]['work-is-done'], true);
  assert.deepEqual([a['ai-feedback-short'], a['ai-feedback-long']], [null, null]);
  assert.deepEqual(b['harness-status'], hs('backlog'));
  await move(dir, 'p', 'ABC-3', 'B', 'backlog', 'committed');        // a variation without a history starts one
  assert.equal(variations(dir)[1]['state-changes'].length, 1);
});

test('ticket:change-state fails, writing nothing, unless the variation is in the state it moves from', async () => {
  const dir = projects();
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(move(dir, 'p', 'ABC-3', 'A', 'code-review', 'security-review'), /not at code-review/);
  await assert.rejects(move(dir, 'p', 'ABC-9', 'A', 'generate-solution', 'automated-testing'), /no ABC-9/);
  await assert.rejects(move(dir, 'p', 'ABC-3', 'Z', 'generate-solution', 'automated-testing'), /no ABC-3 variation Z/);
  await assert.rejects(move(dir, 'p', 'ABC-3', 'A', 'generate-solution'), /usage/);
  await assert.rejects(move(dir, '../p', 'ABC-3', 'A', 'generate-solution', 'automated-testing'), /invalid project/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

// p's project.json, naming example-development as its engine, whose local-testing step runs the test engine.
const withEngine = dir => { writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ 'execution-state-engine': 'example-development' })); withExampleEngines(join(dir, 'p')); return dir; };

test('ticket:change-state with a start step enters the target step\'s sub-engine there in the same update, recorded as a sub-state change after the move', async () => {
  const dir = withEngine(projects());
  await move(dir, 'p', 'ABC-3', 'A', 'generate-solution', 'local-testing', 'take-screenshots');
  const [a] = variations(dir);
  assert.deepEqual(a['harness-status'], { ...hs('local-testing'), 'sub-status': { state: 'take-screenshots', 'state-engine': 'test' } });
  assert.deepEqual(a['state-changes'].map(c => [c['from-state'], c['to-state'], c['sub-state-change'] ?? null, c['work-is-done']]), [
    ['generate-automated-tests', 'generate-solution', null, true],
    ['generate-solution', 'local-testing', null, true],
    ['local-testing', 'local-testing', { 'state-engine': 'test', 'from-state': null, 'to-state': 'take-screenshots' }, false],
  ]);
});

test('ticket:change-state with - for the start step moves as it does without one', async () => {
  const dir = withEngine(projects());
  await move(dir, 'p', 'ABC-3', 'A', 'generate-solution', 'local-testing', '-');
  const [a] = variations(dir);
  assert.deepEqual(a['harness-status'], hs('local-testing'));
  assert.equal(a['state-changes'].length, 2);
});

test('ticket:change-state fails, writing nothing, on a start step when the target step runs no sub-engine or its sub-engine has no such step', async () => {
  const dir = withEngine(projects());
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(move(dir, 'p', 'ABC-3', 'A', 'generate-solution', 'automated-testing', 'test'), /automated-testing runs no state engine/);
  await assert.rejects(move(dir, 'p', 'ABC-3', 'A', 'generate-solution', 'local-testing', 'nope'), /test has no step nope/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

// ASS-124: a ticket handed to a sub-engine part way in (ticket:repair-environment) brings what its run is to start from.
test('ticket:change-state with a start step and an output keeps the output on the sub-status, for the run control starts there; refused unless an object', async () => {
  const dir = withEngine(projects());
  await move(dir, 'p', 'ABC-3', 'A', 'generate-solution', 'local-testing', 'take-screenshots', '{"summary":"S"}');
  assert.deepEqual(variations(dir)[0]['harness-status']['sub-status'], { state: 'take-screenshots', 'state-engine': 'test', output: { summary: 'S' } });
  const other = withEngine(projects());
  await assert.rejects(move(other, 'p', 'ABC-3', 'A', 'generate-solution', 'local-testing', 'take-screenshots', '[1]'), /output must be a JSON object/);
  await assert.rejects(move(other, 'p', 'ABC-3', 'A', 'generate-solution', 'local-testing', '-', '{}'), /output needs a start step/);
});
