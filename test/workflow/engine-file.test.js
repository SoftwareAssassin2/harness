// ASS-524: engines are workflow.yaml, read by one loader (src/workflow/engine-file.js),
// converted once from state-engine.json (convertEngines, engine:convert-to-yaml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseEngine, readEngine, stringifyEngine, convertEngine, convertEngines, engineNamesIn, ENGINE_FILE, LEGACY_ENGINE_FILE } from '../../src/workflow/engine-file.js';
import { validateEngineFile } from '../../src/workflow/validate.js';
import { readEngines } from '../../src/control/state.js';
import { loadWorkflows } from '../../src/tui/load.js';
import { EXAMPLE_ENGINES } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'engine-file-'));
const put = (dir, name, file, text) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, file), text); return join(dir, name, file); };

const GOOD = `# The test engine: one step, then done.
steps:
  - id: build   # the step's id, what exits move to
    sequence: 1
    name: Build
    action:
      type: prompt
      prompt: test
      model: claude-opus-5-5
    exit-events:
      - condition:
          turn-complete: true
        move-to-state: done
  - id: done
    sequence: 2
    is-done: true
    action: { type: none }
paired: "yes"
`;

test('AC6: a good workflow.yaml reads as its engine, comments ignored, key order kept, YAML 1.2 strings left strings', () => {
  const engine = parseEngine(GOOD, 'x/workflow.yaml');
  assert.deepEqual(engine, {
    steps: [
      { id: 'build', sequence: 1, name: 'Build', action: { type: 'prompt', prompt: 'test', model: 'claude-opus-5-5' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }] },
      { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
    ],
    paired: 'yes',
  });
  assert.deepEqual(Object.keys(engine.steps[0]), ['id', 'sequence', 'name', 'action', 'exit-events']);
  assert.equal(parseEngine('steps: []\nstatus: on\n').status, 'on');   // YAML 1.2 core: on, yes, no are strings, as they were in JSON
});

test('AC6: a JSON engine in a workflow.yaml reads as it did (JSON is YAML)', () => {
  const json = { steps: [{ id: 'a', sequence: 1, description: 'quotes "and" colons: here', action: { type: 'none' } }] };
  assert.deepEqual(parseEngine(JSON.stringify(json, null, 2)), json);
});

test('AC4/AC6: a malformed workflow.yaml fails with its file, line and reason', () => {
  const bad = 'steps:\n  - id: a\n    sequence: 1\n   name: wrong indent\n';
  assert.throws(() => parseEngine(bad, 'e/workflow.yaml'), error => {
    assert.ok(error instanceof SyntaxError);   // read.js tries a SyntaxError again, as a half-written JSON
    assert.match(error.message, /^e\/workflow\.yaml:4:\d+: \S/);
    assert.equal(error.file, 'e/workflow.yaml');
    assert.equal(error.line, 4);
    return true;
  });
  assert.throws(() => parseEngine('steps: []\nsteps: []\n', 'f'), /^SyntaxError: f:2:1: Map keys must be unique/);
  assert.throws(() => parseEngine('', 'f'), /f:1:1: the file is empty/);
  assert.throws(() => parseEngine('- a\n- b\n', 'f'), /f:1:1: an engine is a mapping/);
});

test('AC4: validation of a malformed workflow.yaml names the file, line and reason; a good one validates', () => {
  const dir = tmp();
  const bad = put(dir, 'bad', ENGINE_FILE, 'steps:\n  - id: a\n    exit-events: [\n');
  const errors = validateEngineFile(bad, ROOT, 'bad');
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`^${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+:\\d+: .+`));
  assert.deepEqual(validateEngineFile(put(dir, 'good', ENGINE_FILE, GOOD.replace('prompt: test', 'prompt: test')), ROOT, 'good').filter(e => !/model|prompt/.test(e)), []);
});

test('AC4: engine:validate prints the file, line and reason of a malformed engine and fails; passes for the real engines', () => {
  const dir = tmp();
  const bad = put(dir, 'bad', ENGINE_FILE, 'steps:\n  - id: a\n  sequence: 1\n');
  const run = spawnSync(join(ROOT, 'agent.sh'), ['engine:validate', '-'], { env: { ...process.env, ENGINES_DIR: dir }, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, new RegExp(`^bad: ${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:3:\\d+: `));
  const real = spawnSync(join(ROOT, 'agent.sh'), ['engine:validate', '-'], { encoding: 'utf8' });
  assert.equal(real.status, 0, real.stdout + real.stderr);
  assert.match(real.stdout, /^\d+ engines valid\n$/);
});

test('AC1: every engine in engines/ and the example fixtures is a workflow.yaml; no state-engine.json remains', () => {
  for (const dir of [join(ROOT, 'engines'), EXAMPLE_ENGINES]) {
    const folders = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    assert.ok(folders.length > 0);
    for (const name of folders) {
      assert.ok(existsSync(join(dir, name, ENGINE_FILE)), `${dir}/${name}: no ${ENGINE_FILE}`);
      assert.ok(!existsSync(join(dir, name, LEGACY_ENGINE_FILE)), `${dir}/${name}: a ${LEGACY_ENGINE_FILE} remains`);
      assert.doesNotThrow(() => readEngine(join(dir, name, ENGINE_FILE)), name);
    }
    assert.deepEqual(engineNamesIn(dir).toSorted(), folders.toSorted());
  }
});

// sinceConverted(name, old) — engine `name` as the JSON `old` was, with the changes made to it since the
// conversion applied. ASS-552: grouped-build's CI Checks removed (exits to it led to Code Review, the sequences
// closed up) and removed-steps-move-to added at the top. ASS-560: v2-release's Merge Pull Request merges side by side —
// its description, max-visits 5, record-script-output, and its base-moved exit back into itself first.
// ASS-556: grouped-plan's and v2-plan's Choose Where to Work and Record Where to Work after Review Plan's approval (its
// approved exit to them, done and blocked after).
function sinceConverted(name, old) {
  if ((name === 'grouped-plan' || name === 'v2-plan') && !old.steps.some(s => s.id === 'choose-work-mode')) {
    const now = readEngine(join(ROOT, 'engines', name, ENGINE_FILE)).steps, added = now.filter(s => ['choose-work-mode', 'record-work-mode'].includes(s.id));
    const ends = Object.fromEntries(now.filter(s => ['done', 'blocked'].includes(s.id)).map(s => [s.id, s.sequence]));
    const steps = old.steps.flatMap(s => {
      if (s.id === 'review-plan') return [{ ...s, 'exit-events': s['exit-events'].map(e => (e['move-to-state'] === 'done' ? { ...e, 'move-to-state': 'choose-work-mode' } : e)) }];
      if (s.id === 'done') return [...added, { ...s, sequence: ends.done }];
      if (s.id === 'blocked') return [{ ...s, sequence: ends.blocked }];
      return [s];
    });
    return { ...old, steps };
  }
  if (name === 'v2-release') {
    const now = readEngine(join(ROOT, 'engines', name, ENGINE_FILE)).steps.find(s => s.id === 'merge-pull-request');
    return { ...old, steps: old.steps.map(s => (s.id !== 'merge-pull-request' || s['exit-events'].length !== 3 ? s : {
      ...Object.fromEntries(Object.entries(s).flatMap(([k, v]) => (k === 'on-max-visits' ? [[k, v], ['record-script-output', true]] : [[k, k === 'description' ? now.description : k === 'max-visits' ? 5 : v]]))),
      'exit-events': [now['exit-events'][0], ...s['exit-events']],
    })) };
  }
  if (name !== 'grouped-build' || !old.steps.some(s => s.id === 'ci-checks')) return old;
  const at = old.steps.find(s => s.id === 'ci-checks').sequence;
  const steps = old.steps.filter(s => s.id !== 'ci-checks').map(s => ({ ...s, ...(s.sequence > at ? { sequence: s.sequence - 1 } : {}),
    ...(s['exit-events'] ? { 'exit-events': s['exit-events'].map(e => (e['move-to-state'] === 'ci-checks' ? { ...e, 'move-to-state': 'code-review' } : e)) } : {}) }));
  return { 'removed-steps-move-to': { 'ci-checks': 'code-review' }, ...old, steps };
}

test('AC1: the converted engines hold the very engines the JSON did (as git had them before the commit that removed them, where the history is there)', () => {
  // The JSON each engine was, from git; skipped where git or the history is unavailable.
  const show = path => { try { return execFileSync('git', ['-C', ROOT, 'show', `${base}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
  let base;
  try { base = execFileSync('git', ['-C', ROOT, 'log', '--diff-filter=D', '--format=%H', '-1', '--', 'engines/test/state-engine.json'], { encoding: 'utf8' }).trim(); } catch { return; }
  if (!base) return;
  base = `${base}~`;
  let compared = 0;
  for (const name of engineNamesIn(join(ROOT, 'engines'))) {
    const json = show(`engines/${name}/state-engine.json`);
    if (json === null) continue;
    // ASS-540: the run-targets added to some steps since are left out of the comparison. ASS-551: so are the
    // descriptions of the steps it taught to run on a sandbox (Setup's three, Add the Missing Repository). ASS-554: and
    // the worktree flag on the planning, review, risk and documentation steps. ASS-556: and the stack flag.
    const told = new Set(['check-setup-complete', 'create-vm', 'mark-setup-complete', 'add-repository']);
    const strip = engine => JSON.parse(JSON.stringify(engine, function (k, v) { return k === 'run-targets' || k === 'worktree' || k === 'stack' || (k === 'description' && told.has(this.id)) ? undefined : v; }));
    const now = strip(readEngine(join(ROOT, 'engines', name, ENGINE_FILE)));
    assert.equal(JSON.stringify(now), JSON.stringify(strip(sinceConverted(name, JSON.parse(json)))), name);
    compared++;
  }
  assert.ok(compared > 30, `compared ${compared}`);
});

test('AC3: the migration converts each state-engine.json to a workflow.yaml holding the same engine, key order included, and is idempotent', () => {
  const dir = tmp();
  const engine = { 'z-first': 1, steps: [{ id: 'a', sequence: 1, description: 'a: colon, a # hash, "quotes", yes', action: { type: 'none' }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'a' }] }], 'empty-list': [], 'empty-map': {}, nothing: null, multi: 'line one\nline two\n' };
  put(dir, 'one', LEGACY_ENGINE_FILE, JSON.stringify(engine, null, 2));
  put(dir, 'two', LEGACY_ENGINE_FILE, JSON.stringify({ steps: [] }));
  assert.deepEqual(convertEngines(dir, { dryRun: true }).map(r => r.status), ['would-convert', 'would-convert']);
  assert.ok(existsSync(join(dir, 'one', LEGACY_ENGINE_FILE)) && !existsSync(join(dir, 'one', ENGINE_FILE)));
  assert.deepEqual(convertEngines(dir).map(r => r.status), ['converted', 'converted']);
  assert.ok(!existsSync(join(dir, 'one', LEGACY_ENGINE_FILE)));
  const back = readEngine(join(dir, 'one', ENGINE_FILE));
  assert.equal(JSON.stringify(back), JSON.stringify(engine));   // deep-equal, key order included
  assert.match(readFileSync(join(dir, 'one', ENGINE_FILE), 'utf8'), /^z-first: 1\nsteps:\n  - id: a\n/);
  assert.deepEqual(convertEngines(dir).map(r => r.status), ['already', 'already']);   // a second run changes nothing
});

test('AC3: a JSON beside the same workflow.yaml is removed; beside a different one both are left and it is an error', () => {
  const dir = tmp();
  put(dir, 'same', LEGACY_ENGINE_FILE, JSON.stringify({ steps: [] }));
  put(dir, 'same', ENGINE_FILE, 'steps: []\n');
  put(dir, 'differs', LEGACY_ENGINE_FILE, JSON.stringify({ steps: [] }));
  put(dir, 'differs', ENGINE_FILE, '# edited by hand\nsteps: [{ id: a }]\n');
  put(dir, 'broken', LEGACY_ENGINE_FILE, '{ "steps": [');
  const results = Object.fromEntries(convertEngines(dir).map(r => [r.folder.split('/').pop(), r]));
  assert.equal(results.same.status, 'removed-json');
  assert.ok(!existsSync(join(dir, 'same', LEGACY_ENGINE_FILE)));
  assert.equal(results.differs.status, 'error');
  assert.match(results.differs.detail, /differs/);
  assert.ok(existsSync(join(dir, 'differs', LEGACY_ENGINE_FILE)));
  assert.match(readFileSync(join(dir, 'differs', ENGINE_FILE), 'utf8'), /edited by hand/);
  assert.equal(results.broken.status, 'error');
  assert.match(results.broken.detail, /is not JSON/);
  assert.ok(!existsSync(join(dir, 'broken', ENGINE_FILE)));
  assert.equal(convertEngine(join(dir, 'nowhere')).status, 'none');
});

test('AC3: engine:convert-to-yaml converts a project\'s own engines (--project, --all), leaves engines/ alone with --project, and fails on an error', () => {
  const dir = tmp(), engines = join(dir, 'engines'), projects = join(dir, 'projects');
  put(engines, 'shared', LEGACY_ENGINE_FILE, JSON.stringify({ steps: [] }));
  put(join(projects, 'p', 'engines'), 'own', LEGACY_ENGINE_FILE, JSON.stringify({ steps: [{ id: 'x', sequence: 1 }] }));
  mkdirSync(join(projects, 'q'), { recursive: true });   // a project without engines of its own
  const env = { ...process.env, ENGINES_DIR: engines, PROJECTS_DIR: projects };
  const run = (...args) => spawnSync(join(ROOT, 'agent.sh'), ['engine:convert-to-yaml', ...args], { env, encoding: 'utf8' });
  let out = run('--project', 'p');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^converted .*\/projects\/p\/engines\/own\n$/);
  assert.ok(existsSync(join(projects, 'p', 'engines', 'own', ENGINE_FILE)) && existsSync(join(engines, 'shared', LEGACY_ENGINE_FILE)));
  out = run('--all');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /converted .*\/engines\/shared\n/);
  assert.match(out.stdout, /already .*\/projects\/p\/engines\/own\n/);
  assert.equal(run('--project', 'nope').status, 1);
  put(join(projects, 'p', 'engines'), 'broken', LEGACY_ENGINE_FILE, '{');
  out = run('--project', 'p');
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^error .*broken: .*is not JSON/m);
});

test('AC2: control, the dashboard and engine:show read the same engine from a workflow.yaml with comments', () => {
  const dir = tmp();
  put(dir, 'commented', ENGINE_FILE, GOOD);
  const expected = parseEngine(GOOD);
  assert.deepEqual(readEngines(dir).commented, expected);
  const [workflow] = loadWorkflows(dir);
  assert.deepEqual(workflow.steps, expected.steps);
  const shown = spawnSync(join(ROOT, 'agent.sh'), ['engine:show', '-', 'commented'], { env: { ...process.env, ENGINES_DIR: dir }, encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), expected);
  const path = spawnSync(join(ROOT, 'agent.sh'), ['engine:show', '-', 'commented', '--path'], { env: { ...process.env, ENGINES_DIR: dir }, encoding: 'utf8' });
  assert.equal(path.stdout, `${join(dir, 'commented', ENGINE_FILE)}\n`);
  const none = spawnSync(join(ROOT, 'agent.sh'), ['engine:show', '-', 'nope'], { env: { ...process.env, ENGINES_DIR: dir }, encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no state engine nope/);
});

test('AC2: control names a folder holding only a state-engine.json, and does not read it as an engine', () => {
  const dir = tmp(), obsolete = [];
  put(dir, 'old', LEGACY_ENGINE_FILE, JSON.stringify({ steps: [] }));
  assert.deepEqual(readEngines(dir, obsolete), {});
  assert.deepEqual(obsolete, [{ file: join(dir, 'old', LEGACY_ENGINE_FILE), keys: [], legacy: true }]);
});

test('stringifyEngine never folds a long line nor uses aliases', () => {
  const step = { id: 'a', description: 'word '.repeat(60).trim() };
  const text = stringifyEngine({ steps: [step, step] });
  assert.ok(!/[&*]\w/.test(text));
  assert.equal(text.split('\n').filter(l => l.includes('description:')).length, 2);
  assert.ok(text.split('\n').some(l => l.length > 250));
});
