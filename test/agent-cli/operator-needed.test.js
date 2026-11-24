// ASS-506: ticket:operator-needed — the dashboard's Operator Needed set as
// JSON for an operator's Claude session: the same tickets as the dashboard's
// own operatorNeeded / neededTickets on one fixture, a blocking question's
// where and index for question:answer, the gate's choices as humanGate gives
// them with their ready-to-run argv, read-only, and its usage and failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { AGENT } from './harness-fixture.js';
import { operatorNeededState, operatorNeededOf } from '../../src/notify/operator-needed.js';
import { neededTickets } from '../../src/notify/detect.js';
import { operatorNeeded, sprintTickets } from '../../src/tui/screens/shared.js';
import { humanGate, choiceCommand } from '../../src/tui/ticket.js';
import { enginesOf } from '../../src/tui/status.js';

const write = (file, json) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`); };
const steps = [
  { id: 'stuck', name: 'Blocked for Human', sequence: 0, area: 'quarantine', 'is-blocked-state': true, action: { type: 'human', instructions: 'Resolve the block.' },
    'exit-events': [{ condition: { 'human-review': 'Resolved' }, 'move-to-state': 'build' }] },
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'human-review', name: 'Human Review', sequence: 8, action: { type: 'human', instructions: 'Review the variation and approve or reject it.' },
    'exit-events': [{ condition: { 'human-review': 'Approved' }, 'move-to-state': 'done' }, { condition: { 'human-review': 'Rejected' }, 'move-to-state': 'build' }] },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const ticket = (key, state, extra = {}) => ({ key, title: `Title of ${key}`, variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, ...extra }] });

// Projects p (one ticket of each kind) and q (nothing waits), engine e, no assignments file.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'operator-needed-'));
  const projects = join(root, 'projects'), engines = join(root, 'engines');
  write(join(engines, 'e', 'workflow.yaml'), { steps });
  for (const [id, features] of [
    ['p', [ticket('A-1', 'human-review'), ticket('A-2', 'stuck', { 'ai-feedback-short': 'Tests fail', 'ai-feedback-long': 'The tests fail on the VM.' }),
      ticket('A-3', 'build'), ticket('A-4', 'build'), { ...ticket('A-5', 'build'), 'pending-requirements-change': { description: 'New text' } }]],
    ['q', [ticket('B-1', 'build')]],
  ]) {
    write(join(projects, id, 'project.json'), { name: `Project ${id}`, 'execution-state-engine': 'e' });
    write(join(projects, id, 'sprints.json'), { list: [{ number: 1, 'is-active': true }] });
    write(join(projects, id, 'sprints', 'sprint-1', 'sprint.json'), { number: 1, features, bugs: [], spikes: [] });
  }
  // A-3's second question is the open blocking one: index 1 in its file; the first is answered.
  write(join(projects, 'p', 'work', 'A-3', 'questions-and-answers.json'), { list: [
    { 'asked-on-ticket': 'A-3', status: 'Answered', blocking: true, question: 'Old?' },
    { 'asked-on-ticket': 'A-3', status: 'Asked', blocking: true, question: 'Which port?' },
  ] });
  return { root, projects, engines, paths: { projectsDir: projects, assignmentsFile: null, enginesDir: engines } };
}
const cli = (f, ...args) => spawnSync(AGENT, ['ticket:operator-needed', ...args], {
  encoding: 'utf8', env: { ...process.env, PROJECTS_DIR: f.projects, ENGINES_DIR: f.engines, ASSIGNMENTS_FILE: join(f.root, 'assignments.json') },
});
// Every file under `dir`, with its size and modification time.
const snapshot = dir => readdirSync(dir, { recursive: true }).toSorted().map(name => {
  const s = statSync(join(dir, name));
  return `${relative(dir, join(dir, name))} ${s.size} ${s.mtimeMs}`;
});

test('ASS-506 AC1, AC2: the CLI prints the same set as the dashboard\'s operatorNeeded and neededTickets, each with its reason, for every project', () => {
  const f = fixture();
  const out = cli(f);
  assert.equal(out.status, 0, out.stderr);
  const printed = JSON.parse(out.stdout);
  const state = operatorNeededState(f.paths);
  const dashboard = neededTickets(state);
  assert.deepEqual(Object.keys(printed), ['p', 'q']);
  for (const [i, project] of state.projects.entries()) {
    const tile = operatorNeeded({ ...state, project: i, day: null });
    assert.deepEqual(printed[project.id].map(t => t.key), [...tile], `${project.id}: the tile's set`);
    assert.deepEqual(printed[project.id].map(t => t.key), dashboard[project.id].map(t => t.key), `${project.id}: neededTickets' set`);
  }
  assert.deepEqual(printed.p.map(t => t.key).toSorted(), ['A-1', 'A-2', 'A-3', 'A-5']);
  assert.deepEqual(printed.q, []);
  const byKey = Object.fromEntries(printed.p.map(t => [t.key, t]));
  // Everything but the questions (and the added choices) is neededTickets' own.
  for (const t of dashboard.p) {
    const { choices, ...rest } = byKey[t.key];
    assert.ok(Array.isArray(choices));
    assert.deepEqual({ ...rest, reason: { ...rest.reason, questions: rest.reason.questions?.map(q => q.question) } },
      { ...t, reason: { ...t.reason, questions: t.reason.questions } }, t.key);
  }
  assert.deepEqual(byKey['A-2'].reason, { blocked: true, gate: 'Blocked for Human', choices: ['Resolved'], instructions: 'Resolve the block.', short: 'Tests fail', long: 'The tests fail on the VM.' });
  assert.equal(byKey['A-5'].reason.change, 'New text');
});

test('ASS-506 AC1: an open blocking question comes with where it is and its index in that file, what question:answer takes', () => {
  const f = fixture();
  const a3 = JSON.parse(cli(f, 'p').stdout).p.find(t => t.key === 'A-3');
  assert.deepEqual(a3.reason.questions, [{ question: 'Which port?', where: 'A-3', index: 1 }]);
  assert.deepEqual(a3.choices, [], 'a question alone offers no gate choice');
});

test('ASS-506: each choice is humanGate\'s, in its order, with the argv the ticket screen runs; a rejection marked as needing a reason', () => {
  const f = fixture();
  const printed = JSON.parse(cli(f, 'p').stdout).p;
  const state = operatorNeededState(f.paths);
  const engines = enginesOf(state.workflows);
  for (const key of ['A-1', 'A-2', 'A-5']) {
    const { tickets } = sprintTickets({ ...state, project: 0, day: null });
    const row = tickets.find(t => t.key === key);
    const gate = humanGate(row, steps, { engines, runs: [], project: 'p' });
    const choices = printed.find(t => t.key === key).choices;
    assert.deepEqual(choices.map(c => c.decision), gate.choices.map(c => c.decision), key);
    assert.deepEqual(choices.map(c => c.argv), gate.choices.map(c => choiceCommand('p', row, c)), key);
  }
  assert.deepEqual(printed.find(t => t.key === 'A-1').choices, [
    { decision: 'Approved', leadsTo: 'Done', argv: ['ticket:human-review', 'p', 'A-1', 'A', 'human-review', 'Approved', 'done'] },
    { decision: 'Rejected', leadsTo: 'Build', argv: ['ticket:human-review', 'p', 'A-1', 'A', 'human-review', 'Rejected', 'build'], 'needs-reason': true },
  ]);
  assert.deepEqual(printed.find(t => t.key === 'A-2').choices, [
    { decision: 'Resolved', leadsTo: 'Build', argv: ['ticket:human-review', 'p', 'A-2', 'A', 'stuck', 'Resolved', 'build'] },
  ]);
  assert.deepEqual(printed.find(t => t.key === 'A-5').choices.map(c => c.argv), [['ticket:keep-current', 'p', 'A-5'], ['ticket:take-new', 'p', 'A-5']]);
});

test('ASS-506 AC1: a project its credentials hold is the one project item, as neededTickets gives it', () => {
  const f = fixture();
  write(join(f.projects, 'q', 'credentials-hold.json'), { since: '2026-11-18T10:00:00Z', problems: [] });
  const printed = JSON.parse(cli(f, 'q').stdout);
  assert.deepEqual(printed, { q: neededTickets(operatorNeededState(f.paths)).q });
  assert.equal(printed.q[0].project, true);
});

test('ASS-506 AC3: it writes nothing — no seen file, nothing in the data — and needs no harness running (no assignments file)', () => {
  const f = fixture();
  const before = snapshot(f.root);
  assert.equal(cli(f).status, 0);
  assert.equal(cli(f, 'p').status, 0);
  assert.deepEqual(snapshot(f.root), before);
});

test('ASS-506 AC4: --help lists it with its usage; an unknown or bad project, or too many arguments, fails with a clear message', () => {
  const f = fixture();
  assert.match(execFileSync(AGENT, ['--help'], { encoding: 'utf8' }), /ticket:operator-needed\s+.*ticket:operator-needed \[<project>\]/);
  const unknown = cli(f, 'nope');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /ticket:operator-needed: no project nope/);
  assert.match(cli(f, '../p').stderr, /invalid project/);
  assert.match(cli(f, 'p', 'q').stderr, /usage: ticket:operator-needed \[<project>\]/);
  assert.throws(() => operatorNeededOf(operatorNeededState(f.paths), 'nope'), /no project nope/);
});

test('ASS-506: one project named prints that project alone', () => {
  const f = fixture();
  assert.deepEqual(Object.keys(JSON.parse(cli(f, 'q').stdout)), ['q']);
});
