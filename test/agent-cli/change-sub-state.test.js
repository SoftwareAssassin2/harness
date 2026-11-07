// ticket:change-sub-state — a move within a ticket step's own state engine,
// recorded on the variation as a change within its state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fixture, run, STAMP, TEST_ENGINE } from './harness-fixture.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
const subChange = (from, to) => ({ 'state-engine': 'example-development', 'from-state': 'local-testing', 'to-state': 'local-testing', 'sub-state-change': { 'state-engine': 'test', 'from-state': from, 'to-state': to }, 'agent-dispatch-log': [], 'work-is-done': false });

test('ticket:change-sub-state sets the sub-status and appends a change within the state, the one before it done', async () => {
  const f = fixture();
  await f.agent('ticket:change-sub-state', 'p', 'abc-3', 'B', 'test', 'test', 'take-screenshots');
  const b = f.variation('B');
  assert.deepEqual(b['harness-status']['sub-status'], { state: 'take-screenshots', 'state-engine': 'test' });
  assert.deepEqual(b['harness-status'].state, 'local-testing');
  assert.equal(b['state-changes'].length, 2);
  assert.match(b['state-changes'][1].timestamp, STAMP);
  assert.deepEqual({ ...b['state-changes'][1], timestamp: undefined }, { ...subChange('test', 'take-screenshots'), timestamp: undefined });
  assert.equal(b['state-changes'][0]['work-is-done'], true);
  // Entering a sub-engine (from -): no sub-status needed, the change's from-state null; a variation without a history starts one.
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'C', 'test', '-', 'test');
  const c = f.variation('C');
  assert.deepEqual(c['harness-status'], { state: 'local-testing', 'state-engine': 'example-development', 'sub-status': { state: 'test', 'state-engine': 'test' } });
  assert.deepEqual({ ...c['state-changes'][0], timestamp: undefined }, { ...subChange(null, 'test'), timestamp: undefined });
});

// ASS-161: a manual move of a ticket inside its group step is its run's move, so control (which drives the run) sees it.
const testRun = f => f.assignments()['transient-state-engines'].find(r => r.id === TEST_ENGINE);

test('ticket:change-sub-state with a live run of the sub-engine at that level moves the run too (transient-state-engine:change-state), the ticket\'s change recorded once', async () => {
  const f = fixture();
  // B is at local-testing › test, its test run (TEST_ENGINE) at test.
  await f.agent('ticket:change-sub-state', 'p', 'abc-3', 'B', 'test', 'test', 'take-screenshots');
  const r = testRun(f);
  assert.equal(r.state, 'take-screenshots');
  assert.deepEqual(r['state-changes'].map(c => [c['from-state'], c['to-state']]), [['test', 'take-screenshots']]);
  const b = f.variation('B');
  assert.deepEqual(b['harness-status']['sub-status'], { state: 'take-screenshots', 'state-engine': 'test' });
  assert.equal(b['state-changes'].length, 2);
});

test('ticket:change-sub-state without a run of the sub-engine at that level moves the ticket alone', async () => {
  const f = fixture();
  const runs = JSON.stringify(f.assignments()['transient-state-engines']);
  // B's level beneath test (the inner engine) has no run; C's test level has none (TEST_ENGINE is B's).
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'inner', '-', 'inspect', 'test');
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'inner', 'inspect', 'done', 'test');
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'C', 'test', '-', 'test');
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'C', 'test', 'test', 'take-screenshots');
  assert.equal(JSON.stringify(f.assignments()['transient-state-engines']), runs);
  assert.deepEqual(f.variation('C')['harness-status']['sub-status'], { state: 'take-screenshots', 'state-engine': 'test' });
});

test('ticket:change-sub-state refuses, writing nothing, where the ticket and its run already disagree — but may move the ticket to where the run is', async () => {
  const f = fixture();
  const data = f.assignments();
  data['transient-state-engines'].find(r => r.id === TEST_ENGINE).state = 'take-screenshots';   // the run moved on, the ticket left at test
  writeFileSync(join(f.dir, 'assignments.json'), JSON.stringify(data));
  const before = f.snapshot();
  await fails(f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'test', 'test', 'done'), /ABC-3.B is at test but its test run [0-9a-f-]+ is at take-screenshots/);
  await fails(f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'test', 'take-screenshots', 'done'), /ABC-3.B is at test but its test run [0-9a-f-]+ is at take-screenshots/);
  assert.equal(f.snapshot(), before);
  // Moving the ticket to the run's step closes the gap: the ticket alone moves.
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'test', 'test', 'take-screenshots');
  assert.deepEqual(f.variation('B')['harness-status']['sub-status'], { state: 'take-screenshots', 'state-engine': 'test' });
  assert.equal(testRun(f)['state-changes'], undefined);
});

test('ticket:change-sub-state fails, writing nothing, unless the variation is at the sub-state it moves from', async () => {
  const f = fixture();
  const before = f.snapshot();
  await fails(f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'test', 'take-screenshots', 'done'), /ABC-3.B is not at sub-state take-screenshots/);
  await fails(f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'C', 'test', 'test', 'done'), /ABC-3.C is not at sub-state test/);
  await fails(f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'Z', 'test', '-', 'test'), /no ABC-3 variation Z/);
  await fails(f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'D', 'test', '-', 'test'), /no ABC-3 variation D/);     // deleted
  await fails(f.agent('ticket:change-sub-state', 'p', 'ABC-9', 'A', 'test', '-', 'test'), /no ABC-9/);
  await fails(f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'test', 'test'), /usage/);
  assert.equal(f.snapshot(), before);
});

test('ticket:change-sub-state beneath a path of sub-states (ASS-67): the level under them changes, nested in the change, and any level deeper is dropped', async () => {
  const f = fixture();
  // B is at local-testing › test (the test engine); its test step's own engine (inner) entered, then moved on.
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'inner', '-', 'inspect', 'test');
  let b = f.variation('B');
  assert.deepEqual(b['harness-status']['sub-status'], { state: 'test', 'state-engine': 'test', 'sub-status': { state: 'inspect', 'state-engine': 'inner' } });
  assert.deepEqual({ ...b['state-changes'][1], timestamp: undefined }, { ...subChange('test', 'test'), timestamp: undefined,
    'sub-state-change': { 'state-engine': 'test', 'from-state': 'test', 'to-state': 'test', 'sub-state-change': { 'state-engine': 'inner', 'from-state': null, 'to-state': 'inspect' } } });
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'inner', 'inspect', 'done', 'test');
  b = f.variation('B');
  assert.deepEqual(b['harness-status']['sub-status']['sub-status'], { state: 'done', 'state-engine': 'inner' });
  assert.equal(b['state-changes'][1]['work-is-done'], true);
  // A move at the first level leaves the level beneath behind.
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'test', 'test', 'take-screenshots');
  assert.deepEqual(f.variation('B')['harness-status']['sub-status'], { state: 'take-screenshots', 'state-engine': 'test' });
  // Not under the path given, or not at the from-state beneath it: nothing written.
  const before = f.snapshot();
  await fails(f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'inner', '-', 'inspect', 'test'), /ABC-3.B is not at sub-state test/);
  await fails(f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'inner', 'inspect', 'done', 'take-screenshots'), /ABC-3.B is not at sub-state inspect/);
  assert.equal(f.snapshot(), before);
});

test('variation_status (sprint.bash) prints one "<engine>\\t<state>" line per level of a variation\'s status, top first', async () => {
  const f = fixture();
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'inner', '-', 'inspect', 'test');
  const sprint = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'sprint.bash');
  const status = name => run('bash', ['-c', `source "${sprint}" && variation_status test p abc-3 ${name}`], { env: f.env }).then(r => r.stdout);
  assert.equal(await status('B'), 'example-development\tlocal-testing\ntest\ttest\ninner\tinspect\n');
  assert.equal(await status('A'), 'example-development\tgenerate-solution\n');
  await assert.rejects(status('Z'), e => /no ABC-3 variation Z/i.test(e.stderr));
});
