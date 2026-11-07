// Backing off a step that keeps failing: each failure holds the item longer
// before it is tried again — 30s, 1m, 2m … 30m at most — until it moves on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, failed, waiting, cleared } from '../../src/control/backoff.js';

test('backoffDelay doubles from 30 seconds, at most 30 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelay), [30e3, 60e3, 120e3, 240e3, 480e3, 960e3, 1800e3, 1800e3]);
});

test('failed holds an item for the next delay; waiting says whether it is held now; cleared forgets it', () => {
  const memory = { backoff: new Map() };
  assert.equal(waiting(memory, 'k', 0), false);
  assert.deepEqual(failed(memory, 'k', 1000, 'boom'), { failures: 1, until: 31000, error: 'boom' });
  assert.equal(waiting(memory, 'k', 30999), true);
  assert.equal(waiting(memory, 'k', 31000), false);
  assert.deepEqual(failed(memory, 'k', 31000, 'bang'), { failures: 2, until: 91000, error: 'bang' });
  cleared(memory, 'k');
  assert.equal(waiting(memory, 'k', 31000), false);
  assert.deepEqual(failed(memory, 'k', 0), { failures: 1, until: 30000, error: undefined });   // counting starts over
});
