// until(check, ms) (ASS-211): on a real timeout it throws a clear error
// instead of silently returning the stale check() — a check that comes true
// late (in the gap between the last poll and the post-loop check()) still
// resolves true, not a throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './until.js';

test('until(check, ms) throws on a real timeout instead of silently returning the falsy check', async () => {
  const check = () => false;
  await assert.rejects(until(check, 50), err => {
    assert.match(err.message, /50/);
    assert.match(err.message, /\(\)\s*=>\s*false/);
    return true;
  });
});

test('until(check, ms) still resolves true at once when the check is already true (happy path unaffected)', async () => {
  assert.equal(await until(() => true, 50), true);
});

test('until(check, ms) resolves true, not throws, when the check only turns true in the gap between the last poll and the post-loop check (the ok-late branch)', async () => {
  let first = true;
  const late = () => {
    if (first) { first = false; const t = Date.now() + 60; while (Date.now() < t); return false; }
    return true;
  };
  assert.equal(await until(late, 50), true);
});
