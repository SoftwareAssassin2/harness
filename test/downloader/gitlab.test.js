// The GitLab adapter: a repository's merge requests, listed or looked up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMergeRequests, fetchMergeRequest, repoPath } from '../../src/downloader/gitlab.js';

// A merge request as glab -F json lists it (the fields the adapter reads).
const mr = (iid, title, source_branch, state, pipeline) => ({
  iid, title, source_branch, state, web_url: `https://gitlab.com/g/p/-/merge_requests/${iid}`,
  pipeline: pipeline === undefined ? null : { status: pipeline }, head_pipeline: pipeline === undefined ? null : { status: pipeline },
});
const glab = (mrs, calls = []) => ({ calls, run: async (cmd, args) => { calls.push([cmd, ...args]); return JSON.stringify(mrs); } });

test('repoPath is the url\'s path, nested groups included', () => {
  assert.equal(repoPath('https://gitlab.com/example-group/example-project'), 'example-group/example-project');
  assert.equal(repoPath('https://gitlab.com/a/b/c.git/'), 'a/b/c');
});

test('fetchMergeRequests lists the repository\'s newest 100 merge requests, every one, with its source branch and title', async () => {
  const fake = glab([mr(10, 'EX-1: first', 'change/ex-1', 'opened', 'success'), mr(14, 'Unrelated', 'main-fix', 'closed', 'success')]);
  const list = await fetchMergeRequests({ repoUrl: 'https://gitlab.com/g/p' }, fake.run);
  assert.deepEqual(fake.calls, [['glab', 'mr', 'list', '--repo', 'g/p', '--all', '--per-page', '100', '-F', 'json']]);
  assert.deepEqual(list, [
    { key: '!10', 'build-status': 'Passed', url: 'https://gitlab.com/g/p/-/merge_requests/10', status: 'Open', branch: 'change/ex-1', title: 'EX-1: first' },
    { key: '!14', 'build-status': 'Passed', url: 'https://gitlab.com/g/p/-/merge_requests/14', status: 'Closed', branch: 'main-fix', title: 'Unrelated' },
  ]);
});

test('fetchMergeRequests looks up by source branch, or searches titles and descriptions, however old (ASS-98)', async () => {
  const fake = glab([]);
  await fetchMergeRequests({ repoUrl: 'https://gitlab.com/g/p', branch: 'change/EX-1' }, fake.run);
  await fetchMergeRequests({ repoUrl: 'https://gitlab.com/g/p', search: 'EX-1' }, fake.run);
  assert.deepEqual(fake.calls, [
    ['glab', 'mr', 'list', '--repo', 'g/p', '--all', '--per-page', '100', '--source-branch', 'change/EX-1', '-F', 'json'],
    ['glab', 'mr', 'list', '--repo', 'g/p', '--all', '--per-page', '100', '--search', 'EX-1', '-F', 'json'],
  ]);
});

test('fetchMergeRequests maps pipeline states: merged first, then success/failed/running, anything else Pending', async () => {
  const fake = glab([
    mr(1, 'K-1 a', 'k-1-a', 'merged', 'failed'), mr(2, 'K-1 b', 'k-1-b', 'opened', 'running'),
    mr(3, 'K-1 c', 'k-1-c', 'opened', 'pending'), mr(4, 'K-1 d', 'k-1-d', 'opened', 'canceled'), mr(5, 'K-1 e', 'k-1-e', 'opened'),
  ]);
  const list = await fetchMergeRequests({ repoUrl: 'https://gitlab.com/g/p' }, fake.run);
  assert.deepEqual(list.map(m => m['build-status']), ['Merged', 'Running', 'Pending', 'Pending', 'Pending']);
});

test('fetchMergeRequests gives each its status (ASS-80): opened Open, merged Merged, closed Closed', async () => {
  const fake = glab([mr(1, 'K-1 a', 'a', 'opened', 'success'), mr(2, 'K-1 b', 'b', 'merged', 'success'), mr(3, 'K-1 c', 'c', 'closed', 'failed')]);
  const list = await fetchMergeRequests({ repoUrl: 'https://gitlab.com/g/p' }, fake.run);
  assert.deepEqual(list.map(m => m.status), ['Open', 'Merged', 'Closed']);
});

test('fetchMergeRequests takes an empty list, and fails on anything but JSON', async () => {
  assert.deepEqual(await fetchMergeRequests({ repoUrl: 'https://gitlab.com/g/p' }, async () => ''), []);
  await assert.rejects(fetchMergeRequests({ repoUrl: 'https://gitlab.com/g/p' }, async () => 'nope'), /glab/);
});

test('fetchMergeRequest reads one merge request by its url, however old, read-only with glab mr view (ASS-122)', async () => {
  const calls = [], run = async (cmd, args) => { calls.push([cmd, ...args]); return JSON.stringify(mr(3011, 'Draft: EX-2368: x', 'change/EX-2368', 'closed', 'failed')); };
  assert.deepEqual(await fetchMergeRequest({ url: 'https://gitlab.com/a/b/c/-/merge_requests/3011/' }, run),
    { key: '!3011', 'build-status': 'Failed', url: 'https://gitlab.com/g/p/-/merge_requests/3011', status: 'Closed', branch: 'change/EX-2368', title: 'Draft: EX-2368: x' });
  assert.deepEqual(calls, [['glab', 'mr', 'view', '3011', '--repo', 'a/b/c', '-F', 'json']]);
  await assert.rejects(fetchMergeRequest({ url: 'https://gitlab.com/a/b' }, run), /not a merge request url/);
  await assert.rejects(fetchMergeRequest({ url: 'https://gitlab.com/a/b/-/merge_requests/1' }, async () => '[]'), /glab/);
});
