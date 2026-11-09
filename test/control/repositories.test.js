// touchedRepositories (ASS-321): the repositories a variation's planned merge
// requests are in, each once, in plan order — skipping id-less forge entries
// (ticket/sync.sh) that carry no `repository`, explicit null included, so
// repositoryName never sees undefined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { touchedRepositories } from '../../src/control/repositories.js';
import { idless } from '../agent-cli/harness-fixture.js';

const planned = (repository, extra = {}) => ({ id: 1, repository, branch: 'change/ABC-3-1', status: 'Open', key: null, url: null, 'build-status': null, ...extra });

test('ASS-321 AC2: an id-less entry (no repository), placed before the planned one, is skipped; touchedRepositories returns the planned repository alone, no throw', () => {
  const variation = { 'merge-request': [idless(), planned('https://github.com/o/harness')] };
  let result;
  assert.doesNotThrow(() => { result = touchedRepositories(variation); });
  assert.deepEqual(result, ['harness']);
});

test('ASS-321 AC2: a merge-request array holding only id-less entries returns []', () => {
  let result;
  assert.doesNotThrow(() => { result = touchedRepositories({ 'merge-request': [idless()] }); });
  assert.deepEqual(result, []);
});

test('ASS-321 AC2: an entry with an explicit repository: null is skipped too, not just a missing key', () => {
  const variation = { 'merge-request': [idless({ repository: null }), planned('https://github.com/o/harness')] };
  let result;
  assert.doesNotThrow(() => { result = touchedRepositories(variation); });
  assert.deepEqual(result, ['harness']);
});

test('touchedRepositories strips .git and dedups, keeping plan order', () => {
  const variation = { 'merge-request': [planned('https://gitlab.com/g/example-corpus.git', { id: 1 }), planned('https://github.com/o/harness', { id: 2 }), planned('https://github.com/o/harness.git', { id: 3 })] };
  assert.deepEqual(touchedRepositories(variation), ['example-corpus', 'harness']);
});

test('a variation with no merge-request, or undefined, touches none', () => {
  assert.deepEqual(touchedRepositories({}), []);
  assert.deepEqual(touchedRepositories(undefined), []);
});
