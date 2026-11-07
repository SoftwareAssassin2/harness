// The GitHub adapter: a repository's pull requests (the harness's own), listed
// or looked up, in the merge-request shape (ASS-92).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMergeRequests, fetchMergeRequest } from '../../src/downloader/github.js';

// A pull request as gh --json lists it (the fields the adapter reads).
const pr = (number, state, checks = [], extra = {}) => ({
  number, state, url: `https://github.com/o/r/pull/${number}`, headRefName: `change/ASS-${number}`, title: `ASS-${number}: t`, statusCheckRollup: checks, ...extra,
});
const gh = (prs, calls = []) => ({ calls, run: async (cmd, args) => { calls.push([cmd, ...args]); return JSON.stringify(prs); } });
const FIELDS = 'number,url,state,headRefName,title,statusCheckRollup';

test('fetchMergeRequests lists the newest 100 pull requests, or looks one up by head branch or title, through gh', async () => {
  const fake = gh([pr(4, 'OPEN')]);
  assert.deepEqual(await fetchMergeRequests({ repoUrl: 'https://github.com/o/r' }, fake.run), [
    { key: '#4', 'build-status': 'Pending', url: 'https://github.com/o/r/pull/4', status: 'Open', branch: 'change/ASS-4', title: 'ASS-4: t' },
  ]);
  await fetchMergeRequests({ repoUrl: 'https://github.com/o/r', branch: 'change/ASS-4' }, fake.run);
  await fetchMergeRequests({ repoUrl: 'https://github.com/o/r', search: 'ASS-4' }, fake.run);
  assert.deepEqual(fake.calls, [
    ['gh', 'pr', 'list', '--repo', 'o/r', '--state', 'all', '--limit', '100', '--json', FIELDS],
    ['gh', 'pr', 'list', '--repo', 'o/r', '--state', 'all', '--limit', '100', '--head', 'change/ASS-4', '--json', FIELDS],
    ['gh', 'pr', 'list', '--repo', 'o/r', '--state', 'all', '--limit', '100', '--search', 'ASS-4 in:title', '--json', FIELDS],
  ]);
});

test('fetchMergeRequests maps states and checks: merged Merged; a failed check Failed, one still going Running, all passed Passed, none Pending', async () => {
  const ok = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const fake = gh([
    pr(1, 'MERGED', [{ status: 'COMPLETED', conclusion: 'FAILURE' }]),
    pr(2, 'OPEN', [ok, { status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS', conclusion: '' }]),
    pr(3, 'OPEN', [ok, { __typename: 'StatusContext', state: 'ERROR' }]),
    pr(4, 'OPEN', [ok, { status: 'QUEUED', conclusion: '' }]),
    pr(5, 'OPEN', [ok, { __typename: 'StatusContext', state: 'PENDING' }]),
    pr(6, 'OPEN', [ok, { status: 'COMPLETED', conclusion: 'SKIPPED' }]),
    pr(7, 'CLOSED'),
  ]);
  const list = await fetchMergeRequests({ repoUrl: 'https://github.com/o/r' }, fake.run);
  assert.deepEqual(list.map(m => [m['build-status'], m.status]), [
    ['Merged', 'Merged'], ['Failed', 'Open'], ['Failed', 'Open'], ['Running', 'Open'], ['Running', 'Open'], ['Passed', 'Open'], ['Pending', 'Closed'],
  ]);
});

test('fetchMergeRequests takes an empty list, and fails on anything but a JSON list', async () => {
  assert.deepEqual(await fetchMergeRequests({ repoUrl: 'https://github.com/o/r' }, async () => ''), []);
  await assert.rejects(fetchMergeRequests({ repoUrl: 'https://github.com/o/r' }, async () => 'nope'), /gh/);
  await assert.rejects(fetchMergeRequests({ repoUrl: 'https://github.com/o/r' }, async () => '{}'), /gh/);
});

test('fetchMergeRequest reads one pull request by its url, however old, read-only with gh pr view (ASS-122)', async () => {
  const calls = [], run = async (cmd, args) => { calls.push([cmd, ...args]); return JSON.stringify(pr(22, 'MERGED')); };
  assert.deepEqual(await fetchMergeRequest({ url: 'https://github.com/o/r/pull/22' }, run),
    { key: '#22', 'build-status': 'Merged', url: 'https://github.com/o/r/pull/22', status: 'Merged', branch: 'change/ASS-22', title: 'ASS-22: t' });
  assert.deepEqual(calls, [['gh', 'pr', 'view', '22', '--repo', 'o/r', '--json', FIELDS]]);
  await assert.rejects(fetchMergeRequest({ url: 'https://github.com/o/r' }, run), /not a pull request url/);
  await assert.rejects(fetchMergeRequest({ url: 'https://github.com/o/r/pull/1' }, async () => '[]'), /gh/);
});
