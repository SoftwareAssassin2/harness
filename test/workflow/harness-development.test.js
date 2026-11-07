// The harness's own development engine (ASS-8): example's flow up to the
// variation choice, then it merges its own pull request and restarts the
// harness onto it — no team review loop — paired with the four off-board statuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { working, inOrder, engineDir } from '../support/engine-walk.js';

const read = path => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const harness = read('engines/harness-development/state-engine.json');
const example = JSON.parse(readFileSync(join(engineDir('example-development'), 'state-engine.json'), 'utf8'));   // the example project's own (ASS-277)
const step = id => harness.steps.find(s => s.id === id);
const REVIEW_LOOP = ['take-out-of-draft-mode', 'team-code-review', 'address-merge-request-feedback', 'ensure-auto-merge', 'qa-testing'];
const HEALTH = ['check-health-steps', 'check-health-interval-seconds', 'check-ticket-health-steps', 'check-ticket-health-sample-every'];
const JOIN_SPRINT = ['ready-tickets-join-sprint-at'];
const TAIL = ['merge-pull-request', 'update-workspace', 'request-restart', 'await-restart', 'done'];

// ASS-258: the two compared by what the steps they share do (working: their wording and order aside), so either may be reworded or gain a step.
test('harness-development is example\'s flow up to the variation choice, with no team review loop', () => {
  for (const theirs of example.steps) {
    const ours = step(theirs.id);
    if (REVIEW_LOOP.includes(theirs.id)) { assert.equal(ours, undefined, theirs.id); continue; }
    if (!ours || theirs.id === 'variation-selection') continue;   // the variation choice: on to the harness's own merge
    // Paired with the harness's own four off-board statuses (the last test here), not example's Jira ones.
    const { 'paired-ticket-system-status': _, ...works } = working(ours), { 'paired-ticket-system-status': __, ...reference } = working(theirs);
    assert.deepEqual(works, reference, theirs.id);
  }
  assert.ok(inOrder(harness.steps.map(s => s.id), ['committed', 'enrich-ac', 'review-plan', 'generate-solution', 'code-review', 'local-testing', 'risk-assessment', 'variation-selection', ...TAIL]));
  assert.deepEqual(Object.keys(harness).filter(k => !HEALTH.includes(k) && !JOIN_SPRINT.includes(k)).toSorted(), Object.keys(example).toSorted());
});

test('the health checks are the harness\'s alone: check-health and check-ticket-health are in harness-development, not example-development (ASS-11)', () => {
  for (const key of HEALTH) {
    assert.ok(key in harness, key);
    assert.ok(!(key in example), key);
  }
  for (const key of ['check-variation-appeal-steps', 'check-variation-appeal-interval-seconds', 'gap-resolution-steps']) assert.ok(key in example && key in harness, key);
});

test('ready-tickets-join-sprint-at is the harness\'s alone: in harness-development, not in example-development (ASS-44)', () => {
  for (const key of JOIN_SPRINT) {
    assert.ok(key in harness, key);
    assert.ok(!(key in example), key);
  }
});

test('after the variation choice it merges its own pull request, brings the checkout up to date and restarts the harness onto it; any failure blocks', () => {
  assert.ok(step('variation-selection')['exit-events'].every(e => e['move-to-state'] === 'merge-pull-request'));
  const next = id => step(id)['exit-events'].find(e => JSON.stringify(e.condition) === '{"exit-code":0}')['move-to-state'];
  assert.deepEqual([next('merge-pull-request'), next('update-workspace'), next('request-restart'), next('await-restart')], TAIL.slice(1));
  assert.equal(step('merge-pull-request').action.command, './agent.sh merge-request:merge {project} {ticket} {variation}');
  assert.equal(step('update-workspace').action.command, './agent.sh code:update-workspace {project}');
  assert.equal(step('request-restart').action.command, './agent.sh harness:request-restart {ticket}');
  assert.deepEqual([step('await-restart').action.command, step('await-restart').action.mode], ['./agent.sh harness:restarted {ticket}', 'timer']);
  for (const id of ['merge-pull-request', 'update-workspace', 'request-restart'])
    assert.equal(step(id)['exit-events'].find(e => e.condition.not)['move-to-state'], 'blocked', id);
});

test('every step pairs with one of the four off-board statuses: backlog, committed and done their own, the rest In Progress', () => {
  const paired = Object.fromEntries(harness.steps.map(s => [s.id, s['paired-ticket-system-status']]));
  assert.deepEqual([paired.backlog, paired.committed, paired.done], ['Backlog', 'Committed', 'Done']);
  for (const [id, status] of Object.entries(paired)) if (!['backlog', 'committed', 'done'].includes(id)) assert.equal(status, 'In Progress', id);
});
