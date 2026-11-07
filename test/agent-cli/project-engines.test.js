// A project's own state engines (ASS-276): data/projects/<project>/engines/
// <name>/state-engine.json, looked up first for that project's work, then
// engines/ — engine.bash's resolver, and the agent-cli commands that read an
// engine through it, the engines a grouped engine names and the "-prompt"
// keys prompt.bash reads among them. Another project never sees them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, run, AGENT, TEST_ENGINE } from './harness-fixture.js';

const ENGINE_BASH = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'engine.bash');
const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
const write = (file, content) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(content)); };
// bash(f, script) — the script's stdout, engine.bash sourced first, in the fixture's env.
const bash = async (f, script) => (await run('bash', ['-c', `source "${ENGINE_BASH}"; ${script}`], { env: f.env })).stdout;
// own(f, project, …names) — each engine moved out of engines/ into the project's own folder, its content as it is.
const own = (f, project, ...names) => names.forEach(name => {
  cpSync(join(f.dir, 'engines', name), join(f.dir, 'projects', project, 'engines', name), { recursive: true });
  rmSync(join(f.dir, 'engines', name), { recursive: true });
});
const step = (id, engine) => ({ id, sequence: 1, 'is-done': null, action: { type: 'state-engine', engine } });

test('engine_path finds a project\'s own engine before engines/\'s, engines/\'s for another project or none, and nothing for a name that climbs out', async () => {
  const f = fixture();
  write(join(f.dir, 'projects', 'p', 'engines', 'test', 'state-engine.json'), { steps: [] });
  write(join(f.dir, 'projects', 'p', 'engines', 'only-p', 'state-engine.json'), { steps: [] });
  assert.equal(await bash(f, 'engine_path test p'), `${join(f.dir, 'projects', 'p', 'engines', 'test', 'state-engine.json')}\n`);
  assert.equal(await bash(f, 'engine_path test q'), `${join(f.dir, 'engines', 'test', 'state-engine.json')}\n`);
  assert.equal(await bash(f, 'engine_path test'), `${join(f.dir, 'engines', 'test', 'state-engine.json')}\n`);
  assert.equal(await bash(f, 'engine_path only-p p'), `${join(f.dir, 'projects', 'p', 'engines', 'only-p', 'state-engine.json')}\n`);
  assert.equal(await bash(f, 'engine_path only-p q || echo none'), 'none\n');
  assert.equal(await bash(f, 'engine_path ../engines/test p || echo none'), 'none\n');
  assert.equal(await bash(f, 'engine_path test ../p'), `${join(f.dir, 'engines', 'test', 'state-engine.json')}\n`);   // no project folder outside the projects folder
});

test('engine_steps_of and engine_file take the project, its own engine shadowing engines/\'s of the same name for it alone', async () => {
  const f = fixture();
  write(join(f.dir, 'projects', 'p', 'engines', 'test', 'state-engine.json'), { steps: [{ id: 'own', sequence: 1 }] });
  assert.deepEqual(JSON.parse(await bash(f, 'engine_steps_of x test p')).map(s => s.id), ['own']);
  assert.deepEqual(JSON.parse(await bash(f, 'engine_steps_of x test q')).map(s => s.id), ['test', 'take-screenshots', 'done']);
  assert.equal(await bash(f, 'engine_file x test p'), `${join(f.dir, 'projects', 'p', 'engines', 'test', 'state-engine.json')}\n`);
  own(f, 'p', 'example-development');
  assert.deepEqual(JSON.parse(await bash(f, 'engine_steps_of x example-development/check-health-steps p')).map(s => s.id), ['check-health', 'done']);
  await assert.rejects(bash(f, 'engine_steps_of x example-development q'), e => /x: no state engine example-development/.test(e.stderr));
});

test('connected_engines follows a grouped engine into the sub-engines the project alone has, and theirs', async () => {
  const f = fixture();
  write(join(f.dir, 'engines', 'grouped-x', 'state-engine.json'), { steps: [step('a', 'sub-x')], 'check-steps': [step('c', 'test')] });
  write(join(f.dir, 'projects', 'p', 'engines', 'sub-x', 'state-engine.json'), { steps: [step('b', 'sub-sub-x')] });
  write(join(f.dir, 'projects', 'p', 'engines', 'sub-sub-x', 'state-engine.json'), { steps: [] });
  assert.equal(await bash(f, 'connected_engines grouped-x p'), 'sub-x\ntest\nsub-sub-x\n');
  assert.equal(await bash(f, 'connected_engines grouped-x q'), 'sub-x\ntest\n');   // q has no sub-x to follow
});

test('engine_files lists every engine the project sees, engines/\'s first and then its own, so a by-name reduce keeps its own', async () => {
  const f = fixture();
  write(join(f.dir, 'projects', 'p', 'engines', 'test', 'state-engine.json'), { steps: [] });
  const engines = join(f.dir, 'engines'), mine = join(f.dir, 'projects', 'p', 'engines');
  assert.deepEqual((await bash(f, 'engine_files p')).trim().split('\n'),
    ['example-development', 'self-healing', 'test'].map(n => join(engines, n, 'state-engine.json')).concat(join(mine, 'test', 'state-engine.json')));
  assert.deepEqual((await bash(f, 'engine_files q')).trim().split('\n'), ['example-development', 'self-healing', 'test'].map(n => join(engines, n, 'state-engine.json')));
  rmSync(engines, { recursive: true });
  assert.equal(await bash(f, 'engine_files q'), '');
});

// AC3: the project's engines copied into its own folder and gone from engines/ — they still resolve for its work.
test('ASS-276 AC3: with its engines only in data/projects/p/engines, p\'s prompts, runs, moves, gates and assignments still find them; q, without, does not', async () => {
  const f = fixture();
  own(f, 'p', 'example-development', 'test');
  // The "-prompt" keys of the record's engine (receive-dispatch-prompt), and of the project's execution engine for a run whose engine has none.
  assert.match((await f.agent('agent:dispatch', 'Daredevil')).stdout, /^You are a developer\.\n\nLEAD update: /);
  await f.agent('agent:dispatch', 'Leia');
  assert.match(f.inbox('Leia', '20261008T000000Z')[0], /^LEAD update: .*\nFind a ticket in p for: the build is red$/);
  assert.equal((await f.agent('agent:shut-down', 'Spock')).stderr, '');
  assert.deepEqual(f.inbox('Spock'), ['STOP NOW']);
  // Runs of its engines and their lists, and a run's move.
  await f.agent('transient-state-engine:create', 'p', 'test', 'test', '{"trigger":"x"}');
  await f.agent('transient-state-engine:create', 'p', 'example-development/check-health-steps', 'check-health', '{"trigger":"check-health"}');
  await f.agent('transient-state-engine:change-state', TEST_ENGINE, 'test', 'take-screenshots');
  assert.equal(f.assignments()['transient-state-engines'].find(r => r.id === TEST_ENGINE).state, 'take-screenshots');
  // A ticket's move into the sub-engine its step names, and a gate on a step of it.
  await f.agent('ticket:change-state', 'p', 'ABC-3', 'A', 'generate-solution', 'local-testing', 'take-screenshots');
  assert.deepEqual(f.variation('A')['harness-status'], { state: 'local-testing', 'state-engine': 'example-development', 'sub-status': { state: 'take-screenshots', 'state-engine': 'test' } });
  await f.agent('ticket:set-gate-when-leaving-state', 'p', 'ABC-3', 'C', 'test/take-screenshots');
  assert.deepEqual(f.variation('C')['gate-when-leaving-state'], ['test/take-screenshots']);
  await f.agent('assignments:create', 'p', 'example-development', 'local-testing', 'generate-solution', '1', 'false', 'ABC-3', 'C', '-');
  // q has no copy of its own.
  await fails(f.agent('transient-state-engine:create', 'q', 'test', 'test', '{}'), /no state engine test/);
  await fails(f.agent('assignments:create', 'q', 'example-development', 'generate-solution', 'generate-solution', '1', 'false', 'Q-1', 'A', '-'), /no state engine example-development/);
});

test('ASS-276: a project switches onto an engine of its own, and a grouped engine\'s project-only sub-engine is entered and run', async () => {
  const f = fixture();
  const grouped = JSON.parse(readFileSync(join(f.dir, 'engines', 'example-development', 'state-engine.json'), 'utf8'));
  grouped.steps = grouped.steps.map(s => (s.id === 'local-testing' ? { ...s, action: { type: 'state-engine', engine: 'own-test' } } : s));
  write(join(f.dir, 'projects', 'p', 'engines', 'own-grouped', 'state-engine.json'), grouped);
  cpSync(join(f.dir, 'engines', 'test'), join(f.dir, 'projects', 'p', 'engines', 'own-test'), { recursive: true });
  assert.match((await f.agent('project:set-execution-engine', 'p', 'own-grouped')).stdout, /p: example-development → own-grouped/);
  await f.agent('ticket:change-state', 'p', 'ABC-3', 'A', 'generate-solution', 'local-testing', 'test');
  assert.deepEqual(f.variation('A')['harness-status'], { state: 'local-testing', 'state-engine': 'own-grouped', 'sub-status': { state: 'test', 'state-engine': 'own-test' } });
  await f.agent('transient-state-engine:create', 'p', 'own-test', 'test', '{"trigger":"x"}');
  await fails(f.agent('project:set-execution-engine', 'q', 'own-grouped'), /no state engine own-grouped/);
});

test('ASS-276: ticket:sync seeds backlog tickets at the first step of a refinement engine only the project has, named by its own execution engine', async () => {
  const f = fixture();
  own(f, 'p', 'example-development');
  const file = join(f.dir, 'projects', 'p', 'engines', 'example-development', 'state-engine.json');
  write(file, { ...JSON.parse(readFileSync(file, 'utf8')), 'backlog-refinement-steps': [step('refine', 'own-refinement')] });
  write(join(f.dir, 'projects', 'p', 'engines', 'own-refinement', 'state-engine.json'), { steps: [{ id: 'second', sequence: 2 }, { id: 'first', sequence: 1 }] });
  write(join(f.dir, 'projects', 'p', 'backlog.json'), { tickets: [] });
  write(join(f.dir, 'fetched.json'), { tickets: [{ key: 'ABC-9', title: 'New', 'ticket-system-status': 'Backlog' }] });
  await f.agent('ticket:sync', 'p', 'backlog', join(f.dir, 'fetched.json'));
  const [ticket] = JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'backlog.json'), 'utf8')).tickets;
  assert.deepEqual(ticket.variations[0]['harness-status'], { state: 'first', 'state-engine': 'own-refinement' });
});
