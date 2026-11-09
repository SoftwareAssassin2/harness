// ticket:human-review — a human's choice at a human gate, written to the
// active sprint's sprint.json for control to act on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// A harness-status at `state` of the example-development engine.
const hs = state => ({ state, 'state-engine': 'example-development' });

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A projects/ folder whose project p has sprint 10 active, with a bug at the payment gate.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'hr-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 9 }, { number: 10, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10, features: [],
    bugs: [{ key: 'ABC-7', variations: [{ name: 'A', 'harness-status': hs('payment-gate') }, { name: 'B', 'harness-status': hs('code-review') }] }],
  }, null, 4));
  return dir;
}
const sprintFile = dir => join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
const decide = (dir, ...args) => run(AGENT, ['ticket:human-review', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const variations = dir => JSON.parse(readFileSync(sprintFile(dir), 'utf8')).bugs[0].variations;

test('ticket:human-review records the decision, the state it was made in and a UTC time stamp on the variation', async () => {
  const dir = projects();
  await decide(dir, 'p', 'ABC-7', 'A', 'payment-gate', 'Approved', '');   // no step to move to: recorded only
  const [a, b] = variations(dir);
  assert.deepEqual(a['harness-status'], hs('payment-gate'));
  assert.equal(a['human-review'].decision, 'Approved');
  assert.equal(a['human-review'].state, 'payment-gate');
  assert.match(a['human-review'].timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(b['human-review'], undefined);
  await decide(dir, 'p', 'abc-7', 'A', 'payment-gate', 'Rejected', '');   // any case; a new choice replaces the last
  assert.equal(variations(dir)[0]['human-review'].decision, 'Rejected');
});

test('ticket:human-review fails, writing nothing, when the ticket has left that state, or is not there', async () => {
  const dir = projects();
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(decide(dir, 'p', 'ABC-7', 'B', 'payment-gate', 'Approved', 'x'), /not at payment-gate/);
  await assert.rejects(decide(dir, 'p', 'ABC-9', 'A', 'payment-gate', 'Approved', 'x'), /no ABC-9/);
  await assert.rejects(decide(dir, 'p', 'ABC-7', 'Z', 'payment-gate', 'Approved', 'x'), /no ABC-7 variation Z/);
  await assert.rejects(decide(dir, 'p', 'ABC-7', 'A', 'payment-gate', ' ', 'x'), /empty/);
  await assert.rejects(decide(dir, 'p', 'ABC-7', 'A', 'payment-gate', 'Approved'), /usage/);
  await assert.rejects(decide(dir, '../p', 'ABC-7', 'A', 'payment-gate', 'Approved', 'x'), /invalid project/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

test('ticket:human-review given a step moves the ticket there: the decision is the work done, the health is cleared', async () => {
  const dir = projects();
  const file = sprintFile(dir);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(data.bugs[0].variations[0], {
    'ai-feedback-short': 'Waiting on you', 'ai-feedback-long': 'Approve the spend.',
    'state-changes': [{ 'from-state': 'token-expense-check', 'to-state': 'payment-gate', timestamp: '2026-10-07T20:00:00Z', 'agent-dispatch-log': [], 'work-is-done': false }],
  });
  writeFileSync(file, JSON.stringify(data, null, 4));
  await decide(dir, 'p', 'ABC-7', 'A', 'payment-gate', 'Approved', 'take-out-of-draft-mode');
  const [a] = variations(dir);
  assert.deepEqual(a['harness-status'], hs('take-out-of-draft-mode'));
  assert.equal(a['human-review'].decision, 'Approved');
  assert.equal(a['state-changes'][0]['work-is-done'], true);
  assert.deepEqual({ ...a['state-changes'][1], timestamp: 'T' }, { 'state-engine': 'example-development', 'from-state': 'payment-gate', 'to-state': 'take-out-of-draft-mode', timestamp: 'T', 'agent-dispatch-log': [], 'work-is-done': false });
  assert.deepEqual([a['ai-feedback-short'], a['ai-feedback-long']], [null, null]);
});

test('ticket:human-review at a human step inside a sub-engine run (ASS-67): <state> its detailed step, the choice recorded for control to move the run, the ticket left where it is', async () => {
  const dir = projects();
  const file = sprintFile(dir);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const status = { ...hs('plan'), 'sub-status': { state: 'write-plan', 'state-engine': 'planning', 'sub-status': { state: 'human-review', 'state-engine': 'review' } } };
  data.bugs[0].variations[0]['harness-status'] = status;
  writeFileSync(file, JSON.stringify(data, null, 4));
  await decide(dir, 'p', 'ABC-7', 'A', 'human-review', 'Rejected', '');
  const [a] = variations(dir);
  assert.deepEqual(a['harness-status'], status);
  assert.deepEqual([a['human-review'].state, a['human-review'].decision], ['human-review', 'Rejected']);
  // Only the deepest step takes a choice there, and only to record it: control moves the run.
  await assert.rejects(decide(dir, 'p', 'ABC-7', 'A', 'write-plan', 'Approved', ''), /not at write-plan/);
  await assert.rejects(decide(dir, 'p', 'ABC-7', 'A', 'human-review', 'Approved', 'x'), /not at human-review/);
});

test('ASS-118: ticket:human-review given a reason keeps it on the variation as its rejection-reason (the next Explain the Change reads it in ticket.json), in a sub-engine run as at the top level; without one, an earlier reason stays', async () => {
  const dir = projects();
  const file = sprintFile(dir);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.bugs[0].variations[0]['harness-status'] = { ...hs('review'), 'sub-status': { state: 'human-review', 'state-engine': 'v2-review' } };
  writeFileSync(file, JSON.stringify(data, null, 4));
  await decide(dir, 'p', 'ABC-7', 'A', 'human-review', 'Rejected', '', 'The summary hides the migration');
  const [a] = variations(dir);
  assert.deepEqual([a['human-review'].decision, a['human-review'].reason, a['rejection-reason']], ['Rejected', 'The summary hides the migration', 'The summary hides the migration']);
  await decide(dir, 'p', 'ABC-7', 'A', 'human-review', 'Approved', '');
  assert.deepEqual([variations(dir)[0]['human-review'].reason, variations(dir)[0]['rejection-reason']], [undefined, 'The summary hides the migration']);
  await decide(dir, 'p', 'ABC-7', 'B', 'code-review', 'Rejected', 'plan', 'Wrong approach');
  assert.deepEqual([variations(dir)[1]['rejection-reason'], variations(dir)[1]['harness-status'].state], ['Wrong approach', 'plan']);
  await assert.rejects(decide(dir, 'p', 'ABC-7', 'A', 'human-review', 'Rejected', '', ' '), /reason is empty/);
});

// ASS-228: a Human Review rejection names the step to return to — return-to,
// kept in the choice for control's move-to-state-from-human-review — and its
// reason is appended, a dated section, to the variation's operator-review-<V>.md
// in the ticket's folder, which every later agent reads; nothing overwrites it.
const inReview = dir => {
  const file = sprintFile(dir);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.bugs[0].variations[0]['harness-status'] = { ...hs('review'), 'sub-status': { state: 'human-review', 'state-engine': 'v2-review' } };
  writeFileSync(file, JSON.stringify(data, null, 4));
  mkdirSync(join(dir, 'p', 'work', 'ABC-7'), { recursive: true });
  return join(dir, 'p', 'work', 'ABC-7', 'operator-review-A.md');
};

test('ASS-228 AC1/AC2: ticket:human-review given a return step keeps it in the choice (return-to) and appends the reason to operator-review-<V>.md as a dated section naming the step — each rejection added, none overwritten', async () => {
  const dir = projects(), notes = inReview(dir);
  await decide(dir, 'p', 'ABC-7', 'A', 'human-review', 'Rejected', '', 'The test plan misses the empty case', 'write-test-plan');
  let [a] = variations(dir);
  assert.deepEqual([a['human-review'].decision, a['human-review'].reason, a['human-review']['return-to'], a['rejection-reason']], ['Rejected', 'The test plan misses the empty case', 'write-test-plan', 'The test plan misses the empty case']);
  const first = readFileSync(notes, 'utf8');
  assert.match(first, /^## \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ — return to write-test-plan\n\nThe test plan misses the empty case\n/);
  await decide(dir, 'p', 'ABC-7', 'A', 'human-review', 'Rejected', '', 'Still slow', 'generate-solution');
  [a] = variations(dir);
  assert.equal(a['human-review']['return-to'], 'generate-solution');
  const both = readFileSync(notes, 'utf8');
  assert.ok(both.startsWith(first), 'the earlier note kept');
  assert.match(both.slice(first.length), /^\n?## \S+ — return to generate-solution\n\nStill slow\n/);
});

test('ASS-228: ticket:human-review refuses a return step other than Write Execution Plan, Write Test Plan or Generate Solution, or one without a reason, writing nothing', async () => {
  const dir = projects(), notes = inReview(dir);
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(decide(dir, 'p', 'ABC-7', 'A', 'human-review', 'Rejected', '', 'x', 'enrich-ac'), /return step/);
  await assert.rejects(decide(dir, 'p', 'ABC-7', 'A', 'human-review', 'Rejected', '', ' ', 'write-test-plan'), /reason is empty/);
  await assert.rejects(decide(dir, 'p', 'ABC-7', 'B', 'human-review', 'Rejected', '', 'x', 'write-test-plan'), /not at human-review/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
  assert.throws(() => readFileSync(notes), /ENOENT/);
});
