// project:set-execution-engine (ASS-68 AC6): a project switched to another
// execution engine — its grouped engine — and back, the rollback, each
// project on its own: project.json's execution-state-engine, and the engine
// its sprint's variations stand in, so the ticket system keeps following
// their steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './harness-fixture.js';
import { engineDir } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

// The fixture with the real example-development and example-development-grouped engines; p's variations A, B and C at
// steps both have (committed, done, backlog), D deleted; A gated on leaving committed.
function engines() {
  const f = fixture();
  const at = (...rest) => join(f.dir, ...rest);
  for (const name of ['example-development', 'example-development-grouped']) cpSync(engineDir(name), at('engines', name), { recursive: true });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    const [a, b, c] = s.features[0].variations;
    Object.assign(a, { 'harness-status': { state: 'committed', 'state-engine': 'example-development' }, 'gate-when-leaving-state': ['example-development/committed', 'test/take-screenshots'] });
    b['harness-status'] = { state: 'done', 'state-engine': 'example-development' };
    c['harness-status'] = { state: 'backlog', 'state-engine': 'example-development' };
    s.features[0]['ticket-system-status'] = 'To Do';
  });
  const project = id => JSON.parse(readFileSync(at('projects', id, 'project.json'), 'utf8'));
  return { ...f, project, statuses: () => f.sprint().features[0].variations.map(v => v['harness-status']) };
}

test('project:set-execution-engine switches a project to its grouped engine and back: project.json, and the engine each sprint variation stands in, its gates with it — the other project left alone', async () => {
  const f = engines();
  const before = f.statuses();
  const out = await f.agent('project:set-execution-engine', 'p', 'example-development-grouped');
  assert.match(out.stdout, /p: example-development → example-development-grouped/);
  assert.equal(f.project('p')['execution-state-engine'], 'example-development-grouped');
  assert.equal(f.project('q')['execution-state-engine'], 'example-development', 'each project switches on its own');
  const [a, b, c, d] = f.statuses();
  assert.deepEqual([a, b, c], [
    { state: 'committed', 'state-engine': 'example-development-grouped' },
    { state: 'done', 'state-engine': 'example-development-grouped' },
    { state: 'backlog', 'state-engine': 'example-development-grouped' },
  ]);
  assert.deepEqual(d, before[3], 'a deleted variation is left as it was');
  assert.deepEqual(f.variation('A')['gate-when-leaving-state'], ['example-development-grouped/committed', 'test/take-screenshots']);
  // The ticket system follows the new engine's steps: committed → setup pairs In Progress.
  await f.agent('ticket:change-state', 'p', 'ABC-3', 'A', 'committed', 'setup');
  assert.equal(f.sprint().features[0]['ticket-system-status'], 'In Progress');
  await f.agent('ticket:change-state', 'p', 'ABC-3', 'A', 'setup', 'committed');

  await f.agent('project:set-execution-engine', 'p', 'example-development');   // the rollback
  assert.equal(f.project('p')['execution-state-engine'], 'example-development');
  assert.deepEqual(f.statuses().map(s => s['state-engine']), ['example-development', 'example-development', 'example-development', before[3]['state-engine']]);
  assert.deepEqual(f.variation('A')['gate-when-leaving-state'], ['example-development/committed', 'test/take-screenshots']);
});

test('project:set-execution-engine refuses, writing nothing, an unknown engine or a sprint variation at a step the engine does not have', async () => {
  const f = engines();
  const snapshot = () => f.snapshot() + JSON.stringify(f.project('p'));
  const before = snapshot();
  await assert.rejects(f.agent('project:set-execution-engine', 'p', 'nope'), /project:set-execution-engine: no state engine nope/);
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0]['harness-status'].state = 'generate-solution'; });
  const moved = snapshot();
  await assert.rejects(f.agent('project:set-execution-engine', 'p', 'example-development-grouped'), /ABC-3 A is at generate-solution, which example-development-grouped has no step for: move it first/);
  assert.equal(snapshot(), moved);
  assert.notEqual(before, moved);
  // Blocked hands a ticket back to the step it came from, which is the old engine's: it finishes there first.
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0]['harness-status'] = { state: 'blocked', 'state-engine': 'example-development', 'sub-status': { state: 'troubleshoot', 'state-engine': 'blocked' } }; });
  const blocked = snapshot();
  await assert.rejects(f.agent('project:set-execution-engine', 'p', 'example-development-grouped'), /ABC-3 A is at blocked, which returns it to a step of example-development: let it finish first/);
  assert.equal(snapshot(), blocked);
  await assert.rejects(f.agent('project:set-execution-engine', '../p', 'example-development'), /invalid project/);
});

test('project:set-execution-engine stopped after the sprint, before project.json, finishes the switch when run again (ASS-178)', async () => {
  const f = engines();
  const config = join(f.dir, 'projects', 'p', 'project.json');
  const before = readFileSync(config, 'utf8');
  await f.agent('project:set-execution-engine', 'p', 'example-development-grouped');
  const switched = f.sprint();
  writeFileSync(config, before);                                              // project.json's write never happened
  assert.match((await f.agent('project:set-execution-engine', 'p', 'example-development-grouped')).stdout, /p: example-development → example-development-grouped/);
  assert.equal(f.project('p')['execution-state-engine'], 'example-development-grouped');
  assert.deepEqual(f.sprint(), switched);
});
