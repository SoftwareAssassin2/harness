// ASS-126: the ticket limits cap tickets in motion, not just agents. A ticket
// moves into a planning step (but the queue) only holding or able to take a
// planning slot (max-tickets-in-planning), into any other step an in-progress
// one (max-tickets-in-progress) — through steps no agent works too, slots in
// rank order; Blocked, a human's step and Done hold none. harness.json's
// limits count every project's tickets; the project's own (project.json) its.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { runSteps } from '../../src/control/steps.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const ok = to => [{ condition: { 'exit-code': 0 }, 'move-to-state': to }];
const planning = { 'is-planning-stage': true };

// committed → setup (a script) → plan (a prompt) → approve (a script) → build
// (a script) → review (a prompt) → done; setup to approve plan, build on is in
// progress. prepare: a planning group (the test engine) whose run, done, moves on to build.
const steps = [
  { id: 'blocked', sequence: 0, 'is-blocked-state': true, action: { type: 'human' } },
  { id: 'backlog', sequence: 1, ...planning, action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'committed' }] },
  { id: 'committed', sequence: 2, ...planning, action: { type: 'none' }, 'exit-events': [{ condition: { 'agent-needs-work': true }, 'move-to-state': 'setup' }] },
  { id: 'setup', sequence: 3, ...planning, action: { type: 'script', command: 'true' }, 'exit-events': ok('plan') },
  { id: 'plan', sequence: 4, ...planning, action: { type: 'prompt', prompt: 'review-plan' } },
  { id: 'approve', sequence: 5, ...planning, action: { type: 'script', command: 'true' }, 'exit-events': ok('build') },
  { id: 'prepare', sequence: 6, ...planning, action: { type: 'state-engine', engine: 'test' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'build' }] },
  { id: 'build', sequence: 7, action: { type: 'script', command: 'true' }, 'exit-events': ok('review') },
  { id: 'review', sequence: 8, action: { type: 'prompt', prompt: 'test' } },
  { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } },
];

// The control fixture on that engine, harness.json's limits `harness`, p's own
// `own`, and its sprint `tickets`: [key, state, manual-priority] each — listed
// in that order, ranked by the priority. state(key) is where it stands.
function slots(tickets, { harness = {}, own = {} } = {}) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps = steps; });
  edit(join(f.dir, 'harness.json'), h => Object.assign(h, { 'max-tickets-in-progress': null, 'max-tickets-in-planning': null }, harness));
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => Object.assign(p, own));
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features = tickets.map(([key, state, rank]) => ({ key, 'manual-priority': rank, variations: [{ name: 'A', 'harness-status': hs(state), 'state-changes': [] }] }));
  });
  const state = key => f.sprint().features.find(t => t.key === key).variations[0]['harness-status'].state;
  return { ...f, state, steps: () => runSteps(f.ctx, f.ctx.load()) };
}

test('ASS-126 AC6: with a planning limit of 1 and two tickets at Committed only the higher-ranked moves, through the script step no agent works', async () => {
  const f = slots([['T-2', 'committed', 2], ['T-1', 'committed', 1]], { harness: { 'max-tickets-in-planning': 1 } });
  await f.steps();
  assert.deepEqual([f.state('T-1'), f.state('T-2')], ['plan', 'committed']);
});

test('ASS-126 AC6: a planning step takes a planning slot, not an in-progress one — and a ticket enters progress only with an in-progress slot', async () => {
  // In progress full: a ticket from the queue still goes into planning.
  const f = slots([['T-1', 'review', 1], ['T-2', 'committed', 2]], { harness: { 'max-tickets-in-progress': 1, 'max-tickets-in-planning': 1 } });
  await f.steps();
  assert.deepEqual([f.state('T-1'), f.state('T-2')], ['review', 'plan']);
  // …but not out of it, by a script step: it waits at approve, said once.
  const g = slots([['T-1', 'review', 1], ['T-2', 'approve', 2]], { harness: { 'max-tickets-in-progress': 1 } });
  await g.steps();
  await g.steps();
  assert.deepEqual([g.state('T-1'), g.state('T-2')], ['review', 'approve']);
  assert.equal(g.lines.filter(l => /^steps T-2 A approve: waits for an in-progress slot to move to build$/.test(l)).length, 1, g.lines.join('\n'));
  // A ticket holding its slot moves on within it: never stalled by its own.
  const h = slots([['T-1', 'build', 1], ['T-2', 'approve', 2]], { harness: { 'max-tickets-in-progress': 1 } });
  await h.steps();
  assert.deepEqual([h.state('T-1'), h.state('T-2')], ['review', 'approve']);
});

test('ASS-126 AC2: Blocked, Blocked for Human (here a human step) and Done hold no slot — the next ticket in rank order takes the freed one', async () => {
  for (const first of ['blocked', 'done']) {
    const f = slots([['T-3', 'approve', 3], ['T-1', first, 1], ['T-2', 'approve', 2]], { harness: { 'max-tickets-in-progress': 1 } });
    await f.steps();
    assert.deepEqual([f.state('T-1'), f.state('T-2'), f.state('T-3')], [first, 'review', 'approve'], first);
  }
});

test('ASS-126 AC1: a ticket whose planning group\'s run is done waits for an in-progress slot before it moves on, its run kept', async () => {
  const f = slots([['T-1', 'review', 1], ['T-2', 'prepare', 2]], { harness: { 'max-tickets-in-progress': 1 } });
  edit(join(f.dir, 'assignments.json'), a => {
    a['transient-state-engines'] = [{ id: 'run-1', project: 'p', 'state-engine': 'test', state: 'done', 'is-done': true, 'structured-output': null, parent: { 'work-item': 'T-2', variation: 'A', 'state-engine': 'example-development', state: 'prepare' } }];
  });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[1].variations[0]['harness-status']['sub-status'] = { state: 'done', 'state-engine': 'test' }; });
  await f.steps();
  assert.equal(f.state('T-2'), 'prepare');
  assert.equal(f.assignments()['transient-state-engines'].length, 1);
  // The slot freed, it moves on.
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0]['harness-status'] = hs('done'); });
  await f.steps();
  assert.equal(f.state('T-2'), 'review');
});

test('ASS-126 AC3: the project\'s own limits apply when harness.json\'s are higher; a project value of 0 means none', async () => {
  const f = slots([['T-1', 'committed', 1], ['T-2', 'committed', 2]], { harness: { 'max-tickets-in-planning': 5 }, own: { 'max-tickets-in-planning': 1 } });
  await f.steps();
  assert.deepEqual([f.state('T-1'), f.state('T-2')], ['plan', 'committed']);
  const g = slots([['T-1', 'committed', 1]], { harness: { 'max-tickets-in-planning': 5 }, own: { 'max-tickets-in-planning': 0 } });
  await g.steps();
  assert.equal(g.state('T-1'), 'committed');
});

test('ASS-126 AC3: harness.json\'s limits count every project\'s tickets in motion together', async () => {
  const f = slots([['T-1', 'approve', 1]], { harness: { 'max-tickets-in-progress': 1 }, own: { 'max-tickets-in-progress': 3 } });
  // x: another project on the same engine, a ticket in progress.
  const at = (...rest) => join(f.dir, 'projects', 'x', ...rest);
  mkdirSync(at('sprints', 'sprint-1'), { recursive: true });
  writeFileSync(at('project.json'), JSON.stringify({ name: 'X', 'execution-state-engine': 'example-development', 'work-sources': [] }));
  writeFileSync(at('sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': true }] }));
  writeFileSync(at('sprints', 'sprint-1', 'sprint.json'), JSON.stringify({ number: 1, features: [{ key: 'X-1', variations: [{ name: 'A', 'harness-status': hs('review'), 'state-changes': [] }] }], bugs: [], spikes: [] }));
  await f.steps();
  assert.equal(f.state('T-1'), 'approve');
});
