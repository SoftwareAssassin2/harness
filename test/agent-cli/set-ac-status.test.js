// ticket:set-ac-status (ASS-241 AC1): one acceptance criterion's dev-status
// or testing-status — Passed, Failed or Incomplete — set in the active sprint
// under its lock, so the sprint screen's dots turn green or red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './harness-fixture.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));

async function withCriteria(count) {
  const f = fixture();
  const file = join(f.dir, 'ac.json');
  writeFileSync(file, JSON.stringify(Array.from({ length: count }, (_, i) => ({ 'criteria-number': i + 1, description: `criterion ${i + 1}` }))));
  await f.agent('ticket:set-acceptance-criteria', 'p', 'ABC-3', 'A', file);
  return f;
}
const statuses = f => f.variation('A')['acceptance-criteria'].map(c => [c['dev-status'], c['testing-status']]);

test('ASS-241 AC1: ticket:set-ac-status sets one criterion\'s dev-status or testing-status to Passed, Failed or Incomplete, the rest left be', async () => {
  const f = await withCriteria(2);
  await f.agent('ticket:set-ac-status', 'p', 'abc-3', 'A', 'dev', '1', 'Passed');
  await f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'A', 'testing', '2', 'Failed');
  assert.deepEqual(statuses(f), [['Passed', 'Incomplete'], ['Incomplete', 'Failed']]);
  await f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'A', 'dev', '1', 'Failed');
  await f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'A', 'testing', '2', 'Incomplete');
  assert.deepEqual(statuses(f), [['Failed', 'Incomplete'], ['Incomplete', 'Incomplete']]);
  assert.equal(f.variation('A')['acceptance-criteria'][0].description, 'criterion 1');
});

test('ASS-241 AC1: ticket:set-ac-status refuses an unknown criterion, kind or value, a missing variation, or the wrong arguments, writing nothing', async () => {
  const f = await withCriteria(2);
  const before = f.snapshot();
  await fails(f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'A', 'dev', '3', 'Passed'), /no criterion 3/);
  await fails(f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'A', 'dev', 'x', 'Passed'), /usage/);
  for (const value of ['Done', 'passed', '']) await fails(f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'A', 'dev', '1', value), /usage/);
  await fails(f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'A', 'qa', '1', 'Passed'), /usage/);
  await fails(f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'Z', 'dev', '1', 'Passed'), /no ABC-3 variation Z/);
  await fails(f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'B', 'dev', '1', 'Passed'), /no criterion 1/);   // B has no criteria
  await fails(f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'A', 'dev', '1'), /usage/);
  assert.equal(f.snapshot(), before);
});

test('ASS-241 AC1: ticket:set-ac-status calls made at once each land: the sprint\'s lock, not last-writer-wins', async () => {
  const f = await withCriteria(6);
  await Promise.all([1, 2, 3, 4, 5, 6].flatMap(n => [
    f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'A', 'dev', String(n), 'Passed'),
    f.agent('ticket:set-ac-status', 'p', 'ABC-3', 'A', 'testing', String(n), 'Failed'),
  ]));
  assert.deepEqual(statuses(f), Array(6).fill(['Passed', 'Failed']));
});
