// ASS-362 through control: a ticket whose planning group's run is done (its
// plan finished) waits for an in-progress seat holding no planning seat, so
// the next ticket starts planning; the finished ones move on in rank order as
// in-progress seats free; max-tickets-ready-for-build holds the queue at
// committed while it is reached, said once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { runSteps } from '../../src/control/steps.js';
import { tick } from '../../src/control/tick.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const ok = to => [{ condition: { 'exit-code': 0 }, 'move-to-state': to }];
const planning = { 'is-planning-stage': true };

// committed → setup (a script) → plan (a prompt) → approve (a script) → build;
// prepare: a planning group (the test engine) whose run, done, moves on to
// build — a plan finished; build (a script) → review (a prompt) → done.
const steps = [
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
// `own`, its sprint `tickets`: [key, state, manual-priority] each, listed in
// that order and ranked by the priority — 'planned' for one at prepare whose
// test run is done (its sub-status there, its run kept). state(key) is where it stands.
function queue(tickets, { harness = {}, own = {} } = {}) {
  const f = controlFixture();
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps = steps; });
  edit(join(f.dir, 'harness.json'), h => Object.assign(h, { 'max-tickets-in-progress': null, 'max-tickets-in-planning': null }, harness));
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => Object.assign(p, own));
  edit(sprint, s => {
    s.features = tickets.map(([key, state, rank]) => ({ key, 'manual-priority': rank, variations: [{ name: 'A', 'harness-status': state === 'planned' ? { ...hs('prepare'), 'sub-status': { state: 'done', 'state-engine': 'test' } } : hs(state), 'state-changes': [] }] }));
  });
  edit(join(f.dir, 'assignments.json'), a => {
    a['transient-state-engines'] = tickets.filter(([, state]) => state === 'planned').map(([key]) => ({ id: `run-${key}`, project: 'p', 'state-engine': 'test', state: 'done', 'is-done': true, 'structured-output': null, parent: { 'work-item': key, variation: 'A', 'state-engine': 'example-development', state: 'prepare' } }));
  });
  const state = key => f.sprint().features.find(t => t.key === key).variations[0]['harness-status'].state;
  const move = (key, to) => edit(sprint, s => { s.features.find(t => t.key === key).variations[0]['harness-status'] = hs(to); });
  return { ...f, state, move, steps: () => runSteps(f.ctx, f.ctx.load()) };
}

test('ASS-362 AC2: one planning seat, a finished plan waiting with the in-progress seats full — the next-ranked ticket at committed enters planning and is dispatched', async () => {
  const f = queue([['T-1', 'review', 1], ['T-2', 'planned', 2], ['T-3', 'committed', 3]], { own: { 'max-tickets-in-planning': 1, 'max-tickets-in-progress': 1 } });
  await tick(f.ctx);
  assert.deepEqual([f.state('T-1'), f.state('T-2'), f.state('T-3')], ['review', 'prepare', 'plan'], f.lines.join('\n'));
  assert.ok(f.lines.includes('steps T-2 A prepare: waits for an in-progress slot to move to build'), f.lines.join('\n'));
  // T-3's planning agent goes out (T-1's at review too, its seat held).
  for (let i = 0; i < 3 && !f.assignments().assignments.some(a => a['work-item'] === 'T-3'); i++) await tick(f.ctx);
  assert.ok(f.assignments().assignments.some(a => a['work-item'] === 'T-3' && a.state === 'plan'), f.lines.join('\n'));
});

test('ASS-362 AC3: a freed in-progress seat goes to the highest-ranked finished plan; the lower-ranked one and a ticket still planning wait', async () => {
  // Listed out of rank order: T-3 first, T-2 ranked above it; T-4, below both, ready to leave planning by a script step.
  const f = queue([['T-3', 'planned', 3], ['T-1', 'review', 1], ['T-4', 'approve', 4], ['T-2', 'planned', 2]], { own: { 'max-tickets-in-progress': 1 } });
  await f.steps();
  assert.deepEqual(['T-1', 'T-2', 'T-3', 'T-4'].map(f.state), ['review', 'prepare', 'prepare', 'approve']);
  f.move('T-1', 'done');   // its seat freed
  await f.steps();
  assert.deepEqual(['T-1', 'T-2', 'T-3', 'T-4'].map(f.state), ['done', 'review', 'prepare', 'approve'], f.lines.join('\n'));
  // Freed again, the next of the queue takes it — still ahead of T-4.
  f.move('T-2', 'done');
  await f.steps();
  assert.deepEqual(['T-3', 'T-4'].map(f.state), ['review', 'approve']);
});

test('ASS-362 AC5: while max-tickets-ready-for-build is reached no ticket enters planning — it waits at committed, said once — and once there is room it does', async () => {
  const f = queue([['T-1', 'review', 1], ['T-2', 'planned', 2], ['T-3', 'committed', 3]], { own: { 'max-tickets-in-progress': 1, 'max-tickets-ready-for-build': 1 } });
  await f.steps();
  await f.steps();
  assert.deepEqual(['T-2', 'T-3'].map(f.state), ['prepare', 'committed']);
  assert.equal(f.lines.filter(l => l === 'steps T-3 A committed: waits to enter planning: max-tickets-ready-for-build reached (1 ready for build, 0 in planning)').length, 1, f.lines.join('\n'));
  // T-2 moves on to Build: the queue has room again.
  f.move('T-1', 'done');
  await f.steps();
  assert.deepEqual(['T-2', 'T-3'].map(f.state), ['review', 'plan']);
  // harness.json's counts every project's together, as the other ticket limits do.
  const g = queue([['T-1', 'review', 1], ['T-2', 'planned', 2], ['T-3', 'committed', 3]], { harness: { 'max-tickets-in-progress': 1, 'max-tickets-ready-for-build': 1 } });
  await g.steps();
  assert.equal(g.state('T-3'), 'committed');
});
