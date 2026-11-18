// ticket:record-output — what a step's run returned, kept on the variation with a timestamp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, STAMP, hs } from './harness-fixture.js';

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

// ASS-510: a notice from outside a variation's own flow (the stray-branch set-aside) is kept beside its feedback, never replacing it.
const NOTICE = ['ABC-9 A\'s step end', 'Stray commits set aside: example-corpus change/ABC-3-1', 'Commits of a stray local branch were set aside: example-corpus change/ABC-3-1 (2 commit(s), kept under refs/harness/stray/x)'];
const BLOCK = ['Reviewer thread open on example-api !12', 'Operator: post the timings on example-api !12 so the reviewer resolves the thread, then resume'];
const at = async (f, state) => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const sprint = f.sprint();
  sprint.features[0].variations[0]['harness-status'] = hs(state);
  writeFileSync(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(sprint));
};
const feedback = v => [v['ai-feedback-short'], v['ai-feedback-long']];

for (const state of ['blocked-for-human', 'blocked']) {
  test(`ASS-510 AC1: at ${state}, ticket:add-ai-notice keeps the block's feedback unchanged and records the notice beside it, with time and source`, async () => {
    const f = fixture();
    await at(f, state);
    await f.agent('ticket:set-ai-feedback', 'p', 'ABC-3', 'A', ...BLOCK);
    const b = f.variation('B');
    await f.agent('ticket:add-ai-notice', 'p', 'ABC-3', 'A', ...NOTICE);
    const a = f.variation('A');
    assert.deepEqual(feedback(a), BLOCK);
    assert.equal(a['ai-notices'].length, 1);
    assert.match(a['ai-notices'][0].timestamp, STAMP);
    assert.deepEqual({ ...a['ai-notices'][0], timestamp: 'T' }, { timestamp: 'T', source: NOTICE[0], short: NOTICE[1], long: NOTICE[2] });
    assert.deepEqual(f.variation('B'), b);
  });
}

test('ASS-510 AC1: a second notice is appended after the first, in order; the feedback still unchanged; the key is case-insensitive', async () => {
  const f = fixture();
  await at(f, 'blocked-for-human');
  await f.agent('ticket:set-ai-feedback', 'p', 'ABC-3', 'A', ...BLOCK);
  await f.agent('ticket:add-ai-notice', 'p', 'abc-3', 'A', ...NOTICE);
  await f.agent('ticket:add-ai-notice', 'p', 'ABC-3', 'A', 'ABC-7 A\'s step start', 'second', 'the second notice');
  const a = f.variation('A');
  assert.deepEqual(feedback(a), BLOCK);
  assert.deepEqual(a['ai-notices'].map(n => n.short), [NOTICE[1], 'second']);
});

test('ASS-510 AC1: a notice never creates feedback where there was none', async () => {
  const f = fixture();
  await at(f, 'blocked-for-human');
  await f.agent('ticket:add-ai-notice', 'p', 'ABC-3', 'A', ...NOTICE);
  const a = f.variation('A');
  assert.deepEqual(feedback(a), [undefined, undefined]);
  assert.equal(a['ai-notices'].length, 1);
});

test('ASS-510 AC1: ticket:add-ai-notice fails, writing nothing, on missing arguments, an empty notice or an unknown or deleted variation', async () => {
  const f = fixture();
  const before = f.snapshot();
  await fails(f.agent('ticket:add-ai-notice', 'p', 'ABC-3', 'A', NOTICE[0], NOTICE[1]), /usage/);
  await assert.rejects(f.agent('ticket:add-ai-notice', 'p', 'ABC-3', 'A', NOTICE[0], ' ', 'why'));
  await fails(f.agent('ticket:add-ai-notice', 'p', 'ABC-3', 'Z', ...NOTICE), /no ABC-3 variation Z/);
  await assert.rejects(f.agent('ticket:add-ai-notice', 'p', 'ABC-3', 'D', ...NOTICE));
  assert.equal(f.snapshot(), before);
});

test('ASS-510 AC1: a move clears the notices with the feedback', async () => {
  const f = fixture();
  await f.agent('ticket:set-ai-feedback', 'p', 'ABC-3', 'A', ...BLOCK);
  await f.agent('ticket:add-ai-notice', 'p', 'ABC-3', 'A', ...NOTICE);
  await f.agent('ticket:change-state', 'p', 'ABC-3', 'A', 'generate-solution', 'local-testing');
  const a = f.variation('A');
  assert.equal(a['ai-feedback-short'], null);
  assert.ok(!a['ai-notices']?.length, JSON.stringify(a['ai-notices']));
});

// AC3's choice: one rule — a notice never overwrites feedback, at any state (no state test in the write path).
test('ASS-510 AC3: outside Blocked (generate-solution), a notice still keeps the feedback and is recorded beside it', async () => {
  const f = fixture();
  assert.equal(f.variation('A')['harness-status'].state, 'generate-solution');
  await f.agent('ticket:set-ai-feedback', 'p', 'ABC-3', 'A', ...BLOCK);
  await f.agent('ticket:add-ai-notice', 'p', 'ABC-3', 'A', ...NOTICE);
  const a = f.variation('A');
  assert.deepEqual(feedback(a), BLOCK);
  assert.deepEqual(a['ai-notices'].map(n => n.source), [NOTICE[0]]);
});
