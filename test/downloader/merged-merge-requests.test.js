// Every merged merge request for analytics (ASS-408): the reader (glab api,
// page by page) and the downloader cycle's step that hands what it read to
// analytics:sync-merge-requests — first read, paging, incremental read, a
// failed repository, a GitHub repository read (paging stops at the last read,
// closed unmerged skipped), a repository on another host skipped. A fake run;
// never GitLab or GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchMergedMergeRequests, fetchMergedPullRequests, syncMergedMergeRequests, forgeOf, OVERLAP_MS } from '../../src/downloader/merged-merge-requests.js';
import * as mergedMergeRequests from '../../src/downloader/merged-merge-requests.js';
import { runCycle } from '../../src/downloader/cycle.js';

const APP = 'https://gitlab.com/group/app', API = 'https://gitlab.com/group/api', HUB = 'https://github.com/group/site', OTHER = 'https://bitbucket.org/group/web';
// A merged merge request as GitLab's API gives it (the fields the reader reads, and one it drops).
const raw = (iid, extra = {}) => ({ iid, title: `Change ${iid}`, source_branch: `change/EX-${iid}`, author: { username: 'ada', name: 'Ada Example', id: 7 }, merged_at: '2026-11-01T10:00:00Z', state: 'merged', ...extra });
const kept = (repo, iid, extra = {}) => ({ repo, host: 'gitlab', iid, title: `Change ${iid}`, branch: `change/EX-${iid}`, author: { username: 'ada', name: 'Ada Example' }, 'merged-at': '2026-11-01T10:00:00Z', ...extra });
// A fake glab: pages[path] is the list of pages (arrays) for that project, or an Error to throw.
function glab(pages) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const query = args[args.length - 1];
    const [, project] = query.match(/^projects\/([^/]+)\//);
    const got = pages[decodeURIComponent(project)];
    if (got instanceof Error) throw got;
    const page = Number(new URL(`https://x/${query}`).searchParams.get('page'));
    return JSON.stringify(got?.[page - 1] ?? []);
  };
  return { calls, run };
}
const hundred = from => Array.from({ length: 100 }, (_, i) => raw(from + i));

test('ASS-408 AC1: the first read asks for every merged merge request, with no updated_after, and leaves out one without a merged_at', async () => {
  const fake = glab({ 'group/app': [[raw(1), raw(2, { merged_at: null }), raw(3)]] });
  const list = await fetchMergedMergeRequests({ repoUrl: APP }, fake.run);
  assert.deepEqual(fake.calls, [['glab', 'api', 'projects/group%2Fapp/merge_requests?state=merged&per_page=100&page=1']]);
  assert.deepEqual(list, [kept('group/app', 1), kept('group/app', 3)]);
});

test('ASS-408 AC1: the read goes page by page until a page has fewer than 100', async () => {
  const fake = glab({ 'group/app': [hundred(1), hundred(101), [raw(201)]] });
  const list = await fetchMergedMergeRequests({ repoUrl: APP, since: '2026-11-12T09:55:00.000Z' }, fake.run);
  assert.deepEqual(fake.calls.map(c => c.at(-1)), [1, 2, 3].map(p => `projects/group%2Fapp/merge_requests?state=merged&updated_after=2026-11-12T09:55:00.000Z&per_page=100&page=${p}`));
  assert.equal(list.length, 201);
  assert.deepEqual(list.at(-1), kept('group/app', 201));
  // A full last page: one more read, empty, ends it.
  const full = glab({ 'group/app': [hundred(1)] });
  assert.equal((await fetchMergedMergeRequests({ repoUrl: APP }, full.run)).length, 100);
  assert.equal(full.calls.length, 2);
});

test('ASS-408: a self-hosted GitLab is asked by its hostname; nested groups are encoded whole; glab printing no list rejects', async () => {
  const fake = glab({ 'team/sub/app': [[raw(1)]] });
  const list = await fetchMergedMergeRequests({ repoUrl: 'https://gitlab.example.test/team/sub/app' }, fake.run);
  assert.deepEqual(fake.calls, [['glab', 'api', '--hostname', 'gitlab.example.test', 'projects/team%2Fsub%2Fapp/merge_requests?state=merged&per_page=100&page=1']]);
  assert.equal(list[0].repo, 'team/sub/app');
  await assert.rejects(fetchMergedMergeRequests({ repoUrl: APP }, async () => '{"message":"404 Not Found"}'), /no merge requests/);
  await assert.rejects(fetchMergedMergeRequests({ repoUrl: APP }, async () => 'oops'), /did not print JSON/);
});

// A pull request as GitHub's pulls list gives it; and as kept.
const pr = (number, extra = {}) => ({ number, title: `Change ${number}`, head: { ref: `change/EX-${number}` }, user: { login: 'ada' }, merged_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-12T10:00:00Z', state: 'closed', ...extra });
const pulled = (repo, iid, extra = {}) => ({ ...kept(repo, iid), host: 'github', ...extra });
// A fake gh: pages is the list of pages of the pulls list (or an Error); profiles, login → name (absent: no name).
function gh(pages, profiles = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const path = args.at(-1);
    if (path.startsWith('users/')) {
      const login = path.slice(6);
      if (profiles[login] instanceof Error) throw profiles[login];
      return JSON.stringify({ login, name: profiles[login] ?? null });
    }
    if (pages instanceof Error) throw pages;
    return JSON.stringify(pages[Number(new URL(`https://x/${path}`).searchParams.get('page')) - 1] ?? []);
  };
  return { calls, run };
}
const prs = (from, updated) => Array.from({ length: 100 }, (_, i) => pr(from + i, { updated_at: updated }));

test('ASS-408 AC1: a GitHub repository\'s first read goes through every page of its closed pull requests, keeping the merged ones keyed by number, name from the profile', async () => {
  const fake = gh([prs(1, '2026-11-12T10:00:00Z'), [pr(101), pr(102, { merged_at: null }), pr(103, { user: { login: 'bob' } })]], { ada: 'Ada Example' });
  const list = await fetchMergedPullRequests({ repoUrl: HUB }, fake.run);
  assert.deepEqual(fake.calls, [
    ['gh', 'api', 'repos/group/site/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1'],
    ['gh', 'api', 'repos/group/site/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2'],
    ['gh', 'api', 'users/ada'], ['gh', 'api', 'users/bob'],
  ]);
  assert.equal(list.length, 102);   // 102, closed unmerged, left out
  assert.ok(!list.some(m => m.iid === 102));
  assert.deepEqual(list.find(m => m.iid === 101), pulled('group/site', 101));
  assert.deepEqual(list.find(m => m.iid === 103).author, { username: 'bob', name: 'bob' });   // no profile name: the login
});

test('ASS-408 AC1: a GitHub read stops at the page that reaches pull requests updated before the last read; names known are not asked for again', async () => {
  const since = '2026-11-12T09:55:00.000Z';
  const fake = gh([prs(1, '2026-11-12T10:30:00Z'), [pr(101, { updated_at: '2026-11-12T10:00:00Z' }), pr(102, { updated_at: '2026-11-12T09:00:00Z' }), ...prs(200, '2026-11-01T00:00:00Z').slice(2)], prs(400, '2026-10-01T00:00:00Z')]);
  const names = new Map([['ada', 'Ada Example']]);
  const list = await fetchMergedPullRequests({ repoUrl: HUB, since, names }, fake.run);
  assert.equal(fake.calls.length, 2);   // page 3 never read, no profile read
  assert.equal(list.length, 101);
  assert.ok(!list.some(m => m.iid === 102));
  await assert.rejects(fetchMergedPullRequests({ repoUrl: HUB }, gh(new Error('gh: HTTP 404')).run), /404/);
  // A profile read that fails gives the login; the list still counts.
  const failing = await fetchMergedPullRequests({ repoUrl: HUB }, gh([[pr(1)]], { ada: new Error('rate limited') }).run);
  assert.deepEqual(failing[0].author, { username: 'ada', name: 'ada' });
});

test('ASS-408: the step reads a GitHub repository from a few minutes before its fetched-through and takes the names merge-requests.json already holds', async () => {
  const calls = [], fake = gh([[pr(5, { updated_at: '2026-11-12T10:01:00Z' }), pr(4, { updated_at: '2026-11-12T09:00:00Z' })]], { ada: 'Not Asked' });
  const recorded = { 'fetched-through': { [HUB]: '2026-11-12T10:00:00.000Z' }, 'merge-requests': { 'group/site#1': pulled('group/site', 1) } };
  await syncMergedMergeRequests({ key: mkdtempSync(join(tmpdir(), 'mmr-')), project: 'p', repositories: [{ url: HUB }], recorded, call: async (args, payload) => { calls.push(payload); }, readers: { gitlab: fetchMergedMergeRequests, github: fetchMergedPullRequests }, run: fake.run, log: () => {} });
  assert.deepEqual(calls[0]['merge-requests'], [pulled('group/site', 5)]);
  assert.ok(fake.calls.every(c => !c.at(-1).startsWith('users/')));
});

// The step with a recording call; reader the real one over a fake glab.
async function step({ repositories, recorded = {}, pages, key = mkdtempSync(join(tmpdir(), 'mmr-')), fail }) {
  const calls = [], lines = [], fake = glab(pages);
  const call = async (args, payload) => { calls.push({ args, payload }); if (fail) throw new Error(fail); return ''; };
  const readers = { gitlab: fetchMergedMergeRequests, github: fetchMergedPullRequests };
  await syncMergedMergeRequests({ key, project: 'p', repositories, recorded: { 'fetched-through': recorded }, call, readers, run: fake.run, log: l => lines.push(l) });
  return { calls, lines, glab: fake.calls, key };
}

test('ASS-408 AC1/AC2: the step reads each GitLab repository, every status, and hands all it read to analytics:sync-merge-requests with each one\'s fetched-through', async () => {
  const before = Date.now();
  const { calls } = await step({ repositories: [{ url: APP, status: 'Active' }, { url: API, status: 'Archived' }, { status: 'Active' }], pages: { 'group/app': [[raw(1)]], 'group/api': [[raw(4)]] } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['analytics:sync-merge-requests', 'p']);
  assert.deepEqual(calls[0].payload['merge-requests'], [kept('group/app', 1), kept('group/api', 4)]);
  assert.deepEqual(Object.keys(calls[0].payload['fetched-through']), [APP, API]);
  for (const t of Object.values(calls[0].payload['fetched-through'])) assert.ok(Date.parse(t) >= before - 1000 && Date.parse(t) <= Date.now());
});

test('ASS-408 AC1: an incremental read starts a few minutes before the repository\'s fetched-through; one never read is read whole', async () => {
  const { glab: asked } = await step({ repositories: [{ url: APP }, { url: API }], recorded: { [APP]: '2026-11-12T10:00:00.000Z' }, pages: { 'group/app': [[]], 'group/api': [[]] } });
  assert.equal(OVERLAP_MS, 5 * 60_000);
  assert.deepEqual(asked.map(c => c.at(-1)), [
    'projects/group%2Fapp/merge_requests?state=merged&updated_after=2026-11-12T09:55:00.000Z&per_page=100&page=1',
    'projects/group%2Fapi/merge_requests?state=merged&per_page=100&page=1',
  ]);
});

test('ASS-408 AC4: a repository whose read fails is logged once until that changes, its fetched-through left out; the others are still read', async () => {
  const pages = { 'group/app': new Error('glab: 401 Unauthorized\nmore'), 'group/api': [[raw(4)]] };
  const repositories = [{ url: APP }, { url: API }];
  const first = await step({ repositories, pages });
  assert.deepEqual(first.calls[0].payload, { 'fetched-through': { [API]: first.calls[0].payload['fetched-through'][API] }, 'merge-requests': [kept('group/api', 4)] });
  assert.equal(first.lines.filter(l => l.includes(APP)).length, 1);
  assert.match(first.lines.find(l => l.includes(APP)), /could not be read.*401 Unauthorized$/);
  const again = await step({ repositories, pages, key: first.key });
  assert.equal(again.lines.filter(l => l.includes(APP)).length, 0);   // the same failure: not logged again
  const other = await step({ repositories, pages: { ...pages, 'group/app': new Error('glab: 500') }, key: first.key });
  assert.equal(other.lines.filter(l => l.includes(APP)).length, 1);   // a different one: logged
  await step({ repositories, pages: { ...pages, 'group/app': [[]] }, key: first.key });   // works again
  const broken = await step({ repositories, pages: { ...pages, 'group/app': new Error('glab: 500') }, key: first.key });
  assert.equal(broken.lines.filter(l => l.includes(APP)).length, 1);   // fails again after working: logged
  // Every repository failed: nothing to keep, no call.
  const none = await step({ repositories: [{ url: APP }], pages });
  assert.deepEqual(none.calls, []);
});

test('ASS-408 AC5: a repository on another host is skipped, logged once; a failed agent.sh call is logged and the step does not throw', async () => {
  const first = await step({ repositories: [{ url: OTHER }, { url: APP }], pages: { 'group/app': [[]] } });
  assert.ok(first.glab.every(c => !c.at(-1).includes('web')));
  assert.deepEqual(Object.keys(first.calls[0].payload['fetched-through']), [APP]);
  assert.equal(first.lines.filter(l => l.includes(OTHER)).length, 1);
  const again = await step({ repositories: [{ url: OTHER }, { url: APP }], pages: { 'group/app': [[]] }, key: first.key });
  assert.equal(again.lines.filter(l => l.includes(OTHER)).length, 0);
  const onlyOther = await step({ repositories: [{ url: OTHER }], pages: {} });
  assert.deepEqual([onlyOther.calls, onlyOther.glab], [[], []]);
  assert.deepEqual([forgeOf(HUB), forgeOf(APP), forgeOf('https://gitlab.example.test/a/b'), forgeOf(OTHER), forgeOf('not a url')], ['github', 'gitlab', 'gitlab', null, null]);
  const failed = await step({ repositories: [{ url: APP }], pages: { 'group/app': [[]] }, fail: 'locked' });
  assert.ok(failed.lines.some(l => /not kept: locked/.test(l)));
});

// The cycle: an off-board project with two GitLab repositories and a GitHub one, its analytics file holding one's fetched-through.
test('ASS-408 AC1/AC3: every cycle runs the step before the last-data-download, reading fetched-through from analytics/merge-requests.json; the sprint scan is unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-mmr-'));
  const folder = join(dir, 'data', 'projects', 'p');
  mkdirSync(join(folder, 'analytics'), { recursive: true });
  writeFileSync(join(folder, 'project.json'), JSON.stringify({ 'work-sources': [{ name: 'Off', type: 'off-board', folder: 'p' }], repositories: [{ url: APP, status: 'Active' }, { url: API, status: 'Archived' }, { url: HUB, status: 'Active' }, { url: OTHER, status: 'Active' }] }));
  writeFileSync(join(folder, 'analytics', 'merge-requests.json'), JSON.stringify({ 'fetched-through': { [APP]: '2026-11-12T10:00:00.000Z' }, 'merge-requests': {} }));
  const calls = [], glabCalls = [];
  const exec = async (file, args) => {
    if (file === 'glab') {
      glabCalls.push(args.at(-1));
      return JSON.stringify(args.at(-1).includes('group%2Fapp') ? [raw(1)] : []);
    }
    if (file === 'gh') {
      glabCalls.push(args.at(-1));
      return args.at(-1).startsWith('users/') ? '{"name":"Ada Example"}' : JSON.stringify([pr(9)]);
    }
    calls.push({ args: args.slice(0, 2), payload: args[2] && existsSync(args[2]) ? JSON.parse(readFileSync(args[2], 'utf8')) : undefined });
    return '';
  };
  const lines = [];
  await runCycle({ root: dir, project: 'p', now: new Date('2026-11-12T10:04:00Z'), adapters: { offBoard: { fetchTickets: async () => [] }, mergedMergeRequests }, exec, log: l => lines.push(l) });
  assert.deepEqual(calls.map(c => c.args[0]), ['analytics:sync-merge-requests', 'project:set-last-data-download']);
  assert.deepEqual(calls[0].payload['merge-requests'], [kept('group/app', 1), pulled('group/site', 9)]);
  assert.deepEqual(Object.keys(calls[0].payload['fetched-through']), [APP, API, HUB]);
  assert.deepEqual(glabCalls, [
    'projects/group%2Fapp/merge_requests?state=merged&updated_after=2026-11-12T09:55:00.000Z&per_page=100&page=1',
    'projects/group%2Fapi/merge_requests?state=merged&per_page=100&page=1',
    'repos/group/site/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1',
    'users/ada',
  ]);
  assert.ok(lines.some(l => l.includes(OTHER) && /neither GitLab nor GitHub/.test(l)), lines.join('\n'));
  // Without the adapter (an older caller), no analytics step.
  calls.length = 0;
  await runCycle({ root: dir, project: 'p', now: new Date(), adapters: { offBoard: { fetchTickets: async () => [] } }, exec, log: () => {} });
  assert.deepEqual(calls.map(c => c.args[0]), ['project:set-last-data-download']);
});
