// ticket:keep-current and ticket:take-new (ASS-78) — the operator's answer to
// a sprint ticket's pending-requirements-change, which ticket:sync holds
// (ASS-77): keep the current description, or take the new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineDir } from '../support/engine-walk.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

const PENDING = { description: 'New requirements', 'detected-at': '2026-10-25T12:00:00Z', 'paused-variations': ['A', 'B'] };
// A projects/ folder whose project p (engine e) has sprint 10 active holding
// ABC-1 with a pending requirements change: A and B paused by it, C paused by
// the operator, D deleted. An engines/ folder whose engine e flags plan and
// later for a re-check.
function folders(ticket = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ 'execution-state-engine': 'e' }));
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  const at = (name, state, extra = {}) => ({ name, 'harness-status': { state, 'state-engine': 'e' }, 'is-paused': true, ...extra });
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10,
    features: [{
      key: 'ABC-1', title: 'T', description: 'Current requirements', 'pending-requirements-change': PENDING,
      variations: [at('A', 'setup'), at('B', 'build'), at('C', 'plan'), at('D', 'plan', { 'is-deleted': true, 'is-paused': false })],
      ...ticket,
    }],
  }, null, 4));
  mkdirSync(join(dir, 'engines', 'e'), { recursive: true });
  writeFileSync(join(dir, 'engines', 'e', 'state-engine.json'), JSON.stringify({ steps: [
    { id: 'setup', name: 'Setup', sequence: 1 },
    { id: 'plan', name: 'Plan', sequence: 2, 'recheck-on-requirements-change': true },
    { id: 'build', name: 'Build', sequence: 3, 'recheck-on-requirements-change': true },
    { id: 'requirements-changed', name: 'Requirements Changed', sequence: 0, 'follow-return-to-state': true, action: { type: 'state-engine', engine: 'grouped-requirements-changed' } },
  ] }));
  return dir;
}
const sprintFile = dir => join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
const agent = (dir, ...args) => run(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir, ENGINES_DIR: join(dir, 'engines'), ACLI_DISABLED: '1' } });
const abc1 = dir => JSON.parse(readFileSync(sprintFile(dir), 'utf8')).features[0];
const paused = t => Object.fromEntries(t.variations.map(v => [v.name, v['is-paused']]));

test('ticket:keep-current keeps the description, un-pauses exactly the variations the change paused and clears the change (ASS-78 AC3)', async () => {
  const dir = folders();
  await agent(dir, 'ticket:keep-current', 'p', 'abc-1');
  const t = abc1(dir);
  assert.equal(t.description, 'Current requirements');
  assert.equal(t['pending-requirements-change'], undefined);
  assert.deepEqual(paused(t), { A: false, B: false, C: true, D: false });
});

test('ticket:keep-current and ticket:take-new fail, writing nothing, on a ticket with no pending change, an unknown ticket or bad usage (ASS-78)', async () => {
  const dir = folders({ 'pending-requirements-change': null });
  const before = readFileSync(sprintFile(dir), 'utf8');
  for (const command of ['ticket:keep-current', 'ticket:take-new']) {
    await assert.rejects(agent(dir, command, 'p', 'ABC-1'), /no pending requirements change/);
    await assert.rejects(agent(dir, command, 'p', 'ABC-9'), /no ABC-9/);
    await assert.rejects(agent(dir, command, 'p'), /usage/);
    await assert.rejects(agent(dir, command, '../p', 'ABC-1'), /invalid project/);
  }
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

// ticket:sync of ABC-1 as the ticket system has it, with `description`.
function sync(dir, description) {
  const f = join(dir, 'fetched.json');
  writeFileSync(f, JSON.stringify({ tickets: [{ key: 'ABC-1', title: 'T', description, 'ticket-system-status': 'In Progress', 'issue-type': 'Story' }] }));
  return agent(dir, 'ticket:sync', 'p', 'sprint', f);
}

test('a kept current description is flagged again only when the ticket system\'s description changes again (ASS-78 AC3)', async () => {
  const dir = folders();
  await agent(dir, 'ticket:keep-current', 'p', 'ABC-1');
  await sync(dir, 'New requirements');
  let t = abc1(dir);
  assert.equal(t['pending-requirements-change'], undefined);
  assert.equal(t.description, 'Current requirements');
  assert.deepEqual(paused(t), { A: false, B: false, C: true, D: false });
  assert.equal(existsSync(join(dir, 'p', 'work', 'ABC-1', 'requirements-history.jsonl')), false);
  await sync(dir, 'Newer requirements');
  t = abc1(dir);
  assert.equal(t['pending-requirements-change'].description, 'Newer requirements');
  assert.deepEqual(t['pending-requirements-change']['paused-variations'], ['A', 'B']);
});

test('ticket:take-new applies the new description, clears the change, un-pauses the variations it paused and starts the requirements-changed workflow for each live variation at a step flagged recheck-on-requirements-change (ASS-78 AC4)', async () => {
  const dir = folders({ 'dismissed-requirements-change': 'Older requirements' });
  const { stdout } = await agent(dir, 'ticket:take-new', 'p', 'abc-1');
  const t = abc1(dir);
  assert.equal(t.description, 'New requirements');
  assert.equal(t['pending-requirements-change'], undefined);
  assert.equal(t['dismissed-requirements-change'], undefined);
  assert.deepEqual(paused(t), { A: false, B: false, C: true, D: false });
  // A at Setup (unflagged) just takes the description; D is deleted. B and C start the workflow (ASS-79).
  assert.deepEqual(t.variations.map(v => v['harness-status'].state), ['setup', 'requirements-changed', 'requirements-changed', 'plan']);
  assert.match(stdout, /ABC-1\.B: requirements-changed from build/);
  // The ticket system's description, now the ticket's, holds nothing.
  await sync(dir, 'New requirements');
  assert.equal(abc1(dir)['pending-requirements-change'], undefined);
});

test('the v2 and grouped development engines flag Plan and every later step before Done for a re-check on a requirements change, and no earlier one; the flat engines flag none (ASS-78)', () => {
  const engine = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));
  const flagged = name => engine(name).steps.filter(s => s['recheck-on-requirements-change'] === true).map(s => s.id);
  assert.deepEqual(flagged('harness-development-v2'), ['plan', 'build', 'test', 'document', 'review', 'release']);
  assert.deepEqual(flagged('harness-development-grouped'), ['plan', 'build', 'test', 'document', 'review', 'release']);
  assert.deepEqual(flagged('example-development-grouped'), ['plan', 'build', 'test', 'document', 'review', 'release', 'qa']);
  for (const flat of ['harness-development', 'example-development']) assert.deepEqual(flagged(flat), [], flat);
});

// ASS-79: the seam ticket:take-new calls — the variation leaves the step it
// is in for its engine's Requirements Changed (a transient workflow, as
// Blocked is), which hands it back there (follow-return-to-state) once the
// work still passes every revised criterion.
test('ticket:requirements-changed moves the variation from the step it is in to its engine\'s requirements-changed, the move in its history so the workflow can hand it back (ASS-79 AC3)', async () => {
  const dir = folders();
  const { stdout } = await agent(dir, 'ticket:requirements-changed', 'p', 'ABC-1', 'B');
  assert.match(stdout, /ABC-1\.B: requirements-changed from build/);
  const b = abc1(dir).variations[1];
  assert.deepEqual(b['harness-status'], { state: 'requirements-changed', 'state-engine': 'e' });
  assert.deepEqual(b['state-changes'].map(c => [c['from-state'], c['to-state']]), [['build', 'requirements-changed']]);
});

test('ticket:requirements-changed fails, writing nothing, when the engine has no requirements-changed step, the variation is unknown, or on bad usage (ASS-79)', async () => {
  const dir = folders();
  const file = join(dir, 'engines', 'e', 'state-engine.json');
  const engine = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ steps: engine.steps.filter(s => s.id !== 'requirements-changed') }));
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(agent(dir, 'ticket:requirements-changed', 'p', 'ABC-1', 'B'), /no requirements-changed step/);
  await assert.rejects(agent(dir, 'ticket:requirements-changed', 'p', 'ABC-1', 'Z'), /no ABC-1 variation Z|Z/);
  await assert.rejects(agent(dir, 'ticket:requirements-changed', 'p', 'ABC-1'), /usage/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

// ASS-79 AC2/AC3: the judging step's per-criterion verdicts, kept in the
// workflow run's structured-output (criteria: [{ criteria-number, passes,
// reason }]), decide where the variation goes — deterministically, here, not
// by the judge's say-so: every revised criterion on the variation passing,
// back to the step it was in (exit 0); any failing or left unjudged, the
// failing ones and why written to {ticket-folder}/requirements-change-reason.md
// first, for Root Cause Analysis (exit 3).
function judged(dir, criteria, variation = 'B') {
  const sprint = JSON.parse(readFileSync(sprintFile(dir), 'utf8'));
  sprint.features[0].variations.find(v => v.name === variation)['acceptance-criteria'] = [
    { 'criteria-number': 1, description: 'Shows the total' }, { 'criteria-number': 3, description: 'Exports CSV' }];
  writeFileSync(sprintFile(dir), JSON.stringify(sprint));
  writeFileSync(join(dir, 'assignments.json'), JSON.stringify({ assignments: [], 'transient-state-engines': [
    { id: 'run-1', project: 'p', 'state-engine': 'grouped-requirements-changed', state: 'judge', parent: { 'work-item': 'ABC-1', variation, state: 'requirements-changed' }, 'structured-output': { criteria } }] }));
}
const verdict = (dir, ...args) => run(AGENT, ['ticket:requirements-change-verdict', ...args], { env: { ...process.env, PROJECTS_DIR: dir, ENGINES_DIR: join(dir, 'engines'), ASSIGNMENTS_FILE: join(dir, 'assignments.json'), ACLI_DISABLED: '1' } });
const reasonFile = dir => join(dir, 'p', 'work', 'ABC-1', 'requirements-change-reason.md');

test('ticket:requirements-change-verdict: every revised criterion passing exits 0 and leaves no reason file, removing a stale one (ASS-79 AC3)', async () => {
  const dir = folders();
  judged(dir, [{ 'criteria-number': 1, passes: true, reason: 'total shown' }, { 'criteria-number': 3, passes: true, reason: 'CSV ok' }]);
  mkdirSync(join(dir, 'p', 'work', 'ABC-1'), { recursive: true });
  writeFileSync(reasonFile(dir), 'stale');
  const { stdout } = await verdict(dir, 'p', 'ABC-1', 'B', 'run-1');
  assert.match(stdout, /every revised criterion passes/);
  assert.equal(existsSync(reasonFile(dir)), false);
});

test('ticket:requirements-change-verdict: a failing criterion, or one left unjudged, writes requirements-change-reason.md — each failing criterion, its description and why — and exits 3 (ASS-79 AC3)', async () => {
  const dir = folders();
  judged(dir, [{ 'criteria-number': 1, passes: false, reason: 'shows a subtotal only' }, { 'criteria-number': 3, passes: true, reason: 'CSV ok' }]);
  await assert.rejects(verdict(dir, 'p', 'ABC-1', 'B', 'run-1'), e => e.code === 3);
  const text = readFileSync(reasonFile(dir), 'utf8');
  assert.match(text, /^# Requirements change: the work no longer meets/m);
  assert.match(text, /- AC1: Shows the total — fails: shows a subtotal only/);
  assert.doesNotMatch(text, /AC3/);
  judged(dir, [{ 'criteria-number': 1, passes: true, reason: 'ok' }]);
  await assert.rejects(verdict(dir, 'p', 'ABC-1', 'B', 'run-1'), e => e.code === 3);
  assert.match(readFileSync(reasonFile(dir), 'utf8'), /- AC3: Exports CSV — fails: not judged/);
});

test('ticket:requirements-change-verdict fails (exit 1) on an unknown run, an unknown variation or bad usage (ASS-79)', async () => {
  const dir = folders();
  judged(dir, []);
  await assert.rejects(verdict(dir, 'p', 'ABC-1', 'B', 'run-9'), e => e.code === 1 && /no run run-9/.test(e.stderr));
  await assert.rejects(verdict(dir, 'p', 'ABC-1', 'Z', 'run-1'), e => e.code === 1);
  await assert.rejects(verdict(dir, 'p', 'ABC-1', 'B'), e => e.code === 1 && /usage/.test(e.stderr));
});
