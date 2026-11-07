// A project's own state engines (ASS-276): control reads data/projects/
// <project>/engines/<name>/state-engine.json into that project's engines,
// over engines/'s of the same name, and runs its work on them — the engines a
// grouped engine names too. Another project, and state.engines, never see them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { paths, loadState, enginesFor } from '../../src/control/state.js';
import { fixture } from '../agent-cli/harness-fixture.js';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { fakeVm } from '../support/fake-vm.js';
import { engineDir, engineNames } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const write = (file, content) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(content)); };
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
// own(dir, project, …names) — each engine moved out of engines/ into the project's own folder, its content as it is.
const own = (dir, project, ...names) => names.forEach(name => {
  cpSync(join(dir, 'engines', name), join(dir, 'projects', project, 'engines', name), { recursive: true });
  rmSync(join(dir, 'engines', name), { recursive: true });
});

test('loadState gives a project its own engines over engines/\'s of the same name; another project and state.engines keep engines/\'s', () => {
  const f = fixture();
  write(join(f.dir, 'projects', 'p', 'engines', 'test', 'state-engine.json'), { steps: [{ id: 'own', sequence: 1 }] });
  write(join(f.dir, 'projects', 'p', 'engines', 'only-p', 'state-engine.json'), { steps: [{ id: 'mine', sequence: 1 }] });
  const state = loadState(paths('/repo', f.env));
  const [p, q] = state.projects;
  assert.deepEqual(p.engines.test.steps.map(s => s.id), ['own']);
  assert.deepEqual(p.engines['only-p'].steps.map(s => s.id), ['mine']);
  assert.equal(p.engines['example-development'], state.engines['example-development']);   // engines/'s where it has none of its own
  assert.deepEqual(q.engines.test.steps.map(s => s.id), ['test', 'take-screenshots', 'done']);
  assert.equal(q.engines['only-p'], undefined);
  assert.deepEqual(Object.keys(state.engines).toSorted(), ['example-development', 'self-healing', 'test']);
  assert.equal(enginesFor(state, 'p'), p.engines);
});

test('ASS-276 AC3: with its execution engine and sub-engine only in data/projects/p/engines, p\'s engine, steps and switched-off steps resolve', () => {
  const f = fixture();
  own(f.dir, 'p', 'example-development', 'test');
  edit(join(f.dir, 'projects', 'p', 'engines', 'test', 'state-engine.json'), e => { e.steps[1]['exit-events'] = [{ condition: { always: true }, 'move-to-state': 'done' }]; });
  edit(join(f.dir, 'projects', 'p', 'project.json'), j => { j['switched-off-steps'] = ['test/take-screenshots']; });
  const state = loadState(paths('/repo', f.env));
  const [p, q] = state.projects;
  assert.equal(p.engineName, 'example-development');
  assert.deepEqual(p.engine.steps.map(s => s.id), ['generate-solution', 'local-testing', 'done']);
  assert.deepEqual(p.switchedOffErrors, []);
  assert.equal(p.engines.test.steps.find(s => s.id === 'take-screenshots')['is-active'], false);
  assert.equal(q.engine, undefined);                                                         // q has no copy of its own
  assert.equal(state.engines['example-development'], undefined);
});

test('ASS-276 AC3: tick on example-development-grouped with it and its Setup and Plan sub-engines only in data/projects/p/engines moves a ticket from the backlog through Setup into Plan', async () => {
  const f = controlFixture();
  const at = (...rest) => join(f.dir, ...rest);
  for (const name of engineNames()) if (!existsSync(at('engines', name)) && existsSync(join(engineDir(name), 'state-engine.json'))) cpSync(engineDir(name), at('engines', name), { recursive: true });
  own(f.dir, 'p', 'example-development-grouped', 'example-backlog-refinement', 'grouped-setup', 'grouped-plan');
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0].vm = { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' }; });
  await f.agent('project:set-execution-engine', 'p', 'example-development-grouped');
  const v = fakeVm(f.env);
  v.instance('abc-3-a', 'Running');
  mkdirSync(join(v.root, 'repos'));
  writeFileSync(join(v.root, 'repos', '.setup-complete'), '');
  f.ctx.env = v.env;
  try {
    for (let i = 0; i < 6 && f.variation()['harness-status'].state !== 'plan'; i++) { await tick(f.ctx); await Promise.all([...(f.ctx.memory.vms?.values() ?? [])].map(r => r.job)); }
    assert.deepEqual(f.variation()['harness-status'], { state: 'plan', 'state-engine': 'example-development-grouped', 'sub-status': { state: 'enrich-ac', 'state-engine': 'grouped-plan' } }, f.lines.join('\n'));
    assert.deepEqual(f.variation()['state-changes'].filter(c => c['to-state'] === 'setup' && c['sub-state-change']).map(c => c['sub-state-change']['to-state']), ['check-setup-complete', 'done']);
  } finally {
    f.ctx.stopAgents();
  }
});
