// Scoped pauses (ASS-13): the human pauses all agents or one project's; AI
// pauses only from inside a health check — a run under the harness project's
// check-health trigger, or a ticket's Blocked engine run — its own project
// only, or anything when that health check is the harness project's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './harness-fixture.js';
import { LOADED_MS } from '../support/until.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
// Within LOADED_MS: the agent-cli calls between the stamp and the check are slow on a busy machine (ASS-109).
const near = (iso, ms) => assert.ok(Math.abs(Date.parse(iso) - (Date.now() + ms)) < LOADED_MS, iso);

// The fixture with q as the harness project, and health-check agents: Ripley
// under q's check-health run (its child a self-healing run), Hicks on p's
// Blocked engine run for ABC-3, Vasquez on p's check-health run.
function healthFixture() {
  const f = fixture();
  const file = join(f.dir, 'harness.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'harness-project': 'q' }));
  const assignments = JSON.parse(readFileSync(join(f.dir, 'assignments.json'), 'utf8'));
  const run = (id, project, engine, parent) => ({ id, project, 'state-engine': engine, state: 's', 'start-time': '2026-10-08T00:00:00Z', 'last-heartbeat': '2026-10-08T00:00:00Z', parent, 'is-done': false, 'structured-output': null });
  assignments['transient-state-engines'].push(
    run('c0000000-0000-4000-8000-000000000001', 'q', 'harness-development/check-health-steps', { trigger: 'check-health' }),
    run('c0000000-0000-4000-8000-000000000002', 'q', 'self-healing', { 'transient-state-engine': 'c0000000-0000-4000-8000-000000000001', 'state-engine': 'check-health', state: 'self-heal' }),
    run('c0000000-0000-4000-8000-000000000003', 'p', 'blocked', { 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'example-development', state: 'blocked' }),
    run('c0000000-0000-4000-8000-000000000004', 'p', 'example-development/check-health-steps', { trigger: 'check-health' }),
  );
  const agent = (name, project, runId) => ({ ...assignments.assignments[0], 'agent-name': name, project, 'transient-state-engine': runId, 'assignment-id': `a-${name}`, 'pen-holder': name });
  assignments.assignments.push(agent('Ripley', 'q', 'c0000000-0000-4000-8000-000000000002'), agent('Hicks', 'p', 'c0000000-0000-4000-8000-000000000003'), agent('Vasquez', 'p', 'c0000000-0000-4000-8000-000000000004'));
  writeFileSync(join(f.dir, 'assignments.json'), JSON.stringify(assignments));
  return f;
}

test('the human pauses all agents or one project\'s; each scope and kind is released on its own', async () => {
  const f = healthFixture();
  await f.agent('assignments:pause', 'all', 'human');
  await f.agent('assignments:pause', 'p', 'human');
  let { pauses, status } = f.assignments();
  assert.deepEqual([Object.keys(pauses).toSorted(), status], [['all', 'p'], 'Paused']);
  near(pauses.all.human.since, 0);
  await f.agent('assignments:start', 'all', 'human');
  ({ pauses, status } = f.assignments());
  assert.deepEqual([Object.keys(pauses), status], [['p'], 'Paused']);                       // p's still holds
  await f.agent('assignments:start', 'p', 'human');
  assert.deepEqual([f.assignments().pauses, f.assignments().status], [{}, 'Running']);
  await fails(f.agent('assignments:pause', 'nowhere', 'human'), /no project nowhere/);
  await fails(f.agent('assignments:pause', 'all', 'robot'), /usage/);
});

test('an AI pause from the harness project\'s health check may hold anything: all agents, its own project or another', async () => {
  const f = healthFixture();
  for (const scope of ['all', 'p', 'q']) await f.agent('assignments:pause', scope, 'ai', 'Ripley', 'Rotating the token', '20');
  const { pauses } = f.assignments();
  const ai = pauses.p.ai;
  assert.deepEqual([ai.agent, ai.project, ai.run, ai.reason], ['Ripley', 'q', 'c0000000-0000-4000-8000-000000000001', 'Rotating the token']);   // its health check's run
  near(ai.eta, 20 * 60_000);
  assert.ok(pauses.all.ai && pauses.q.ai);
  await f.agent('assignments:start', 'p', 'ai');
  assert.equal(f.assignments().pauses.p, undefined);
});

test('an AI pause from a product project\'s health check (its Blocked state) may hold only its own project', async () => {
  const f = healthFixture();
  await f.agent('assignments:pause', 'p', 'ai', 'Hicks', 'Dev container down', '15');
  assert.equal(f.assignments().pauses.p.ai.agent, 'Hicks');
  await fails(f.agent('assignments:pause', 'all', 'ai', 'Hicks', 'Dev container down', '15'), /Hicks, on a p health check, may pause only p/);
  await fails(f.agent('assignments:pause', 'q', 'ai', 'Hicks', 'Dev container down', '15'), /may pause only p/);
  // A check-health run of a product project counts too — only the harness's reaches beyond it.
  await fails(f.agent('assignments:pause', 'q', 'ai', 'Vasquez', 'x', '5'), /may pause only p/);
});

test('an AI pause outside a health check is refused: an agent on a ticket step or another run, or no agent at all', async () => {
  const f = healthFixture();
  const before = readFileSync(join(f.dir, 'assignments.json'), 'utf8');
  await fails(f.agent('assignments:pause', 'p', 'ai', 'Daredevil', 'x', '5'), /Daredevil is on no health check/);   // a ticket step's agent
  await fails(f.agent('assignments:pause', 'p', 'ai', 'Leia', 'x', '5'), /Leia is on no health check/);           // a self-healing run not under one
  await fails(f.agent('assignments:pause', 'p', 'ai', 'Nobody', 'x', '5'), /no assignment for Nobody/);
  await fails(f.agent('assignments:pause', 'p', 'ai', 'Ripley', '', '5'), /usage/);
  await fails(f.agent('assignments:pause', 'p', 'ai', 'Ripley', 'x', '0'), /whole number from 1/);
  assert.equal(readFileSync(join(f.dir, 'assignments.json'), 'utf8'), before);              // nothing written
});

test('ticket:set-paused with an agent named holds the AI to the same rule; without one it is the human\'s or a script\'s', async () => {
  const f = healthFixture();
  await fails(f.agent('ticket:set-paused', 'p', 'ABC-3', 'A', 'true', 'Daredevil'), /Daredevil is on no health check/);
  await f.agent('ticket:set-paused', 'p', 'ABC-3', 'A', 'true', 'Hicks');
  assert.equal(f.variation('A')['is-paused'], true);
  await fails(f.agent('ticket:set-paused', 'q', 'Q-1', 'A', 'true', 'Hicks'), /may pause only p/);
  await f.agent('ticket:set-paused', 'q', 'Q-1', 'A', 'true', 'Ripley');                   // the harness's health check reaches q's tickets…
  await f.agent('ticket:set-paused', 'p', 'ABC-3', 'A', 'false');                          // …and anyone may without an agent named
  assert.equal(f.variation('A')['is-paused'], false);
});
