// transient-state-engine:* — the engine runs control starts for triggers and
// for a ticket step's own state engine, kept in assignments.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, run, AGENT, SELF_HEALING_ENGINE, TEST_ENGINE, STAMP, UUID } from './harness-fixture.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
const engines = f => f.assignments()['transient-state-engines'];

test('transient-state-engine:create appends a record, its parent as given, and prints it; an engine may be a *-steps list inside another', async () => {
  const f = fixture();
  const { stdout } = await f.agent('transient-state-engine:create', 'p', 'self-healing', 'analyze', '{"trigger":"self-healing"}');
  const record = JSON.parse(stdout);
  assert.match(record.id, UUID);
  assert.match(record['start-time'], STAMP);
  assert.deepEqual(record, { id: record.id, project: 'p', 'state-engine': 'self-healing', state: 'analyze', 'start-time': record['start-time'], 'last-heartbeat': record['start-time'], parent: { trigger: 'self-healing' }, 'is-done': false, 'structured-output': null });
  assert.deepEqual(engines(f)[2], record);
  const { stdout: out } = await f.agent('transient-state-engine:create', 'p', 'example-development/check-health-steps', 'check-health', '{"trigger":"check-health"}');
  assert.equal(JSON.parse(out)['state-engine'], 'example-development/check-health-steps');
  assert.equal(engines(f).length, 4);
});

test('transient-state-engine:create fails, writing nothing, on an unknown project, engine, list or state, or a parent that is not an object', async () => {
  const f = fixture();
  const before = f.snapshot();
  await fails(f.agent('transient-state-engine:create', 'nope', 'self-healing', 'analyze', '{}'), /no project nope/);
  await fails(f.agent('transient-state-engine:create', 'p', 'nope', 'analyze', '{}'), /no state engine nope/);
  await fails(f.agent('transient-state-engine:create', 'p', 'example-development/nope-steps', 'analyze', '{}'), /no state engine example-development\/nope-steps/);
  await fails(f.agent('transient-state-engine:create', 'p', 'self-healing', 'nope', '{}'), /self-healing has no step nope/);
  await fails(f.agent('transient-state-engine:create', 'p', 'self-healing', 'analyze', '[1]'), /parent must be a JSON object/);
  await fails(f.agent('transient-state-engine:create', 'p', 'self-healing', 'analyze'), /usage/);
  await fails(f.agent('transient-state-engine:create', '../p', 'self-healing', 'analyze', '{}'), /invalid project/);
  assert.equal(f.snapshot(), before);
});

test('transient-state-engine:change-state moves the engine, keeps its output, and is done at a step that is; a ticket step\'s engine records the move on the variation too', async () => {
  const f = fixture();
  await f.agent('transient-state-engine:change-state', SELF_HEALING_ENGINE, 'analyze', 'apply-fix', '{"ticket":"ABC-9"}');
  let [sh] = engines(f);
  assert.deepEqual([sh.state, sh['is-done'], sh['structured-output']], ['apply-fix', false, { ticket: 'ABC-9' }]);
  assert.match(sh['last-heartbeat'], STAMP);
  assert.notEqual(sh['last-heartbeat'], '2026-10-08T00:00:00Z');
  await f.agent('transient-state-engine:change-state', SELF_HEALING_ENGINE, 'apply-fix', 'done');
  [sh] = engines(f);
  assert.deepEqual([sh.state, sh['is-done'], sh['structured-output']], ['done', true, { ticket: 'ABC-9' }]);   // the output kept when none is given
  assert.deepEqual(f.variation('B')['state-changes'].length, 1);                                               // no ticket behind it: nothing there
  assert.deepEqual(sh['state-changes'].map(c => [c['from-state'], c['to-state']]), [['analyze', 'apply-fix'], ['apply-fix', 'done']]);   // the run's own history, its visits counted over
  assert.match(sh['state-changes'][1].timestamp, STAMP);

  await f.agent('transient-state-engine:change-state', TEST_ENGINE, 'test', 'take-screenshots');
  assert.equal(engines(f)[1].state, 'take-screenshots');
  const b = f.variation('B');
  assert.deepEqual(b['harness-status'], { state: 'local-testing', 'state-engine': 'example-development', 'sub-status': { state: 'take-screenshots', 'state-engine': 'test' } });
  assert.equal(b['state-changes'].length, 2);
  assert.deepEqual({ ...b['state-changes'][1], timestamp: 'T' }, { 'state-engine': 'example-development', 'from-state': 'local-testing', 'to-state': 'local-testing', 'sub-state-change': { 'state-engine': 'test', 'from-state': 'test', 'to-state': 'take-screenshots' }, timestamp: 'T', 'agent-dispatch-log': [], 'work-is-done': false });
  assert.equal(b['state-changes'][0]['work-is-done'], true);
});

test('transient-state-engine:change-state stopped after the variation\'s move, before the run\'s, moves the run alone when run again, the move recorded once (ASS-178)', async () => {
  const f = fixture();
  // the variation's half: what the stopped command had written
  await run(AGENT, ['ticket:change-sub-state', 'p', 'ABC-3', 'B', 'test', 'test', 'take-screenshots'], { env: { ...f.env, MOVED_BY_RUN: '1' } });
  await f.agent('transient-state-engine:change-state', TEST_ENGINE, 'test', 'take-screenshots');
  assert.equal(engines(f)[1].state, 'take-screenshots');
  assert.equal(f.variation('B')['harness-status']['sub-status'].state, 'take-screenshots');
  assert.equal(f.variation('B')['state-changes'].length, 2);
});

test('transient-state-engine:change-state fails, writing nothing, unless the engine is at the from-state, the to-state is a step, and the output is JSON', async () => {
  const f = fixture();
  const before = f.snapshot();
  await fails(f.agent('transient-state-engine:change-state', SELF_HEALING_ENGINE, 'apply-fix', 'done'), /is not at apply-fix/);
  await fails(f.agent('transient-state-engine:change-state', SELF_HEALING_ENGINE, 'analyze', 'nope'), /self-healing has no step nope/);
  await fails(f.agent('transient-state-engine:change-state', SELF_HEALING_ENGINE, 'analyze', 'done', 'not json'), /structured output is not JSON/);
  await fails(f.agent('transient-state-engine:change-state', 'nope', 'analyze', 'done'), /no transient state engine nope/);
  await fails(f.agent('transient-state-engine:change-state', SELF_HEALING_ENGINE, 'analyze'), /usage/);
  assert.equal(f.snapshot(), before);
});

test('transient-state-engine:remove drops the record and prints it', async () => {
  const f = fixture();
  const { stdout } = await f.agent('transient-state-engine:remove', SELF_HEALING_ENGINE);
  assert.equal(JSON.parse(stdout).id, SELF_HEALING_ENGINE);
  assert.deepEqual(engines(f).map(e => e.id), [TEST_ENGINE]);
  const before = f.snapshot();
  await fails(f.agent('transient-state-engine:remove', SELF_HEALING_ENGINE), new RegExp(`no transient state engine ${SELF_HEALING_ENGINE}`));
  await fails(f.agent('transient-state-engine:remove'), /usage/);
  assert.equal(f.snapshot(), before);
});

test('transient-state-engine:create counts the run into the active sprint\'s connected-flows: one { name, run-count } per engine the project\'s engine reaches, 0 until it runs (ASS-7)', async () => {
  const f = fixture();
  const flows = () => Object.fromEntries((f.sprint()['connected-flows'] ?? []).map(e => [e.name, e['run-count']]));
  // The fixture's engine reaches test (local-testing) and check-health (its check-health-steps).
  await f.agent('transient-state-engine:create', 'p', 'test', 'test', JSON.stringify({ trigger: 'x' }));
  assert.equal(flows().test, 1);
  assert.equal(flows()['check-health'], 0);
  await f.agent('transient-state-engine:create', 'p', 'test', 'test', JSON.stringify({ trigger: 'x' }));
  assert.equal(flows().test, 2);
  await f.agent('transient-state-engine:create', 'p', 'example-development/check-health-steps', 'check-health', JSON.stringify({ trigger: 'check-health' }));
  assert.equal(flows()['check-health'], 0);                                                   // a *-steps list's own run is not an engine's: its step's child is
});

test('transient-state-engine:change-state of a run inside a ticket step\'s run records the move on the variation at the run\'s own depth (ASS-67); a trigger\'s runs, at any depth, record nothing there', async () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'engines', 'inner'));
  writeFileSync(join(f.dir, 'engines', 'inner', 'state-engine.json'), JSON.stringify({ steps: [{ id: 'inspect', sequence: 1, action: { type: 'prompt', prompt: 'test' } }, { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } }] }));
  const run = (id, parent) => ({ id, project: 'p', 'state-engine': 'inner', state: 'inspect', parent, 'is-done': false, 'structured-output': null });
  const file = join(f.dir, 'assignments.json');
  const data = f.assignments();
  data['transient-state-engines'].push(
    run('inner-1', { 'transient-state-engine': TEST_ENGINE, 'state-engine': 'test', state: 'test' }),
    { id: 'trigger-1', project: 'p', 'state-engine': 'example-development/check-health-steps', state: 'check-health', parent: { trigger: 'check-ticket-health', 'work-item': 'ABC-3', variation: 'B' }, 'is-done': false },
    run('inner-2', { 'transient-state-engine': 'trigger-1', 'state-engine': 'example-development/check-health-steps', state: 'check-health' }),
  );
  writeFileSync(file, JSON.stringify(data));
  await f.agent('ticket:change-sub-state', 'p', 'ABC-3', 'B', 'inner', '-', 'inspect', 'test');   // control enters it as it starts the run
  await f.agent('transient-state-engine:change-state', 'inner-1', 'inspect', 'done');
  const b = f.variation('B');
  assert.deepEqual(b['harness-status']['sub-status'], { state: 'test', 'state-engine': 'test', 'sub-status': { state: 'done', 'state-engine': 'inner' } });
  assert.deepEqual(b['state-changes'].at(-1)['sub-state-change'], { 'state-engine': 'test', 'from-state': 'test', 'to-state': 'test', 'sub-state-change': { 'state-engine': 'inner', 'from-state': 'inspect', 'to-state': 'done' } });
  const changes = b['state-changes'].length;
  await f.agent('transient-state-engine:change-state', 'inner-2', 'inspect', 'done');
  assert.equal(f.variation('B')['state-changes'].length, changes);
});

// ASS-124: a run control starts part way into a sub-engine may start from what the ticket brought (ticket:change-state's output).
test('transient-state-engine:create with an output starts the run with it as its structured-output; refused unless an object', async () => {
  const f = fixture();
  const { stdout } = await f.agent('transient-state-engine:create', 'p', 'self-healing', 'apply-fix', '{"trigger":"self-healing"}', '{"summary":"S"}');
  assert.deepEqual(JSON.parse(stdout)['structured-output'], { summary: 'S' });
  const before = f.snapshot();
  await fails(f.agent('transient-state-engine:create', 'p', 'self-healing', 'analyze', '{}', '"S"'), /output must be a JSON object/);
  assert.equal(f.snapshot(), before);
});
