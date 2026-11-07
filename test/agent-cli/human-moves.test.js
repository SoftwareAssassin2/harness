// A move made by a human (ticket:change-state, ticket:human-review,
// ticket:select-variation) carries the ticket system along: the new step's
// paired-ticket-system-status is set as control's own moves set it. And
// ticket:mark-work-done, control's way to stop at a human gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './harness-fixture.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));

// The fixture's execution engine given paired statuses: generate-solution In Progress, local-testing In Testing, done without one.
function paired() {
  const f = fixture();
  const file = join(f.dir, 'engines', 'example-development', 'state-engine.json');
  const engine = JSON.parse(readFileSync(file, 'utf8'));
  engine.steps = engine.steps.map(s => ({ ...s, ...(s.id === 'generate-solution' ? { 'paired-ticket-system-status': 'In Progress' } : s.id === 'local-testing' ? { 'paired-ticket-system-status': 'In Testing' } : {}) }));
  writeFileSync(file, JSON.stringify(engine));
  return f;
}

test('ticket:change-state sets the new step\'s paired status on the ticket, in Jira too, and says so; a step without one, or the same status, leaves it', async () => {
  const f = paired();
  const { stdout, stderr } = await f.agent('ticket:change-state', 'p', 'ABC-3', 'A', 'generate-solution', 'local-testing');
  assert.equal(f.sprint().features[0]['ticket-system-status'], 'In Testing');
  assert.match(stdout, /^ticket:change-state: ABC-3 ticket system status → In Testing$/m);
  assert.match(stderr, /acli jira workitem transition --key ABC-3 --status "In Testing"/);
  const quiet = await f.agent('ticket:change-state', 'p', 'ABC-3', 'A', 'local-testing', 'done');   // no paired status: nothing said, nothing set
  assert.equal(quiet.stdout.trim(), '');
  assert.doesNotMatch(quiet.stderr, /acli/);
  assert.equal(f.sprint().features[0]['ticket-system-status'], 'In Testing');
  const same = await f.agent('ticket:change-state', 'p', 'ABC-3', 'C', 'local-testing', 'local-testing');
  assert.equal(same.stdout.trim(), '');
});

test('ticket:human-review and ticket:select-variation set the paired status when they move, not when they only record', async () => {
  const f = paired();
  const only = await f.agent('ticket:human-review', 'p', 'ABC-3', 'A', 'generate-solution', 'Looks fine', '');
  assert.equal(only.stdout.trim(), '');
  assert.equal(f.sprint().features[0]['ticket-system-status'], 'In Progress');
  const moved = await f.agent('ticket:human-review', 'p', 'ABC-3', 'A', 'generate-solution', 'Approved', 'local-testing');
  assert.match(moved.stdout, /ABC-3 ticket system status → In Testing/);
  assert.equal(f.sprint().features[0]['ticket-system-status'], 'In Testing');
  // C is selected while at local-testing: it moves to done (no paired status), the ticket stays In Testing.
  const chosen = await f.agent('ticket:select-variation', 'p', 'ABC-3', 'C', 'local-testing', 'C', 'done');
  assert.equal(chosen.stdout.trim(), '');
  assert.equal(f.variation('C')['harness-status'].state, 'done');
  assert.equal(f.sprint().features[0]['ticket-system-status'], 'In Testing');
});

test('ticket:mark-work-done sets work-is-done on the latest change, into that state, moving nothing; again is fine; fails elsewhere or without a change in', async () => {
  const f = fixture();
  await f.agent('ticket:mark-work-done', 'p', 'ABC-3', 'A', 'generate-solution');
  const a = f.variation('A');
  assert.equal(a['harness-status'].state, 'generate-solution');
  assert.deepEqual(a['state-changes'].map(c => c['work-is-done']), [false, true]);   // only the latest change is marked
  await f.agent('ticket:mark-work-done', 'p', 'ABC-3', 'A', 'generate-solution');
  assert.deepEqual(f.variation('A')['state-changes'].map(c => c['work-is-done']), [false, true]);
  const before = f.snapshot();
  await fails(f.agent('ticket:mark-work-done', 'p', 'ABC-3', 'A', 'local-testing'), /not at local-testing/);
  await fails(f.agent('ticket:mark-work-done', 'p', 'ABC-3', 'C', 'local-testing'), /no change into local-testing/);
  await fails(f.agent('ticket:mark-work-done', 'p', 'ABC-3', 'A'), /usage/);
  await fails(f.agent('ticket:mark-work-done', 'p', 'ABC-3', 'A', 'generate-solution', '[1]'), /pending move must be a JSON object/);
  assert.equal(f.snapshot(), before);
});

test('ticket:mark-work-done keeps a pending move given on the latest change (ASS-132), replaced when marked again with another', async () => {
  const f = fixture();
  await f.agent('ticket:mark-work-done', 'p', 'ABC-3', 'A', 'generate-solution', '{"from":"generate-solution","to":"local-testing","reason":"exit"}');
  assert.deepEqual(f.variation('A')['state-changes'].at(-1)['pending-move'], { from: 'generate-solution', to: 'local-testing', reason: 'exit' });
  await f.agent('ticket:mark-work-done', 'p', 'ABC-3', 'A', 'generate-solution', '{"from":"generate-solution","to":"blocked","reason":"max-visits"}');
  const a = f.variation('A');
  assert.deepEqual([a['state-changes'].at(-1)['pending-move'].to, a['state-changes'].at(-1)['work-is-done'], a['harness-status'].state], ['blocked', true, 'generate-solution']);
});
