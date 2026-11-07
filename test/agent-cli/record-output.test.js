// ticket:record-output — what a step's run returned, kept on the variation with a timestamp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, STAMP } from './harness-fixture.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));

test('ticket:record-output merges the object into the variation\'s field with the time, keeping what was there; fails on a bad object, field or variation', async () => {
  const f = fixture();
  const sprint = f.sprint();
  sprint.features[0].variations[0]['local-testing'] = { 'number-of-relevant-automated-tests': 3 };
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(sprint));
  await f.agent('ticket:record-output', 'p', 'abc-3', 'A', 'local-testing', '{"is-approved":false,"summary":"criterion 2 failed"}');
  const first = f.variation('A')['local-testing'];
  assert.match(first.timestamp, STAMP);
  assert.deepEqual(first, { 'number-of-relevant-automated-tests': 3, 'is-approved': false, summary: 'criterion 2 failed', timestamp: first.timestamp });
  await f.agent('ticket:record-output', 'p', 'ABC-3', 'A', 'local-testing', '{"is-approved":true,"summary":"all pass"}');
  assert.deepEqual({ ...f.variation('A')['local-testing'], timestamp: 'T' }, { 'number-of-relevant-automated-tests': 3, 'is-approved': true, summary: 'all pass', timestamp: 'T' });
  assert.equal(f.variation('B')['local-testing'], undefined);
  const before = f.snapshot();
  await fails(f.agent('ticket:record-output', 'p', 'ABC-3', 'A', 'local-testing', '[1]'), /JSON object/);
  await fails(f.agent('ticket:record-output', 'p', 'ABC-3', 'A', 'local testing', '{}'), /one word/);
  await fails(f.agent('ticket:record-output', 'p', 'ABC-3', 'Z', 'local-testing', '{}'), /no ABC-3 variation Z/);
  await fails(f.agent('ticket:record-output', 'p', 'ABC-3', 'A'), /usage/);
  assert.equal(f.snapshot(), before);
});

test('ticket:set-ai-feedback records why the variation is where it is — its health — replacing what was there; fails on an empty one or an unknown variation', async () => {
  const f = fixture();
  await f.agent('ticket:set-ai-feedback', 'p', 'abc-3', 'B', 'VM disk limit reached', 'p\'s VMs use 9 GB of its 10 GB VM disk limit.');
  assert.deepEqual([f.variation('B')['ai-feedback-short'], f.variation('B')['ai-feedback-long']], ['VM disk limit reached', 'p\'s VMs use 9 GB of its 10 GB VM disk limit.']);
  assert.equal(f.variation('A')['ai-feedback-short'], undefined);
  const before = f.snapshot();
  await assert.rejects(f.agent('ticket:set-ai-feedback', 'p', 'ABC-3', 'B', ' ', 'why'), /the feedback is empty/);
  await assert.rejects(f.agent('ticket:set-ai-feedback', 'p', 'ABC-3', 'D', 'short', 'why'), /no ABC-3 variation D/);
  assert.equal(f.snapshot(), before);
});

// ASS-107: Blocked keeps every run's outcome — what was found, what was tried, how it ended — for the next stay to learn from.
test('ticket:record-output … append adds the object, with the time, to the variation\'s list in that field, keeping every earlier one', async () => {
  const f = fixture();
  await f.agent('ticket:record-output', 'p', 'ABC-3', 'A', 'blocks', '{"summary":"one"}', 'append');
  await f.agent('ticket:record-output', 'p', 'ABC-3', 'A', 'blocks', '{"summary":"two"}', 'append');
  const blocks = f.variation('A').blocks;
  assert.deepEqual(blocks.map(b => b.summary), ['one', 'two']);
  assert.ok(blocks.every(b => STAMP.test(b.timestamp)));
  await fails(f.agent('ticket:record-output', 'p', 'ABC-3', 'A', 'blocks', '{}', 'prepend'), /usage/);
});
