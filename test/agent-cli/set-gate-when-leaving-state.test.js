// ticket:set-gate-when-leaving-state — sets the states a ticket variation is
// gated on leaving, in the active sprint's sprint.json.
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

// A projects/ folder whose project p, on state engine e (steps a, b, c; c
// runs engine sub, steps x and y), has sprint 10 active, with a feature in two
// variations. Engine other is not reached from e.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'gw-'));
  mkdirSync(join(dir, 'engines', 'e'), { recursive: true });
  writeFileSync(join(dir, 'engines', 'e', 'state-engine.json'), JSON.stringify({ steps: [{ id: 'a', sequence: 1 }, { id: 'b', sequence: 2 }, { id: 'c', sequence: 3, action: { type: 'state-engine', engine: 'sub' } }] }));
  for (const name of ['sub', 'other']) {
    mkdirSync(join(dir, 'engines', name));
    writeFileSync(join(dir, 'engines', name, 'state-engine.json'), JSON.stringify({ steps: [{ id: 'x', sequence: 1 }, { id: 'y', sequence: 2 }] }));
  }
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P', 'execution-state-engine': 'e' }));
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10,
    features: [{ key: 'ABC-3', variations: [{ name: 'A', 'harness-status': hs('a'), 'gate-when-leaving-state': ['e/a'] }, { name: 'B', 'harness-status': hs('b') }] }],
  }, null, 4));
  return dir;
}
const sprintFile = dir => join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
const set = (dir, ...args) => run(AGENT, ['ticket:set-gate-when-leaving-state', ...args], { env: { ...process.env, PROJECTS_DIR: dir, ENGINES_DIR: join(dir, 'engines') } });
const gates = dir => JSON.parse(readFileSync(sprintFile(dir), 'utf8')).features[0].variations.map(v => v['gate-when-leaving-state']);

test('ticket:set-gate-when-leaving-state sets the variation\'s states, each <engine>/<step> at any level, whatever state it is in; none clears them', async () => {
  const dir = projects();
  await set(dir, 'p', 'abc-3', 'B', 'e/c', 'sub/y', 'e/a');
  assert.deepEqual(gates(dir), [['e/a'], ['e/c', 'sub/y', 'e/a']]);
  await set(dir, 'p', 'ABC-3', 'A');
  assert.deepEqual(gates(dir), [[], ['e/c', 'sub/y', 'e/a']]);
});

test('ticket:set-gate-when-leaving-state fails, writing nothing, on a state not named <engine>/<step> of its engine or one it reaches, or an unknown ticket or variation', async () => {
  const dir = projects();
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(set(dir, 'p', 'ABC-3', 'A', 'e/b', 'e/zzz'), /no state e\/zzz/);
  await assert.rejects(set(dir, 'p', 'ABC-3', 'A', 'b'), /no state b/);                // a bare step id
  await assert.rejects(set(dir, 'p', 'ABC-3', 'A', 'other/x'), /no state other\/x/);    // an engine e does not reach
  await assert.rejects(set(dir, 'p', 'ABC-3', 'A', 'sub/a'), /no state sub\/a/);
  await assert.rejects(set(dir, 'p', 'ABC-9', 'A', 'e/b'), /no ABC-9/);
  await assert.rejects(set(dir, 'p', 'ABC-3', 'Z', 'e/b'), /no ABC-3 variation Z/);
  await assert.rejects(set(dir, 'p', 'ABC-3'), /usage/);
  await assert.rejects(set(dir, '../p', 'ABC-3', 'A'), /invalid project/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});
