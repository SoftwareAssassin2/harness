// ASS-558: gathering a ticket variation's commits (src/control/ticket-commits.js) from fake forge and clone data —
// pushed, in an open merge request, merged, squashed, local only, and the same SHA seen by several sources listed
// once with the furthest state; the readers' commands (glab, gh, git only: never a machine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherCommits, referencesKey, variationOfBranch, forgeReader, gitReader, repoUrlOf, mrRepository, sinceOf, commitUrl } from '../../src/control/ticket-commits.js';

const APP = 'https://gitlab.example.com/g/app', WEB = 'https://github.com/o/web';
const c = (sha, subject, date, extra = {}) => ({ sha, subject, message: extra.message ?? subject, author: extra.author ?? 'Ada', date });

// A fake forge: per repository url its default branch, branches with their commits ahead, and default-branch commits;
// per merge request url its commits; `fail` urls throw. Every call recorded.
function fakeForge({ repos = {}, mrs = {}, fail = [] } = {}) {
  const calls = [];
  const repo = url => { if (fail.includes(url)) throw new Error(`${url}: 503`); return repos[url] ?? { branches: {}, onDefault: [] }; };
  return {
    calls,
    defaultBranch: async url => { calls.push(['default', url]); return repo(url).base ?? 'main'; },
    branches: async (url, prefix) => { calls.push(['branches', url, prefix]); return Object.keys(repo(url).branches).filter(b => b.startsWith(prefix)); },
    ahead: async (url, base, head) => { calls.push(['ahead', url, base, head]); return repo(url).branches[head] ?? []; },
    mrCommits: async mr => { calls.push(['mr', mr.url]); if (fail.includes(mr.url)) throw new Error('gone'); return mrs[mr.url] ?? []; },
    onDefault: async (url, since) => { calls.push(['onDefault', url, since]); return repo(url).onDefault; },
  };
}
// A fake clone reader: per folder its origin, default branch, refs and what each `git log` range gives.
function fakeGit(clones) {
  return {
    origin: async dir => clones[dir].origin,
    defaultBranch: async dir => clones[dir].base ?? 'main',
    refs: async dir => Object.keys(clones[dir].refs ?? {}),
    log: async (dir, args) => clones[dir].logs?.[args.join(' ')] ?? [],
  };
}
const SINCE = '2026-11-01T00:00:00Z';
const base = { key: 'ABC-7', variation: 'A', variations: ['A'], since: SINCE, repositories: [{ url: APP }, { url: WEB }] };

test('ASS-558 AC2: variationOfBranch and referencesKey tell the ticket\'s branches and default-branch commits — the key whole, the variation named', () => {
  assert.equal(variationOfBranch('change/ABC-7', 'ABC-7'), 'A');
  assert.equal(variationOfBranch('change/ABC-7-2', 'abc-7'), 'A');
  assert.equal(variationOfBranch('change/abc-7.B-3', 'ABC-7'), 'B');
  assert.equal(variationOfBranch('refs/remotes/origin/change/ABC-7.C', 'ABC-7'), 'C');
  assert.equal(variationOfBranch('change/ABC-70', 'ABC-7'), null);
  assert.equal(variationOfBranch('feature/ABC-7', 'ABC-7'), null);
  assert.deepEqual(referencesKey('ABC-7: add the endpoint', 'ABC-7'), { variation: null });
  assert.deepEqual(referencesKey("Merge branch 'change/ABC-7.B-1' into 'main'\n\nABC-7: …", 'ABC-7'), { variation: 'B' });
  assert.deepEqual(referencesKey('Add the endpoint (#16)\n\n* change/ABC-7-1', 'ABC-7'), { variation: 'A' });   // a GitHub squash, its branch in the body
  assert.deepEqual(referencesKey('Close accounts [ABC-7] (#16)', 'ABC-7'), { variation: null });                   // a squash titled by its MR
  assert.equal(referencesKey('ABC-70: another ticket', 'ABC-7'), null);
  assert.equal(referencesKey('ABC-8: follow-up to ABC-7', 'ABC-7'), null);                                         // another ticket's, citing this one
  assert.equal(referencesKey('Revert "ABC-7: add the endpoint"', 'ABC-7'), null);
  assert.equal(referencesKey('XABC-7: no', 'ABC-7'), null);
});

test('ASS-558 AC1/AC2: forge data — pushed (a branch with no MR), in an open MR, merged (a merged MR and on the default branch), squashed — each commit once, with its repository, branch or MR, and state', async () => {
  const forge = fakeForge({
    repos: {
      [APP]: {
        base: 'main',
        branches: { 'change/ABC-7-1': [c('aaa1111', 'ABC-7: open one', '2026-11-03T10:00:00Z')], 'change/ABC-7-2': [c('bbb2222', 'ABC-7: pushed only', '2026-11-04T10:00:00Z')], 'change/ABC-70': [c('zzz', 'ABC-70: not ours', '2026-11-04T10:00:00Z')] },
        onDefault: [c('ccc3333', 'ABC-7: merged straight', '2026-11-02T10:00:00Z'), c('ddd4444', 'ABC-8: another ticket', '2026-11-02T11:00:00Z')],
      },
      [WEB]: {
        base: 'main', branches: {},
        // GitHub's squash of PR #16: a new SHA on main, its subject the PR title, its body naming the branch.
        onDefault: [c('eee5555', 'Close the account page (#16)', '2026-11-05T10:00:00Z', { message: 'Close the account page (#16)\n\n* ABC-7: page\n* change/ABC-7-3' })],
      },
    },
    mrs: {
      'https://gitlab.example.com/g/app/-/merge_requests/12': [c('aaa1111', 'ABC-7: open one', '2026-11-03T10:00:00Z')],
      'https://github.com/o/web/pull/16': [c('fff6666', 'ABC-7: page', '2026-11-04T12:00:00Z', { author: 'Bob' })],   // squashed: its own commit is not on main
    },
  });
  const mrs = [
    { id: 1, key: '!12', url: 'https://gitlab.example.com/g/app/-/merge_requests/12', status: 'Open', 'build-status': 'Running', repository: `${APP}.git`, branch: 'change/ABC-7-1' },
    { id: 2, key: '#16', url: 'https://github.com/o/web/pull/16', status: 'Merged', 'build-status': 'Merged', branch: 'change/ABC-7-3' },
    { id: 3, key: null, url: null, status: 'Not Created', repository: APP, branch: 'change/ABC-7-2' },
  ];
  const { commits, sources } = await gatherCommits({ ...base, mrs }, { forge, git: null });
  const by = Object.fromEntries(commits.map(x => [x.short.slice(0, 3), x]));
  assert.deepEqual(Object.keys(by).toSorted(), ['aaa', 'bbb', 'ccc', 'eee', 'fff']);
  assert.deepEqual([by.aaa.state, by.aaa.mr, by.aaa.branch, by.aaa.repository], ['open-mr', '!12', 'change/ABC-7-1', 'app']);
  assert.deepEqual([by.bbb.state, by.bbb.mr, by.bbb.branch], ['pushed', null, 'change/ABC-7-2']);
  assert.deepEqual([by.ccc.state, by.ccc.branch], ['merged', 'main']);
  assert.deepEqual([by.eee.state, by.eee.repository, by.eee.subject], ['merged', 'web', 'Close the account page (#16)']);   // the squash commit
  assert.deepEqual([by.fff.state, by.fff.mr, by.fff.author], ['merged', '#16', 'Bob']);                                 // the squashed MR's own commit
  assert.equal(by.aaa.url, 'https://gitlab.example.com/g/app/-/commit/aaa1111');
  assert.equal(by.fff.url, 'https://github.com/o/web/commit/fff6666');
  assert.deepEqual(commits.map(x => x.short.slice(0, 3)), ['eee', 'fff', 'bbb', 'aaa', 'ccc']);   // newest first
  assert.ok(!forge.calls.some(([what, , , head]) => what === 'ahead' && head === 'change/ABC-7-1'), 'a branch with an open MR is read through the MR');
  assert.ok(sources.every(s => s.ok));
  assert.deepEqual(forge.calls.filter(([w]) => w === 'onDefault').map(([, , since]) => since), [SINCE, SINCE]);
});

test('ASS-558 AC2: the same SHA from several sources appears once, at the furthest state seen, keeping its MR and branch', async () => {
  const forge = fakeForge({
    repos: { [APP]: { branches: {}, onDefault: [c('abc1234', 'ABC-7: one', '2026-11-03T10:00:00Z')] }, [WEB]: { branches: {}, onDefault: [] } },
    mrs: { 'https://gitlab.example.com/g/app/-/merge_requests/3': [c('abc1234', 'ABC-7: one', '2026-11-03T10:00:00Z')] },
  });
  const git = fakeGit({ '/mac/app': {
    origin: 'git@gitlab.example.com:g/app.git',
    refs: { 'refs/heads/change/ABC-7-1': 1, 'refs/remotes/origin/change/ABC-7-1': 1 },
    logs: {
      'refs/heads/change/ABC-7-1 --not --remotes': [],
      'refs/remotes/origin/change/ABC-7-1 --not refs/remotes/origin/main': [c('ABC1234', 'ABC-7: one', '2026-11-03T10:00:00Z')],
      [`refs/remotes/origin/main --since=${SINCE}`]: [c('abc1234', 'ABC-7: one', '2026-11-03T10:00:00Z')],
    },
  } });
  const mrs = [{ key: '!3', url: 'https://gitlab.example.com/g/app/-/merge_requests/3', status: 'Merged', branch: 'change/ABC-7-1' }];
  const { commits } = await gatherCommits({ ...base, mrs, clones: ['/mac/app'] }, { forge, git });
  assert.equal(commits.length, 1);
  assert.deepEqual([commits[0].sha, commits[0].state, commits[0].mr, commits[0].branch, commits[0].repository], ['abc1234', 'merged', '!3', 'change/ABC-7-1', 'app']);
});

test('ASS-558 AC1/AC2: a clone on the Mac shows commits not pushed yet as local only, and pushed ones as pushed; another variation\'s branch is left out', async () => {
  const git = fakeGit({ '/mac/app': {
    origin: 'https://gitlab.example.com/g/app.git',
    refs: { 'refs/heads/change/ABC-7-1': 1, 'refs/remotes/origin/change/ABC-7-1': 1, 'refs/heads/change/ABC-7.B-1': 1, 'refs/heads/change/ABC-70': 1 },
    logs: {
      'refs/heads/change/ABC-7-1 --not --remotes': [c('1111111', 'ABC-7: not pushed yet', '2026-11-06T09:00:00Z')],
      'refs/remotes/origin/change/ABC-7-1 --not refs/remotes/origin/main': [c('2222222', 'ABC-7: pushed', '2026-11-05T09:00:00Z')],
      'refs/heads/change/ABC-7.B-1 --not --remotes': [c('3333333', 'ABC-7: variation B', '2026-11-06T09:00:00Z')],
      'refs/heads/change/ABC-70 --not --remotes': [c('4444444', 'ABC-70: not ours', '2026-11-06T09:00:00Z')],
      [`refs/heads/main --not --remotes --since=${SINCE}`]: [c('5555555', 'ABC-7: by hand on main, not pushed', '2026-11-07T09:00:00Z'), c('6666666', 'ABC-9: other', '2026-11-07T09:00:00Z')],
    },
  } });
  const { commits, sources } = await gatherCommits({ ...base, variations: ['A', 'B'], clones: ['/mac/app'] }, { forge: null, git });
  assert.deepEqual(commits.map(x => [x.short.slice(0, 1), x.state, x.branch, x.url]), [
    ['5', 'local', 'main', null], ['1', 'local', 'change/ABC-7-1', null], ['2', 'pushed', 'change/ABC-7-1', 'https://gitlab.example.com/g/app/-/commit/2222222'],
  ]);
  assert.deepEqual(sources, [{ source: 'clone', repository: 'app', ok: true }]);
  const b = await gatherCommits({ ...base, variation: 'B', variations: ['A', 'B'], clones: ['/mac/app'] }, { forge: null, git });
  assert.deepEqual(b.commits.map(x => x.short.slice(0, 1)), ['3']);   // B's own branch; main's unnamed commits are A's (none merged: the first)
});

test('ASS-558 AC2: a default-branch commit naming no variation goes to the ticket\'s only one, else the one merged; one naming its branch to that variation', async () => {
  const forge = fakeForge({ repos: { [APP]: { branches: {}, onDefault: [
    c('a0', 'ABC-7: squash, no variation', '2026-11-03T10:00:00Z'),
    c('b0', "Merge branch 'change/ABC-7.B-1' into 'main'", '2026-11-04T10:00:00Z'),
  ] }, [WEB]: { branches: {}, onDefault: [] } } });
  const gather = (variation, mergedVariations) => gatherCommits({ ...base, variation, variations: ['A', 'B'], mergedVariations }, { forge, git: null }).then(r => r.commits.map(x => x.sha));
  assert.deepEqual(await gather('A', ['B']), []);
  assert.deepEqual(await gather('B', ['B']), ['b0', 'a0']);
  assert.deepEqual(await gather('A', []), ['a0']);
  assert.deepEqual(await gather('B', []), ['b0']);
});

test('ASS-558 AC3: a source that fails is recorded with its error and the rest still read', async () => {
  const forge = fakeForge({ fail: [WEB], repos: { [APP]: { branches: { 'change/ABC-7': [c('a1', 'ABC-7: x', '2026-11-03T10:00:00Z')] }, onDefault: [] } } });
  const { commits, sources } = await gatherCommits(base, { forge, git: null });
  assert.deepEqual(commits.map(x => x.sha), ['a1']);
  assert.deepEqual(sources, [{ source: 'forge', repository: 'app', ok: true }, { source: 'forge', repository: 'web', ok: false, error: `${WEB}: 503` }]);
  const none = await gatherCommits({ ...base, repositories: [] }, { forge, git: null });
  assert.deepEqual(none, { commits: [], sources: [] });
});

test('ASS-558 AC3: the readers run only glab, gh and git — read-only calls, never a machine (limactl, ssh, gcloud, kubectl)', async () => {
  const ran = [];
  const answers = [
    [/^glab api projects\/g%2Fapp --hostname gitlab.example.com$/, { default_branch: 'main' }],
    [/^glab api projects\/g%2Fapp\/repository\/branches\?search=%5Echange%2FABC-7&per_page=100/, [{ name: 'change/ABC-7-1' }]],
    [/^glab api projects\/g%2Fapp\/repository\/compare\?from=main&to=change%2FABC-7-1/, { commits: [{ id: 'aa', title: 'ABC-7: x', message: 'ABC-7: x', author_name: 'Ada', authored_date: '2026-11-03T10:00:00Z' }] }],
    [/^glab api projects\/g%2Fapp\/repository\/commits\?since=/, []],
    [/^glab api projects\/g%2Fapp\/merge_requests\/4\/commits/, [{ id: 'bb', title: 'ABC-7: y', author_name: 'Ada', created_at: '2026-11-03T11:00:00Z' }]],
    [/^gh api repos\/o\/web$/, { default_branch: 'main' }],
    [/^gh api repos\/o\/web\/git\/matching-refs\/heads\/change\/ABC-7$/, []],
    [/^gh api repos\/o\/web\/commits\?since=/, [{ sha: 'cc', commit: { message: 'ABC-7: z\n\nbody', author: { name: 'Bo', date: '2026-11-04T10:00:00Z' } } }]],
    [/^git -C \/mac\/app remote get-url origin$/, 'git@gitlab.example.com:g/app.git\n'],
    [/^git -C \/mac\/app symbolic-ref --short refs\/remotes\/origin\/HEAD$/, 'origin/main\n'],
    [/^git -C \/mac\/app for-each-ref/, 'refs/heads/change/ABC-7-1\n'],
    [/^git -C \/mac\/app log --max-count=500 --format=\S+ refs\/heads\/change\/ABC-7-1 --not --remotes$/, `dd\x1fAda\x1f2026-11-06T09:00:00+00:00\x1fABC-7: local\n\nbody\x1e`],
    [/^git -C \/mac\/app log /, ''],
  ];
  const run = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    ran.push(line);
    const hit = answers.find(([re]) => re.test(line));
    if (!hit) throw new Error(`no answer for ${line}`);
    return typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]);
  };
  const mrs = [{ key: '!4', url: 'https://gitlab.example.com/g/app/-/merge_requests/4', status: 'Open', branch: 'change/ABC-7-9' }];
  const { commits, sources } = await gatherCommits({ ...base, mrs, clones: ['/mac/app'] }, { forge: forgeReader(run), git: gitReader(run) });
  assert.ok(sources.every(s => s.ok), JSON.stringify(sources));
  assert.deepEqual(commits.map(x => [x.sha, x.state, x.author]), [['dd', 'local', 'Ada'], ['cc', 'merged', 'Bo'], ['bb', 'open-mr', 'Ada'], ['aa', 'pushed', 'Ada']]);
  assert.equal(commits[0].subject, 'ABC-7: local');
  assert.ok(ran.every(l => /^(glab|gh|git) /.test(l)), ran.join('\n'));
  assert.ok(!ran.some(l => /\b(fetch|push|pull|checkout|reset|commit|clone)\b/.test(l.replace(/\/commits\b|--format=\S+/g, ''))), 'nothing but reads');
});

test('ASS-558: repoUrlOf, mrRepository, commitUrl and sinceOf', () => {
  assert.equal(repoUrlOf('git@github.com:O/Web.git'), 'https://github.com/o/web');
  assert.equal(repoUrlOf('https://gitlab.example.com/g/app.git/'), 'https://gitlab.example.com/g/app');
  assert.equal(mrRepository({ url: 'https://gitlab.example.com/g/sub/app/-/merge_requests/9' }), 'https://gitlab.example.com/g/sub/app');
  assert.equal(mrRepository({ url: 'https://github.com/o/web/pull/3' }), 'https://github.com/o/web');
  assert.equal(commitUrl(null, 'x'), null);
  assert.equal(sinceOf({ 'state-changes': [{ timestamp: '2026-11-05T10:00:00Z' }, { timestamp: '2026-11-03T10:00:00Z' }] }), '2026-11-02T10:00:00Z');
  assert.equal(sinceOf({}, '2026-11-10T00:00:00Z'), '2026-11-09T00:00:00Z');
  assert.equal(sinceOf({}, null, new Date('2026-12-31T00:00:00Z')), '2026-12-01T00:00:00Z');
});
