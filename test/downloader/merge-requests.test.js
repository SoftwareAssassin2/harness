// The merge-request scan of a cycle (ASS-92/98): every Active repository's
// list, the ticket each merge request belongs to, and the targeted lookups for
// sprint tickets with none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanMergeRequests } from '../../src/downloader/merge-requests.js';

// A merge request as an adapter gives it.
const mr = (repo, n, branch, title = 'Untitled', extra = {}) => ({ key: `!${n}`, 'build-status': 'Passed', url: `https://gitlab.com/g/${repo}/-/merge_requests/${n}`, status: 'Open', branch, title, ...extra });
// Fake adapters: lists by repository url, lookups by "<repo url> <branch|search>", single merge requests by url
// (direct); a repository or merge-request url in `failing` rejects.
function forges({ lists = {}, lookups = {}, direct = {}, failing = [] } = {}) {
  const asked = [];
  const fetchMergeRequests = forge => async ({ repoUrl, branch, search }) => {
    asked.push([forge, repoUrl, ...(branch ? ['branch', branch] : []), ...(search ? ['search', search] : [])]);
    if (failing.includes(repoUrl)) throw new Error('404 Not Found\nmore');
    return branch || search ? lookups[`${repoUrl} ${branch ?? search}`] ?? [] : lists[repoUrl] ?? [];
  };
  const fetchMergeRequest = forge => async ({ url }) => {
    asked.push([forge, 'direct', url]);
    if (failing.includes(url) || !direct[url]) throw new Error('404 Not Found\nmore');
    return direct[url];
  };
  return { asked, gitlab: { fetchMergeRequests: fetchMergeRequests('gitlab'), fetchMergeRequest: fetchMergeRequest('gitlab') }, github: { fetchMergeRequests: fetchMergeRequests('github'), fetchMergeRequest: fetchMergeRequest('github') } };
}
// What a cycle passes as recorded: each sprint ticket's recorded merge-request urls, by its lower-cased key.
const recordedOf = entries => new Map(Object.entries(entries));
const ONE = 'https://gitlab.com/g/one', TWO = 'https://gitlab.com/g/two', HUB = 'https://github.com/o/r';
const strip = ({ title, ...m }) => m;

test('a scan lists each repository once and gives every merge request the ticket its branch names, else the one its title starts with, else none — never one a title only mentions (ASS-92 AC1)', async () => {
  const a = forges({ lists: {
    [ONE]: [mr('one', 1, 'change/ex-1'), mr('one', 2, 'change/EX-2', 'X (EX-1 producer)'), mr('one', 3, 'feature/x', 'Draft: EX-3: thing'), mr('one', 4, 'change/EX-20', 'EX-2 follow-up')],
    [TWO]: [mr('two', 1, 'main-fix', 'Mentions EX-1 somewhere'), mr('two', 2, 'change/EX-1.B')],
  } });
  const scan = await scanMergeRequests({ repos: [ONE, TWO], keys: ['EX-1', 'EX-2', 'EX-3'] }, a, async () => '');
  assert.deepEqual(a.asked, [['gitlab', ONE], ['gitlab', TWO]]);
  assert.deepEqual(scan, [
    { ...strip(mr('one', 1, 'change/ex-1')), ticket: 'EX-1' },
    { ...strip(mr('one', 2, 'change/EX-2')), ticket: 'EX-2' },
    { ...strip(mr('one', 3, 'feature/x')), ticket: 'EX-3' },
    { ...strip(mr('one', 4, 'change/EX-20')), ticket: 'EX-2' },          // EX-2 is not EX-20, but the title starts with EX-2
    { ...strip(mr('two', 1, 'main-fix')), ticket: null },
    { ...strip(mr('two', 2, 'change/EX-1.B')), ticket: 'EX-1' },
  ]);
});

test('a scan reads a GitHub repository through the github adapter (ASS-92)', async () => {
  const a = forges({ lists: { [HUB]: [{ ...mr('r', 5, 'change/ASS-5'), key: '#5', url: 'https://github.com/o/r/pull/5' }] } });
  const scan = await scanMergeRequests({ repos: [HUB], keys: ['ASS-5'] }, a, async () => '');
  assert.deepEqual(a.asked, [['github', HUB]]);
  assert.deepEqual(scan.map(m => [m.key, m.ticket]), [['#5', 'ASS-5']]);
});

test('when any repository cannot be read the scan is empty, so no record changes, and each failure is logged (ASS-98 AC2)', async () => {
  const a = forges({ lists: { [TWO]: [mr('two', 1, 'change/EX-1')] }, failing: [ONE] }), lines = [];
  assert.deepEqual(await scanMergeRequests({ repos: [ONE, TWO], keys: ['EX-1'], log: l => lines.push(l) }, a, async () => ''), []);
  assert.deepEqual(a.asked, [['gitlab', ONE], ['gitlab', TWO]]);
  assert.deepEqual(lines, [`${ONE}: merge requests skipped: 404 Not Found`, 'merge requests: a forge could not be read; every record kept this cycle']);
});

test('on a lookup cycle a sprint ticket with nothing recorded and nothing listed is looked up in each repository by branch change/<key>, and by title only when that finds none, however old (ASS-98 AC1)', async () => {
  const old = mr('two', 7, 'change/EX-3', 'EX-3: old'), titled = mr('one', 8, 'ex-4-work', 'EX-4: old too'), stray = mr('one', 9, 'other', 'Says EX-4 in passing');
  const a = forges({
    lists: { [ONE]: [mr('one', 1, 'change/EX-1'), mr('one', 2, 'change/EX-2')] },
    lookups: { [`${TWO} change/EX-3`]: [old], [`${ONE} EX-4`]: [titled, stray] },
  });
  const keys = ['EX-1', 'EX-2', 'EX-3', 'EX-4'];
  const scan = await scanMergeRequests({ repos: [ONE, TWO], keys, recorded: recordedOf({ 'ex-2': [mr('one', 2, 'change/EX-2').url] }), lookups: true }, a, async () => '');
  assert.deepEqual(a.asked, [
    ['gitlab', ONE], ['gitlab', TWO],
    ['gitlab', ONE, 'branch', 'change/EX-3'], ['gitlab', TWO, 'branch', 'change/EX-3'],
    ['gitlab', ONE, 'branch', 'change/EX-4'], ['gitlab', TWO, 'branch', 'change/EX-4'],
    ['gitlab', ONE, 'search', 'EX-4'], ['gitlab', TWO, 'search', 'EX-4'],
  ]);
  assert.deepEqual(scan.map(m => [m.key, m.url.split('/')[4], m.ticket]), [['!1', 'one', 'EX-1'], ['!2', 'one', 'EX-2'], ['!7', 'two', 'EX-3'], ['!8', 'one', 'EX-4'], ['!9', 'one', null]]);
  // Not a lookup cycle: the lists alone.
  const quiet = forges({ lists: { [ONE]: [] } });
  await scanMergeRequests({ repos: [ONE], keys, lookups: false }, quiet, async () => '');
  assert.deepEqual(quiet.asked, [['gitlab', ONE]]);
});

test('a lookup that fails empties the scan too', async () => {
  const a = forges({ lists: { [ONE]: [mr('one', 1, 'change/EX-1')] } }), lines = [];
  a.gitlab.fetchMergeRequests = async ({ branch }) => { if (branch) throw new Error('timeout'); return [mr('one', 1, 'change/EX-1')]; };
  assert.deepEqual(await scanMergeRequests({ repos: [ONE], keys: ['EX-1', 'EX-2'], lookups: true, log: l => lines.push(l) }, a, async () => ''), []);
  assert.ok(lines.includes(`${ONE}: merge requests skipped: timeout`), lines.join('\n'));
});

test('on a lookup cycle each recorded merge request no list showed is fetched directly by its url, however old, and refreshed from what it is now (ASS-122 AC1)', async () => {
  const old = mr('one', 3011, 'change/EX-2', 'EX-2: old', { status: 'Closed', 'build-status': 'Failed' });
  const hub = { ...mr('r', 4, 'change/EX-3'), key: '#4', url: 'https://github.com/o/r/pull/4', status: 'Merged', 'build-status': 'Merged' };
  const listed = mr('one', 5, 'change/EX-1'), gone = mr('one', 99, 'change/EX-9', 'EX-9: x', { status: 'Merged' });
  const a = forges({ lists: { [ONE]: [listed] }, direct: { [old.url]: old, [hub.url]: hub, [gone.url]: gone } });
  const recorded = recordedOf({ 'ex-1': [listed.url.toUpperCase()], 'ex-2': [old.url, old.url], 'ex-3': [hub.url], 'ex-9': [gone.url] });
  const scan = await scanMergeRequests({ repos: [ONE], keys: ['EX-1', 'EX-2', 'EX-3'], recorded, lookups: true }, a, async () => '');
  // Listed (in any case): not fetched again; recorded twice: fetched once; a sprint ticket the fetch lacks (EX-9): fetched, for no ticket.
  assert.deepEqual(a.asked, [['gitlab', ONE], ['gitlab', 'direct', old.url], ['github', 'direct', hub.url], ['gitlab', 'direct', gone.url]]);
  assert.deepEqual(scan, [{ ...strip(listed), ticket: 'EX-1' }, { ...strip(old), ticket: 'EX-2' }, { ...strip(hub), ticket: 'EX-3' }, { ...strip(gone), ticket: null }]);
  // Not a lookup cycle: none fetched.
  const quiet = forges({ lists: { [ONE]: [] } });
  await scanMergeRequests({ repos: [ONE], keys: ['EX-2'], recorded, lookups: false }, quiet, async () => '');
  assert.deepEqual(quiet.asked, [['gitlab', ONE]]);
});

test('on a lookup cycle a ticket whose recorded merge requests are none on its own branch is looked up too, and what is found comes beside them; one with a recorded merge request on its branch is not (ASS-122 AC2)', async () => {
  const wrong = mr('one', 3011, 'change/EX-2368', 'Draft: EX-2368: x (EX-1201 producer)', { status: 'Closed' });
  const real = mr('one', 2744, 'change/EX-1201', 'EX-1201: the real one', { status: 'Merged' });
  const mine = mr('two', 7, 'change/EX-7.B');
  const a = forges({ lists: { [TWO]: [mine] }, direct: { [wrong.url]: wrong }, lookups: { [`${ONE} change/EX-1201`]: [real] } });
  const recorded = recordedOf({ 'ex-1201': [wrong.url], 'ex-7': [mine.url] });
  const scan = await scanMergeRequests({ repos: [ONE, TWO], keys: ['EX-1201', 'EX-2368', 'EX-7'], recorded, lookups: true }, a, async () => '');
  assert.deepEqual(a.asked, [
    ['gitlab', ONE], ['gitlab', TWO], ['gitlab', 'direct', wrong.url],
    ['gitlab', ONE, 'branch', 'change/EX-1201'], ['gitlab', TWO, 'branch', 'change/EX-1201'],
    // EX-2368: nothing recorded, but the fetched !3011 is its by branch, so no lookup; EX-7: recorded on change/EX-7.B.
  ]);
  assert.deepEqual(scan.map(m => [m.key, m.ticket]), [['!7', 'EX-7'], ['!3011', 'EX-2368'], ['!2744', 'EX-1201']]);
});

test('a direct fetch that fails empties the scan, so every record is kept, and is logged (ASS-122 AC3)', async () => {
  const gone = 'https://gitlab.com/g/one/-/merge_requests/404', lines = [];
  const a = forges({ lists: { [ONE]: [mr('one', 1, 'change/EX-1')] }, failing: [gone] });
  const scan = await scanMergeRequests({ repos: [ONE], keys: ['EX-1', 'EX-2'], recorded: recordedOf({ 'ex-2': [gone] }), lookups: true, log: l => lines.push(l) }, a, async () => '');
  assert.deepEqual(scan, []);
  assert.deepEqual(a.asked, [['gitlab', ONE], ['gitlab', 'direct', gone]]);   // no lookups after the failure
  assert.deepEqual(lines, [`${gone}: merge request skipped: 404 Not Found`, 'merge requests: a forge could not be read; every record kept this cycle']);
});
