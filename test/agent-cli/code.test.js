// code:create-branch, code:create-worktree, merge-request:create and
// code:take-out-of-draft-mode — the ticket's branch, worktree and draft merge
// request in the project's workspace, a real git checkout with a local
// origin; glab replaced by a fake on PATH that logs what it was asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';
import { fakeVm } from '../support/fake-vm.js';
import { engineDir } from '../support/engine-walk.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The fixture with a workspace: a clone (on master, one commit) of a bare origin, named as project p's local-pc environment; and a fake glab on PATH,
// logged in until logOut() (glab auth status then fails, as on an expired login).
function workspace() {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  const origin = join(dir, 'origin.git'), ws = join(dir, 'workspace'), bin = join(dir, 'bin');
  execFileSync('git', ['init', '--bare', '--initial-branch=master', origin], { stdio: 'ignore' });
  execFileSync('git', ['clone', '--quiet', origin, ws], { stdio: 'ignore' });
  git(ws, 'config', 'user.email', 't@example.com'); git(ws, 'config', 'user.name', 'T');
  writeFileSync(join(ws, 'README.md'), 'hi\n');
  git(ws, 'add', '.'); git(ws, 'commit', '-q', '-m', 'first'); git(ws, 'push', '-q', '-u', 'origin', 'master');
  git(ws, 'remote', 'set-head', 'origin', 'master');
  git(ws, 'remote', 'set-url', 'origin', 'git@gitlab.com:group/project.git');          // as GitLab names it; pushes go to the bare repo below
  git(ws, 'remote', 'set-url', '--push', 'origin', origin);
  git(ws, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  mkdirSync(bin);
  writeFileSync(join(bin, 'glab'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(dir, 'glab.log')}"\ncase "$1 $2" in\n  "auth status") if [ -e "${join(dir, 'logged-out')}" ]; then echo 'oauth2: "invalid_grant" token expired' >&2; exit 1; fi ;;\n  "mr list") cat "${join(dir, 'mr-list.json')}" 2>/dev/null || echo '[]' ;;\n  "mr view") cat "${join(dir, 'mr-view.json')}" ;;\n  "mr create") pwd -P > "${join(dir, 'mr-create-cwd')}"; echo 'Creating draft merge request for change/ABC-3 into master in group/project'; echo 'https://gitlab.com/group/project/-/merge_requests/42' ;;\n  "api projects/group%2Fproject/repository/branches/change%2FABC-3") if [ -e "${join(dir, 'branch-seen')}" ]; then echo '{"name":"change/ABC-3"}'; else touch "${join(dir, 'branch-seen')}"; echo '{"message":"404 Branch Not Found"}' >&2; exit 1; fi ;;\n  "api projects/group%2Fproject") echo '{"default_branch":"master"}' ;;\n  *) exit 0 ;;\nesac\n`);
  chmodSync(join(bin, 'glab'), 0o755);
  // The network stubbed (ASS-74): git's ssh to the origin's forge fails at once, which the scripts tolerate, instead of reaching it.
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(dir, 'ssh.log')}"\necho "ssh: no network in the tests" >&2\nexit 255\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
  const project = JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'project.json'), 'utf8'));
  writeFileSync(join(f.dir, 'projects', 'p', 'project.json'), JSON.stringify({ ...project, 'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: ws }] }));
  const env = { ...f.env, PATH: `${bin}:${process.env.PATH}`, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  // Pushes land in the bare origin; the fetch from the ssh url goes to the stub.
  const agent = (...args) => run(AGENT, args, { env });
  return { ...f, ws, origin, tmp: dir, env, agent, logOut: () => writeFileSync(join(dir, 'logged-out'), ''), glabLog: () => (existsSync(join(dir, 'glab.log')) ? readFileSync(join(dir, 'glab.log'), 'utf8').trim().split('\n') : []) };
}
test('code:create-branch makes change/<KEY> from origin\'s default branch, records it on the variation, and reuses one already there in any case', async () => {
  const f = workspace();
  const { stdout } = await f.agent('code:create-branch', 'p', 'abc-3', 'A');
  assert.deepEqual(JSON.parse(stdout), { branch: 'change/ABC-3', created: true });
  assert.equal(git(f.ws, 'rev-parse', 'change/ABC-3'), git(f.ws, 'rev-parse', 'origin/master'));
  assert.deepEqual(f.variation('A').build, { branch: 'change/ABC-3', 'branch-url': 'https://gitlab.com/group/project/-/tree/change/ABC-3' });
  const again = JSON.parse((await f.agent('code:create-branch', 'p', 'ABC-3', 'A')).stdout);
  assert.deepEqual(again, { branch: 'change/ABC-3', created: false });
  // A variation other than A gets its own branch; a branch in another case is the same branch.
  git(f.ws, 'branch', 'change/abc-3.b', 'master');
  assert.deepEqual(JSON.parse((await f.agent('code:create-branch', 'p', 'ABC-3', 'B')).stdout), { branch: 'change/abc-3.b', created: false });
  assert.equal(f.variation('B').build.branch, 'change/abc-3.b');
});

test('code:create-worktree adds .worktrees/<KEY> on the branch, excluded from git, and records it; it needs the branch first and keeps a worktree already there', async () => {
  const f = workspace();
  await fails(f.agent('code:create-worktree', 'p', 'ABC-3', 'A'), /no branch yet/);
  await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
  const folder = join(f.ws, '.worktrees', 'ABC-3');
  assert.deepEqual(JSON.parse((await f.agent('code:create-worktree', 'p', 'ABC-3', 'A')).stdout), { worktree: 'ABC-3', folder, created: true });
  assert.equal(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3');
  assert.equal(git(f.ws, 'check-ignore', '.worktrees'), '.worktrees');
  assert.deepEqual(f.variation('A').build, { branch: 'change/ABC-3', 'branch-url': 'https://gitlab.com/group/project/-/tree/change/ABC-3', worktree: 'ABC-3', 'worktree-folder': folder });
  assert.deepEqual(JSON.parse((await f.agent('code:create-worktree', 'p', 'ABC-3', 'A')).stdout), { worktree: 'ABC-3', folder, created: false });
  await fails(f.agent('code:create-worktree', 'p', 'ABC-9', 'A'), /no ABC-9/);
});

// project.json's worktree-setup, merged into p's project.json.
function withSetup(f, command) {
  const file = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'worktree-setup': command }));
}

test('code:create-worktree runs the project\'s worktree-setup in a worktree it creates, not in one already there', async () => {
  const f = workspace();
  withSetup(f, 'pwd >> setup.log');
  await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
  const folder = join(f.ws, '.worktrees', 'ABC-3');
  await f.agent('code:create-worktree', 'p', 'ABC-3', 'A');
  assert.equal(readFileSync(join(folder, 'setup.log'), 'utf8'), `${folder}\n`);
  await f.agent('code:create-worktree', 'p', 'ABC-3', 'A');
  assert.equal(readFileSync(join(folder, 'setup.log'), 'utf8').split('\n').length, 2);
});

test('code:create-worktree fails when worktree-setup fails, recording nothing and removing the worktree, so a retry sets it up afresh', async () => {
  const f = workspace();
  withSetup(f, 'echo "401 Unauthorized" >&2; exit 1');
  await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
  const folder = join(f.ws, '.worktrees', 'ABC-3');
  await fails(f.agent('code:create-worktree', 'p', 'ABC-3', 'A'), /worktree-setup failed[\s\S]*401 Unauthorized/);
  assert.equal(existsSync(folder), false);
  assert.equal(f.variation('A').build.worktree, undefined);
  withSetup(f, 'touch ready');
  await f.agent('code:create-worktree', 'p', 'ABC-3', 'A');
  assert.equal(existsSync(join(folder, 'ready')), true);
});

test('merge-request:create pushes the branch (with a first commit when it has none) and opens a draft titled "<KEY>: <title>" with the ticket link, recording it; an open one is reused; the draft is lifted by code:take-out-of-draft-mode', async () => {
  const f = workspace();
  await fails(f.agent('merge-request:create', 'p', 'ABC-3', 'A'), /no worktree yet/);
  await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
  await f.agent('code:create-worktree', 'p', 'ABC-3', 'A');
  const sprint = f.sprint();
  sprint.features[0].title = 'Close the account'; sprint.features[0].url = 'https://jira.example.com/browse/ABC-3';
  writeFileSync(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(sprint));
  const { stdout } = await f.agent('merge-request:create', 'p', 'ABC-3', 'A');
  assert.deepEqual(JSON.parse(stdout), { iid: 42, url: 'https://gitlab.com/group/project/-/merge_requests/42', created: true });
  assert.equal(git(f.origin, 'rev-parse', '--verify', 'refs/heads/change/ABC-3').length, 40);          // pushed
  assert.equal(git(f.origin, 'log', '-1', '--format=%s', 'change/ABC-3'), 'ABC-3: start');             // the first commit, so the request has something to show
  assert.deepEqual(f.glabLog(), [
    'auth status',                                                         // logged in (ASS-54): asked once, first
    'api projects/group%2Fproject/repository/branches/change%2FABC-3',      // not there yet: asked again, two seconds later
    'api projects/group%2Fproject/repository/branches/change%2FABC-3',
    'mr list --repo group/project --source-branch change/ABC-3 -F json',
    'mr create --repo group/project --source-branch change/ABC-3 --target-branch master --title ABC-3: Close the account --description > [ABC-3](https://jira.example.com/browse/ABC-3) --draft --yes',
  ]);
  assert.deepEqual(f.variation('A')['merge-request'], [{ key: '!42', 'build-status': 'Pending', url: 'https://gitlab.com/group/project/-/merge_requests/42', status: 'Open' }]);
  // glab mr create takes its GitLab host from the cwd's remotes, so it runs in the worktree, not the caller's checkout.
  assert.equal(readFileSync(join(f.tmp, 'mr-create-cwd'), 'utf8').trim(), git(join(f.ws, '.worktrees', 'ABC-3'), 'rev-parse', '--show-toplevel'));
  // Open already: reused, nothing created.
  writeFileSync(join(f.tmp, 'mr-list.json'), JSON.stringify([{ iid: 42, state: 'opened', web_url: 'https://gitlab.com/group/project/-/merge_requests/42' }]));
  assert.deepEqual(JSON.parse((await f.agent('merge-request:create', 'p', 'ABC-3', 'A')).stdout), { iid: 42, url: 'https://gitlab.com/group/project/-/merge_requests/42', created: false });
  assert.equal(f.glabLog().filter(l => /^mr create/.test(l)).length, 1);
  // Out of draft.
  assert.deepEqual(JSON.parse((await f.agent('code:take-out-of-draft-mode', 'p', 'ABC-3', 'A')).stdout), { iid: 42, ready: true });
  assert.equal(f.glabLog().at(-1), 'mr update 42 --repo group/project --ready');
  await fails(f.agent('code:take-out-of-draft-mode', 'p', 'ABC-3', 'B'), /no merge request/);
});

test('ASS-54: with glab not authenticated, merge-request:create and code:take-out-of-draft-mode fail at once saying so, running nothing past glab auth status', async () => {
  const f = workspace();
  await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
  await f.agent('code:create-worktree', 'p', 'ABC-3', 'A');
  f.logOut();
  await fails(f.agent('merge-request:create', 'p', 'ABC-3', 'A'), /merge-request:create: glab is not authenticated/);
  assert.deepEqual(f.glabLog(), ['auth status']);
  assert.deepEqual(f.variation('A')['merge-request'] ?? [], []);
  const sprint = f.sprint();
  sprint.features[0].variations[0]['merge-request'] = [{ key: '!42', 'build-status': 'Pending', url: 'https://gitlab.com/group/project/-/merge_requests/42', status: 'Open' }];
  writeFileSync(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(sprint));
  await fails(f.agent('code:take-out-of-draft-mode', 'p', 'ABC-3', 'A'), /code:take-out-of-draft-mode: glab is not authenticated/);
  assert.deepEqual(f.glabLog(), ['auth status', 'auth status']);
});

test('code:checkout-in-workspace detaches the workspace at the branch (the worktree keeps it) and records it and where the workspace was; refused while the workspace is dirty; code:release-workspace puts it back there', async () => {
  const f = workspace();
  await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
  await f.agent('code:create-worktree', 'p', 'ABC-3', 'A');
  const folder = join(f.ws, '.worktrees', 'ABC-3');
  const environment = () => JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'project.json'), 'utf8'))['local-environments'][0];
  const project = () => environment()['active-branch'];
  const before = git(f.ws, 'rev-parse', '--abbrev-ref', 'HEAD');
  writeFileSync(join(f.ws, 'README.md'), 'changed\n');
  await fails(f.agent('code:checkout-in-workspace', 'p', 'ABC-3', 'A'), /uncommitted changes/);
  git(f.ws, 'checkout', '--', 'README.md');
  git(folder, 'commit', '-q', '--allow-empty', '-m', 'work on the branch');
  assert.deepEqual(JSON.parse((await f.agent('code:checkout-in-workspace', 'p', 'ABC-3', 'A')).stdout), { branch: 'change/ABC-3' });
  assert.equal(git(f.ws, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');                    // detached…
  assert.equal(git(f.ws, 'rev-parse', 'HEAD'), git(folder, 'rev-parse', 'change/ABC-3'));  // …at the branch's commit
  assert.equal(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3');          // the worktree keeps the branch
  assert.equal(project(), 'change/ABC-3');
  assert.equal(environment()['return-to'], before);                                         // where it was, to go back to
  assert.deepEqual(JSON.parse((await f.agent('code:checkout-in-workspace', 'p', 'ABC-3', 'A')).stdout), { branch: 'change/ABC-3' });   // again: fine
  assert.equal(environment()['return-to'], before);                                         // still where it was before the first
  writeFileSync(join(f.ws, 'README.md'), 'changed\n');
  await fails(f.agent('code:release-workspace', 'p', 'ABC-3', 'A'), /uncommitted changes/);  // never discards work…
  assert.equal(project(), 'change/ABC-3');                                                  // …and changes nothing
  git(f.ws, 'checkout', '--', 'README.md');
  assert.deepEqual(JSON.parse((await f.agent('code:release-workspace', 'p', 'ABC-3', 'A')).stdout), { released: true });
  assert.equal(git(f.ws, 'rev-parse', '--abbrev-ref', 'HEAD'), before);                    // back on its branch, not detached
  assert.equal(project(), null);
  assert.equal(environment()['return-to'], null);
  assert.deepEqual(JSON.parse((await f.agent('code:release-workspace', 'p', 'ABC-3', 'A')).stdout), { released: false });
  // The worktree is linked by relative paths, so it is a worktree from wherever the repo is mounted.
  assert.match(readFileSync(join(folder, '.git'), 'utf8'), /^gitdir: \.\.\/\.\.\/\.git\/worktrees\/ABC-3/);
  await fails(f.agent('code:checkout-in-workspace', 'p', 'ABC-3', 'B'), /no branch yet/);
});

test('code:checkout-in-workspace has one holder at a time (ASS-173): of two variations claiming it at once one wins, the other refused, changing nothing; a release by the variation not holding it is a no-op', async () => {
  const f = workspace();
  for (const v of ['A', 'B']) { await f.agent('code:create-branch', 'p', 'ABC-3', v); await f.agent('code:create-worktree', 'p', 'ABC-3', v); }
  const environment = () => JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'project.json'), 'utf8'))['local-environments'][0];
  const before = git(f.ws, 'rev-parse', '--abbrev-ref', 'HEAD');
  const claims = await Promise.allSettled(['A', 'B'].map(v => f.agent('code:checkout-in-workspace', 'p', 'ABC-3', v)));
  const won = claims.filter(c => c.status === 'fulfilled'), lost = claims.filter(c => c.status === 'rejected');
  assert.equal(won.length, 1); assert.equal(lost.length, 1);
  const holder = JSON.parse(won[0].value.stdout).branch;
  assert.match(lost[0].reason.stderr, new RegExp(`the workspace is held by ${holder}`));
  assert.equal(environment()['active-branch'], holder);
  assert.equal(environment()['return-to'], before);
  assert.equal(git(f.ws, 'rev-parse', 'HEAD'), git(f.ws, 'rev-parse', holder));                // the loser never moved it
  const other = holder === 'change/ABC-3' ? 'B' : 'A';
  assert.deepEqual(JSON.parse((await f.agent('code:release-workspace', 'p', 'ABC-3', other)).stdout), { released: false });
  assert.equal(environment()['active-branch'], holder);                                          // the holder keeps it
  assert.equal(git(f.ws, 'rev-parse', 'HEAD'), git(f.ws, 'rev-parse', holder));
  await fails(f.agent('code:checkout-in-workspace', 'p', 'ABC-3', other), /held by/);           // still refused
  await f.agent('code:release-workspace', 'p', 'ABC-3', other === 'A' ? 'B' : 'A');
  await f.agent('code:checkout-in-workspace', 'p', 'ABC-3', other);                              // free again: the other takes it
  assert.notEqual(environment()['active-branch'], holder);
});

// The workspace fixture with ABC-3 A's merge request recorded as !42, and GitLab's view of it as given.
function withMergeRequest(view) {
  const f = workspace();
  const file = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  sprint.features[0].variations[0]['merge-request'] = [{ key: '!42', 'build-status': 'Pending', url: 'https://gitlab.com/group/project/-/merge_requests/42' }];
  writeFileSync(file, JSON.stringify(sprint, null, 4));
  const show = v => writeFileSync(join(f.tmp, 'mr-view.json'), JSON.stringify({ state: 'opened', has_conflicts: false, detailed_merge_status: 'mergeable', blocking_discussions_resolved: true, merge_when_pipeline_succeeds: false, head_pipeline: { status: 'success' }, ...v }));
  show(view);
  return { ...f, show };
}

test('merge-request:check reports from GitLab what needs an agent — open threads, a failed build, a needed rebase — and whether auto-merge is set; a merged one needs nothing', async () => {
  const f = withMergeRequest({});
  const check = async () => JSON.parse((await f.agent('merge-request:check', 'p', 'abc-3', 'A')).stdout);
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false });
  assert.equal(f.glabLog().at(-1), 'mr view 42 --repo group/project -F json');
  f.show({ blocking_discussions_resolved: false, head_pipeline: { status: 'failed' }, has_conflicts: true, merge_when_pipeline_succeeds: true });
  assert.deepEqual(await check(), { 'needs-attention': true, reasons: ['open-threads', 'build-failed', 'needs-rebase'], 'auto-merge': true, merged: false });
  f.show({ detailed_merge_status: 'need_rebase', head_pipeline: null });
  assert.deepEqual((await check()).reasons, ['needs-rebase']);
  f.show({ state: 'merged', head_pipeline: { status: 'failed' } });
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: true });
});

test('merge-request:ensure-auto-merge sets auto-merge with glab when it is off, and does nothing when it is on or the merge request is merged', async () => {
  const f = withMergeRequest({});
  assert.deepEqual(JSON.parse((await f.agent('merge-request:ensure-auto-merge', 'p', 'ABC-3', 'A')).stdout), { iid: 42, 'auto-merge': true });
  assert.equal(f.glabLog().at(-1), 'mr merge 42 --repo group/project --auto-merge --yes');
  for (const view of [{ merge_when_pipeline_succeeds: true }, { state: 'merged' }]) {
    f.show(view);
    const before = f.glabLog().length;
    await f.agent('merge-request:ensure-auto-merge', 'p', 'ABC-3', 'A');
    assert.deepEqual(f.glabLog().slice(before), ['auth status', 'mr view 42 --repo group/project -F json']);   // looked, merged nothing
  }
});

test('merge-request:check and :ensure-auto-merge fail without a merge request, or on a bad usage', async () => {
  const f = workspace();
  await fails(f.agent('merge-request:check', 'p', 'ABC-3', 'A'), /ABC-3 A has no merge request/);
  await fails(f.agent('merge-request:ensure-auto-merge', 'p', 'ABC-3', 'A'), /ABC-3 A has no merge request/);
  await fails(f.agent('merge-request:check', 'p', 'ABC-3'), /usage/);
});

test('merge-request:check reads each merge request created, past one only planned (ASS-80); while every one is only planned there is nothing to read, and nothing is merged (ASS-81)', async () => {
  const f = withMergeRequest({});
  const file = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  const planned = { id: 1, repository: 'https://gitlab.com/group/project', branch: 'change/ABC-3-1', contents: 'c', 'depends-on': [], status: 'Not Created', key: null, url: null, 'build-status': null };
  sprint.features[0].variations[0]['merge-request'].unshift(planned);
  writeFileSync(file, JSON.stringify(sprint));
  await f.agent('merge-request:check', 'p', 'ABC-3', 'A');
  assert.deepEqual(f.glabLog().filter(l => /^mr /.test(l)), ['mr view 42 --repo group/project -F json']);
  sprint.features[0].variations[0]['merge-request'] = [planned];
  writeFileSync(file, JSON.stringify(sprint));
  assert.deepEqual(JSON.parse((await f.agent('merge-request:check', 'p', 'ABC-3', 'A')).stdout), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false });
  assert.equal(f.variation('A')['merge-request'][0].base, 'master');
});

// A test command's condition for passing on master — its baseline run (ASS-99), in the worktree switched to master's commit — and failing on the branch (withTests puts the branch a commit ahead).
const ON_MASTER = '[ "$(git rev-parse --abbrev-ref HEAD)" = HEAD ]';

// The workspace fixture with ABC-3 A's worktree made, and its automated tests as given in its ticket folder.
async function withTests(tests, f = workspace()) {
  await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
  await f.agent('code:create-worktree', 'p', 'ABC-3', 'A');
  git(join(f.ws, '.worktrees', 'ABC-3'), 'commit', '-q', '--allow-empty', '-m', 'the change');   // the branch a commit ahead of master
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  mkdirSync(folder, { recursive: true });
  if (tests !== undefined) writeFileSync(join(folder, 'automated-tests-A.json'), JSON.stringify(tests));
  return { ...f, folder, worktree: join(f.ws, '.worktrees', 'ABC-3'), results: () => readFileSync(join(folder, 'automated-test-results-A.md'), 'utf8') };
}

test('automated-tests:verify-exist-and-runnable runs each test\'s list command in the worktree: every one must succeed and find a test; the tests may fail', async () => {
  const f = await withTests([{ list: 'pwd -P > where.txt && echo api.spec.ts', run: 'exit 1' }, { list: 'echo web.spec.ts', run: 'exit 1' }]);
  const { stdout } = await f.agent('automated-tests:verify-exist-and-runnable', 'p', 'abc-3', 'A');
  assert.deepEqual(JSON.parse(stdout), { tests: 2, listed: ['api.spec.ts', 'web.spec.ts'] });
  assert.equal(readFileSync(join(f.worktree, 'where.txt'), 'utf8').trim(), execFileSync('realpath', [f.worktree], { encoding: 'utf8' }).trim());
  for (const [tests, message] of [
    [undefined, /no automated-tests-A\.json/], [[{ list: 'echo a' }], /lists no tests/],
    [[{ list: 'exit 3', run: 'true' }], /list command failed \(exit 3\): exit 3/], [[{ list: 'true', run: 'true' }], /found no test: true/],
  ]) {
    const g = await withTests(tests);
    await fails(g.agent('automated-tests:verify-exist-and-runnable', 'p', 'ABC-3', 'A'), message);
  }
});

// ASS-49: a manual-only test plan records [] — a deliberate "no automated tests", not a missing file.
test('a recorded [] — a manual-only test plan — passes both automated-tests gates with no tests; a missing file still fails', async () => {
  const f = await withTests([]);
  assert.deepEqual(JSON.parse((await f.agent('automated-tests:verify-exist-and-runnable', 'p', 'ABC-3', 'A')).stdout), { tests: 0, listed: [] });
  assert.deepEqual(JSON.parse((await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A')).stdout), { passed: 0, failed: 0 });
  const g = await withTests(undefined);
  await fails(g.agent('automated-tests:verify-exist-and-runnable', 'p', 'ABC-3', 'A'), /no automated-tests-A\.json/);
  await fails(g.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), /no automated-tests-A\.json/);
});

// ASS-162: the list missing — a step's output lost — is its own exit, 4, so the engine sends the ticket back to Generate Automated Tests.
test('automated-tests:verify-success exits 4 when the automated-tests list is missing, not 1 (tests failed) or 3 (could not run)', async () => {
  const g = await withTests(undefined);
  await assert.rejects(g.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), e => e.code === 4 && /no automated-tests-A\.json/.test(e.stderr));
});

test('automated-tests:verify-success runs every test\'s run command in the worktree, all of them, and passes only when each exits 0; the results go to the ticket folder for the next agent', async () => {
  const f = await withTests([{ list: 'echo a', run: 'echo ran a' }, { list: 'echo b', run: `${ON_MASTER} || { echo b broke >&2; exit 2; }` }, { list: 'echo c', run: 'echo ran c' }]);
  await fails(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), /1 of 3 failed/);
  assert.match(f.results(), /## ✗ .* \(exit 2\)\n\nNew failures, not failing on master, and failing again on a re-run:\n- the command exits 2, and 0 on master\n\n```\nb broke\n```/);
  assert.match(f.results(), /## ✓ echo ran c \(exit 0\)\n\n```\nran c\n```/);              // it ran on past the failure
  const g = await withTests([{ list: 'echo a', run: 'echo ok' }]);
  assert.deepEqual(JSON.parse((await g.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A')).stdout), { passed: 1, failed: 0 });
});

// ASS-241 AC5: the run's tally goes on the variation's local-testing, for the "x/y automated tests" line (testCounts).
test('ASS-241 AC5: automated-tests:verify-success records the variation\'s number-of-relevant-automated-tests and number-of-passing-relevant-automated-tests from its run, red or green', async () => {
  const counts = f => { const t = f.variation('A')['local-testing'] ?? {}; return [t['number-of-passing-relevant-automated-tests'], t['number-of-relevant-automated-tests']]; };
  const f = await withTests([{ list: 'echo a', run: 'echo ran a' }, { list: 'echo b', run: `${ON_MASTER} || { echo b broke >&2; exit 2; }` }, { list: 'echo c', run: 'echo ran c' }]);
  await fails(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), /1 of 3 failed/);
  assert.deepEqual(counts(f), [2, 3]);
  assert.equal(f.variation('B')['local-testing'], undefined);
  const g = await withTests([{ list: 'echo a', run: 'echo ok' }]);
  await g.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A');
  assert.deepEqual(counts(g), [1, 1]);
  const h = await withTests([]);
  await h.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A');
  assert.deepEqual(counts(h), [0, 0]);
});

test('automated-tests:verify-success exits 3 — not failed tests — when a test command could not run: not found, not executable, or its dependencies missing', async () => {
  for (const run of ['no-such-runner --all', 'echo "ERR_PNPM_VERIFY_DEPS_BEFORE_RUN  Cannot check whether dependencies are outdated" >&2; exit 1', "echo \"Error: Cannot find module 'vitest'\" >&2; exit 1", 'echo \'Command "nx" not found\' >&2; exit 1',   // pnpm's own words for a missing bin
    'echo "Error: Could not load the default credentials." >&2; exit 1', 'echo "botocore.exceptions.NoCredentialsError: Unable to locate credentials" >&2; exit 1']) {   // ASS-99: a credential missing is the environment's, not the code's
    const f = await withTests([{ list: 'echo a', run: 'echo ran a' }, { list: 'echo b', run }]);
    const e = await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A').then(() => null, error => error);
    assert.equal(e?.code, 3, run);
    assert.match(e.stderr, /could not run 1 of 2: an environment problem, not failed tests/, run);
    assert.match(f.results(), /## ⚠ .* \(exit \d+: could not run\)/, run);
  }
  const failing = await withTests([{ list: 'echo b', run: `${ON_MASTER} || { echo b broke >&2; exit 1; }` }]);
  assert.equal((await failing.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A').then(() => null, error => error))?.code, 1);   // a test that ran and failed: still 1
});

// ASS-320: a failing command whose only NOT_RUNNABLE hit is a test runner's own
// result line (a passing ✔ test name that holds "is not running") is runnable —
// it goes to the master comparison and is reported as a failure, not "could not
// run"; a real environment error sharing the output is still not runnable.
test('ASS-320 AC1, AC2: a passing test name matching NOT_RUNNABLE (a ✔ "… is not running …" line) does not make a red command "could not run"; a real error after such a line still does', async () => {
  // AC1: a ✔ result line then a branch-only failure → runnable, master comparison runs, ## ✗ (exit 1), not ## ⚠ could not run, not exit 3.
  const pass = await withTests([{ list: 'echo a', run: 'echo ran a' }, { list: 'echo b', run: `echo "✔ ASS-159 AC1, AC2: a step whose VM is not running gets no agent (1.2ms)"; ${ON_MASTER} || { echo "b broke" >&2; exit 1; }` }]);
  const e1 = await pass.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A').then(() => null, error => error);
  assert.equal(e1?.code, 1);                                            // a test that ran and failed, not exit 3
  assert.match(e1.stderr, /1 of \d+ failed/);
  assert.doesNotMatch(e1.stderr, /could not run/);
  assert.match(pass.results(), /## ✗ .*\(exit 1\)/);                    // master comparison ran, new failure reported
  assert.doesNotMatch(pass.results(), /## ⚠ .*could not run/);
  // AC2: a ✔ result line followed by a real environment error → still not runnable (exit 3, could not run).
  for (const run of ['echo "✔ ok (1ms)"; echo "bash: foo: command not found" >&2; exit 1', 'echo "✔ ok (1ms)"; echo "Error: No such container: x" >&2; exit 1']) {
    const err = await withTests([{ list: 'echo a', run: 'echo ran a' }, { list: 'echo b', run }]);
    const e = await err.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A').then(() => null, error => error);
    assert.equal(e?.code, 3, run);
    assert.match(e.stderr, /could not run 1 of 2: an environment problem, not failed tests/, run);
    assert.match(err.results(), /## ⚠ .* \(exit \d+: could not run\)/, run);
  }
});

// ASS-99: tap.txt committed on master (and pushed: origin/master), ABC-3 A's
// worktree on its branch with tap.txt as given committed there, and one test
// whose run prints tap.txt and fails when it holds a "not ok" — each run
// logging, outside the worktree, the branch it ran on (HEAD: master's commit).
async function againstMaster(masterTap, branchTap, run = 'cat tap.txt; ! grep -q "^not ok" tap.txt') {
  const f = workspace();
  writeFileSync(join(f.ws, 'tap.txt'), masterTap);
  git(f.ws, 'add', '.'); git(f.ws, 'commit', '-q', '-m', 'tap'); git(f.ws, 'push', '-q', 'origin', 'master');
  const log = join(f.tmp, 'runs.log');
  const t = await withTests([{ list: 'echo t', run: `git rev-parse --abbrev-ref HEAD >> ${log}; ${run}` }], f);
  writeFileSync(join(t.worktree, 'tap.txt'), branchTap);
  git(t.worktree, 'commit', '-q', '-am', 'branch');
  const baseline = join(t.folder, 'automated-test-baseline-A.json');
  return { ...t, runs: () => readFileSync(log, 'utf8').trim().split('\n'), baseline: () => JSON.parse(readFileSync(baseline, 'utf8')), on: () => git(t.worktree, 'rev-parse', '--abbrev-ref', 'HEAD') };
}

test('ASS-99: a test red on master as on the branch, with only master\'s failures, passes — the pre-existing failures named in the results — and master\'s run is recorded by its SHA, run again only when master moves', async () => {
  const f = await againstMaster('x.sql ....... \n1..2\nok 1 - a\nnot ok 2 - b\n', 'x.sql ....... \n1..3\nok 1 - a\nok 2 - new\nnot ok 3 - b\n');
  assert.deepEqual(JSON.parse((await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A')).stdout), { passed: 1, failed: 0, 'pre-existing': ['x.sql: b'] });
  assert.deepEqual(f.runs(), ['change/ABC-3', 'HEAD']);                      // the branch, then master
  assert.equal(f.on(), 'change/ABC-3');                                       // and back
  assert.equal(f.baseline().master, git(f.ws, 'rev-parse', 'origin/master'));
  assert.match(f.results(), /## ✓ .* \(exit 1: every failure is one master has too\)\n\nPre-existing failures, failing on master too:\n- x\.sql: b\n/);
  await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A');
  assert.deepEqual(f.runs(), ['change/ABC-3', 'HEAD', 'change/ABC-3']);      // master's run kept
  writeFileSync(join(f.ws, 'other.txt'), 'x'); git(f.ws, 'add', '.'); git(f.ws, 'commit', '-q', '-m', 'moves'); git(f.ws, 'push', '-q', 'origin', 'master');
  await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A');
  assert.deepEqual(f.runs().slice(3), ['change/ABC-3', 'HEAD']);              // master moved: recorded again
  assert.equal(f.baseline().master, git(f.ws, 'rev-parse', 'origin/master'));
});

test('ASS-99 (AC2): EX-2402\'s run of example-shop-api-db-e2e (a synthetic one, fixtures/example-shop-api-db-e2e.txt), red only as master is, passes end to end, its 18 pre-existing failures in the results', async () => {
  const branch = readFileSync(new URL('./fixtures/example-shop-api-db-e2e.txt', import.meta.url), 'utf8');
  const master = branch.replace('\nok 217 - parity: search_result_browse.brand_names = product_overview.brand_names on a product that has brands\n', '\n')
    .replace(/(\/tests\/48_order_detail_api\.sql \.+ \n)1\.\.217\n/, '$11..216\n');
  const f = await againstMaster(master, branch, 'cat tap.txt; exit 1');
  const { stdout } = await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A');
  assert.equal(JSON.parse(stdout)['pre-existing'].length, 18);
  assert.match(f.results(), /- \/tests\/48_order_detail_api\.sql: order_document: a lines element carries exactly .* \(R6\/R10, EX-2373\)\n/);
  assert.equal(f.baseline().tests['git rev-parse --abbrev-ref HEAD >> ' + join(f.tmp, 'runs.log') + '; cat tap.txt; exit 1'].output, master);
});

test('ASS-99 (AC3): a test failing on the branch and not on master fails, after a re-run, named in the results', async () => {
  const f = await againstMaster('x.sql ....... \n1..2\nok 1 - a\nnot ok 2 - b\n', 'x.sql ....... \n1..2\nnot ok 1 - a\nnot ok 2 - b\n');
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 1, /1 of 1 failed/);
  assert.deepEqual(f.runs(), ['change/ABC-3', 'HEAD', 'change/ABC-3']);      // the branch, master, the branch again
  assert.match(f.results(), /## ✗ .* \(exit 1\)\n\nNew failures, not failing on master, and failing again on a re-run:\n- x\.sql: a\n/);
  assert.equal(f.on(), 'change/ABC-3');
});

test('ASS-99: a test that fails once and passes on its re-run passes', async () => {
  const flag = join(tmpdir(), `flaky-${process.pid}-${Date.now()}`);
  const f = await againstMaster('x.sql ....... \n1..1\nok 1 - a\n', 'x.sql ....... \n1..1\nok 1 - a\n# the branch\n',
    `if ! ${ON_MASTER} && [ ! -e ${flag} ]; then touch ${flag}; printf 'x.sql ....... \\n1..1\\nnot ok 1 - a\\n'; exit 1; fi; cat tap.txt`);
  assert.deepEqual(JSON.parse((await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A')).stdout), { passed: 1, failed: 0 });
  assert.deepEqual(f.runs(), ['change/ABC-3', 'HEAD', 'change/ABC-3']);
  assert.match(f.results(), /## ✓ .* \(exit 1: no new failure failed again on a re-run\)\n\n```\nx\.sql[^`]*not ok 1 - a\n```\n\n### Re-run \(exit 0\)\n\n```\nx\.sql/);
});

test('ASS-99: a command red on master and on the branch, its output naming no test, exits 3 for a human, the results holding both outputs', async () => {
  const f = await againstMaster('boom on master\n', 'boom on the branch\n', 'cat tap.txt; exit 1');
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 3, /1 of 1 red on master too, with no test results to compare: for a human/);
  assert.match(f.results(), /## ⚠ .* \(exit 1: red on master too, with no test results to compare\)\n\n```\nboom on the branch\n```\n\n### On master \(exit 1\)\n\n```\nboom on master\n```/);
});

test('ASS-99: a worktree with changes not committed is not switched to master: exit 3, everything left as it was', async () => {
  const f = await againstMaster('x.sql ....... \n1..1\nok 1 - a\n', 'x.sql ....... \n1..1\nnot ok 1 - a\n');
  writeFileSync(join(f.worktree, 'tap.txt'), 'x.sql ....... \n1..1\nnot ok 1 - a\n# uncommitted\n');
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 3, /could not run 1 of 1: an environment problem/);
  assert.match(f.results(), /## ⚠ .* \(exit 1: could not run master's tests: \. has changes not committed\)/);
  assert.deepEqual(f.runs(), ['change/ABC-3']);
  assert.equal(f.on(), 'change/ABC-3');
  assert.match(readFileSync(join(f.worktree, 'tap.txt'), 'utf8'), /# uncommitted/);
});

test('ASS-227 AC4: an untracked file does not stop the switch to master — a detached checkout leaves it be', async () => {
  const f = await againstMaster('x.sql ....... \n1..1\nok 1 - a\n', 'x.sql ....... \n1..1\nnot ok 1 - a\n');
  mkdirSync(join(f.worktree, '__pycache__'));
  writeFileSync(join(f.worktree, '__pycache__', 'x.pyc'), 'x');
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 1, /1 of 1 failed/);
  assert.deepEqual(f.runs(), ['change/ABC-3', 'HEAD', 'change/ABC-3']);
  assert.equal(f.on(), 'change/ABC-3');
  assert.ok(existsSync(join(f.worktree, '__pycache__', 'x.pyc')));
});

// ASS-227: againstMaster's one test, marked "reproduces": red on master by design.
function reproducing(f) {
  const file = join(f.folder, 'automated-tests-A.json');
  writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).map(t => ({ ...t, reproduces: true }))));
  return f;
}

test('ASS-227 AC2: a reproducing check red on master and still red on the branch, naming no test, failed — exit 1, for Generate Solution, not 3 — with no run on master', async () => {
  const f = reproducing(await againstMaster('boom on master\n', 'boom on the branch\n', 'cat tap.txt; exit 1'));
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 1, /1 of 1 failed/);
  assert.deepEqual(f.runs(), ['change/ABC-3', 'change/ABC-3']);              // the branch and its re-run: master's red is the bug
  assert.match(f.results(), /## ✗ .* \(exit 1\)\n\nNew failures, failing again on a re-run:\n- the command exits 1: the ticket's bug still reproduces\n/);
});

test('ASS-227 AC2: a reproducing check red on master and green on the branch passes', async () => {
  const f = reproducing(await againstMaster('boom on master\n', 'fixed\n', 'cat tap.txt; ! grep -q boom tap.txt'));
  assert.deepEqual(JSON.parse((await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A')).stdout), { passed: 1, failed: 0 });
});

test('a variation with a VM (ASS-74) has its tests listed and run in the VM, in /repos/, through limactl shell: no worktree or workspace needed', async () => {
  const f = workspace();
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'automated-tests-A.json'), JSON.stringify([{ list: 'pwd > where.txt; echo api.spec.ts', run: 'echo ran in "$(pwd)"' }]));
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  writeFileSync(sprint, readFileSync(sprint, 'utf8').replace('"name": "A",', '"name": "A", "vm": { "name": "abc-3-a", "ip": "192.168.64.9", "created-at": "2026-10-19T00:00:00Z" },'));
  const project = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(project, JSON.stringify({ ...JSON.parse(readFileSync(project, 'utf8')), 'local-environments': [], 'dev-container': 'devc' }));   // neither is used
  const vm = fakeVm(f.env);
  const agent = (...args) => run(AGENT, args, { env: vm.env });
  assert.deepEqual(JSON.parse((await agent('automated-tests:verify-exist-and-runnable', 'p', 'ABC-3', 'A')).stdout), { tests: 1, listed: ['api.spec.ts'] });
  assert.ok(existsSync(join(vm.root, 'repos', 'where.txt')));
  assert.deepEqual(JSON.parse((await agent('automated-tests:verify-success', 'p', 'ABC-3', 'A')).stdout), { passed: 1, failed: 0 });
  assert.match(readFileSync(join(folder, 'automated-test-results-A.md'), 'utf8'), /ran in .*\/repos/);
  assert.deepEqual(vm.calls().map(c => [c.vm, c.workdir, c.argv[0], c.argv[1]]), [['abc-3-a', '/repos/', 'bash', '-c'], ['abc-3-a', '/repos/', 'bash', '-c']]);
});

test('ASS-99: in a VM, master\'s run switches every repository in /repos/ not at master\'s commit to it and back, the baseline keyed by each one\'s SHA', async () => {
  const f = workspace();
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'automated-tests-A.json'), JSON.stringify([{ list: 'echo t', run: 'cd api && git rev-parse --abbrev-ref HEAD >> ../runs.log; cat tap.txt; ! grep -q "^not ok" tap.txt' }]));
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  writeFileSync(sprint, readFileSync(sprint, 'utf8').replace('"name": "A",', '"name": "A", "vm": { "name": "abc-3-a", "ip": "192.168.64.9", "created-at": "2026-10-19T00:00:00Z" },'));
  const vm = fakeVm(f.env);
  const repo = name => {   // /repos/<name> on master, origin/master its one commit
    const dir = join(vm.root, 'repos', name);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '--initial-branch=master', dir]);
    git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 'T');
    writeFileSync(join(dir, 'tap.txt'), '1..2\nok 1 - a\nnot ok 2 - b\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'first'); git(dir, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    return dir;
  };
  const api = repo('api'), web = repo('web');
  git(api, 'checkout', '-q', '-b', 'change/ABC-3');
  writeFileSync(join(api, 'tap.txt'), '1..3\nok 1 - a\nok 2 - new\nnot ok 3 - b\n'); git(api, 'commit', '-q', '-am', 'the change');
  const agent = (...args) => run(AGENT, args, { env: vm.env });
  assert.deepEqual(JSON.parse((await agent('automated-tests:verify-success', 'p', 'ABC-3', 'A')).stdout), { passed: 1, failed: 0, 'pre-existing': ['b'] });
  assert.equal(JSON.parse(readFileSync(join(folder, 'automated-test-baseline-A.json'), 'utf8')).master, `api@${git(api, 'rev-parse', 'origin/master')} web@${git(web, 'rev-parse', 'origin/master')}`);
  assert.deepEqual(readFileSync(join(vm.root, 'repos', 'runs.log'), 'utf8').trim().split('\n'), ['change/ABC-3', 'HEAD']);   // the branch, then master
  assert.equal(git(api, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3');
  assert.equal(git(web, 'rev-parse', '--abbrev-ref', 'HEAD'), 'master');
  assert.ok(vm.calls().every(c => c.vm === 'abc-3-a' && c.workdir === '/repos/'));
});

// ASS-329: the time limit on each test command run — project.json's
// automated-test-run-minutes (absent 30, null none) — set to a second or so;
// minutes() sets it (undefined removes it). A run past it is stopped with
// everything it started: sleeping() is a run command that starts a child,
// both logging their PIDs to pids(), and sleeps past the limit; gone(f)
// whether every one of them has exited.
function minutes(f, value) {
  const file = join(f.dir, 'projects', 'p', 'project.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (value === undefined) delete json['automated-test-run-minutes']; else json['automated-test-run-minutes'] = value;
  writeFileSync(file, JSON.stringify(json));
}
const sleeping = f => `echo started; sleep 30 & echo $! >> ${join(f.tmp, 'pids')}; echo $$ >> ${join(f.tmp, 'pids')}; sleep 30`;
const pids = f => readFileSync(join(f.tmp, 'pids'), 'utf8').trim().split('\n').map(Number);
const gone = f => pids(f).every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } });

test('ASS-329 AC1, AC2: a run past automated-test-run-minutes is stopped with everything it started — a failed run, not one that could not run — its results saying it timed out, with its output so far', async () => {
  const w = workspace();
  const f = await withTests([{ list: 'echo t', run: `${ON_MASTER} || { ${sleeping(w)}; }` }], w);
  minutes(f, 0.02);
  const started = Date.now();
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 1, /1 of 1 failed/);
  assert.ok(Date.now() - started < 20000);
  assert.equal(pids(f).length, 4);                                            // the branch's run and its re-run, each with its child
  assert.ok(gone(f));
  assert.match(f.results(), /## ✗ .* \(exit 124: timed out after 0\.02 minutes\)\n\nNew failures, not failing on master, and failing again on a re-run:\n- the command timed out after 0\.02 minutes; on master it finished \(exit 0\)\n\n```\nstarted\nautomated-tests:verify-success: timed out after 0\.02 minutes\n```\n\n### Re-run \(exit 124: timed out after 0\.02 minutes\)\n/);
});

test('ASS-329 AC2: a node --test run stopped at the limit names the file it was running', async () => {
  const f = workspace();
  const spec = join(f.tmp, 'hangs.test.js');
  writeFileSync(spec, "import test from 'node:test';\ntest('quick', () => {});\ntest('hangs', () => new Promise(r => setTimeout(r, 60000)));\n");
  const t = await withTests([{ list: 'echo t', run: `${ON_MASTER} || env -u NODE_TEST_CONTEXT node --test --test-reporter=spec ${spec}` }], f);
  minutes(t, 0.03);
  await exitsWith(t.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 1, /1 of 1 failed/);
  assert.match(t.results(), new RegExp(`\\(exit 124: timed out after 0\\.03 minutes, in ${spec}\\)\\n\\nNew failures[^\\n]*\\n- the command timed out after 0\\.03 minutes, in ${spec}; on master`));
  assert.match(t.results(), /✔ quick/);
});

test('ASS-329 AC3: a command timed out on master too exits 3 for a human, with both outputs; master\'s timed-out run is not kept, run again next time', async () => {
  const f = await againstMaster('master\n', 'branch\n', 'cat tap.txt; sleep 30');
  minutes(f, 0.02);
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 3, /1 of 1 red on master too/);
  assert.match(f.results(), /## ⚠ .* \(exit 124: timed out after 0\.02 minutes: timed out on master too, nothing to compare\)\n\n```\nbranch\nautomated-tests:verify-success: timed out after 0\.02 minutes\n```\n\n### On master \(exit 124: timed out after 0\.02 minutes\)\n\n```\nmaster\nautomated-tests:verify-success: timed out after 0\.02 minutes\n```/);
  assert.deepEqual(f.runs(), ['change/ABC-3', 'HEAD']);
  assert.equal(f.on(), 'change/ABC-3');
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 3);
  assert.deepEqual(f.runs(), ['change/ABC-3', 'HEAD', 'change/ABC-3', 'HEAD']);   // master's run again, not the timed-out one kept
});

test('ASS-329 AC1: automated-test-run-minutes absent is 30, null no limit; a value that is no number of minutes above 0 exits 3, running nothing', async () => {
  const f = await withTests([{ list: 'echo t', run: 'ps -ww -o command= -p $PPID | grep -o "seconds=[0-9.]*"; sleep 1.5; echo done' }]);
  assert.deepEqual(JSON.parse((await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A')).stdout), { passed: 1, failed: 0 });
  assert.match(f.results(), /seconds=1800\n/);
  minutes(f, 0.01);
  await assert.rejects(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'));
  assert.match(f.results(), /timed out after 0\.01 minutes/);
  minutes(f, null);
  assert.deepEqual(JSON.parse((await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A')).stdout), { passed: 1, failed: 0 });
  assert.doesNotMatch(f.results(), /^seconds=/m);                            // run as it is, with no limit around it
  const before = f.results();
  for (const bad of [0, -1, '30', 'x', true]) {
    minutes(f, bad);
    await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 3, /automated-test-run-minutes must be a number of minutes above 0, or null/);
  }
  assert.equal(f.results(), before);
});

test('ASS-329 AC1: in a VM, the limit stops the run and everything it started there', async () => {
  const f = workspace();
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'automated-tests-A.json'), JSON.stringify([{ list: 'echo t', run: sleeping(f), reproduces: true }]));
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  writeFileSync(sprint, readFileSync(sprint, 'utf8').replace('"name": "A",', '"name": "A", "vm": { "name": "abc-3-a", "ip": "192.168.64.9", "created-at": "2026-10-19T00:00:00Z" },'));
  minutes(f, 0.02);
  const vm = fakeVm(f.env);
  await exitsWith(run(AGENT, ['automated-tests:verify-success', 'p', 'ABC-3', 'A'], { env: vm.env }), 1, /1 of 1 failed/);
  assert.equal(pids(f).length, 4);
  assert.ok(gone(f));
  assert.match(readFileSync(join(folder, 'automated-test-results-A.md'), 'utf8'), /- the command timed out after 0\.02 minutes\n/);
});

test('the automated-testing step sends a test run that could not start (exit 3) to Blocked, not back to generate-solution', () => {
  const engine = JSON.parse(readFileSync(join(engineDir('example-development'), 'state-engine.json'), 'utf8'));   // the example project's own (ASS-277)
  const exits = engine.steps.find(s => s.id === 'automated-testing')['exit-events'];
  assert.deepEqual(exits.map(e => [e.condition, e['move-to-state']]), [[{ 'exit-code': 0 }, 'code-review'], [{ 'exit-code': 3 }, 'blocked'], [{ not: { 'exit-code': 0 } }, 'generate-solution']]);
});

// The workspace fixture with its origin on GitHub (as the harness's own repository is), and a fake gh on PATH beside the fake glab.
function onGitHub() {
  const f = workspace();
  git(f.ws, 'remote', 'set-url', 'origin', 'git@github.com:owner/repo.git');
  git(f.ws, 'remote', 'set-url', '--push', 'origin', f.origin);
  const bin = join(f.tmp, 'bin');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(f.tmp, 'gh.log')}"\ncase "$1 $2" in\n  "pr list") cat "${join(f.tmp, 'pr-list.json')}" 2>/dev/null || echo '[]' ;;\n  "pr create") echo 'https://github.com/owner/repo/pull/7' ;;\n  "pr view") cat "${join(f.tmp, 'pr-view.json')}" ;;\n  "pr merge") [ -e "${join(f.tmp, 'pr-merged.json')}" ] && cp "${join(f.tmp, 'pr-merged.json')}" "${join(f.tmp, 'pr-view.json')}"; exit 0 ;;\n  *) exit 0 ;;\nesac\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const view = v => writeFileSync(join(f.tmp, 'pr-view.json'), JSON.stringify({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', autoMergeRequest: null, statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }], ...v }));
  return { ...f, view, ghLog: () => (existsSync(join(f.tmp, 'gh.log')) ? readFileSync(join(f.tmp, 'gh.log'), 'utf8').trim().split('\n') : []) };
}

test('on a GitHub origin, code:create-branch records the branch\'s GitHub url, not GitLab\'s /-/tree/ one', async () => {
  const f = onGitHub();
  await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
  assert.equal(f.variation('A').build['branch-url'], 'https://github.com/owner/repo/tree/change/ABC-3');
});

test('on a GitHub origin, merge-request:create opens a draft pull request with gh (reusing an open one), recorded as #<number>; code:take-out-of-draft-mode marks it ready', async () => {
  const f = onGitHub();
  await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
  await f.agent('code:create-worktree', 'p', 'ABC-3', 'A');
  const { stdout } = await f.agent('merge-request:create', 'p', 'ABC-3', 'A');
  assert.deepEqual(JSON.parse(stdout), { iid: 7, url: 'https://github.com/owner/repo/pull/7', created: true });
  assert.ok(f.ghLog().includes('pr list --repo owner/repo --head change/ABC-3 --state open --json number,url'), f.ghLog().join('\n'));
  assert.ok(f.ghLog().some(l => /^pr create --repo owner\/repo --head change\/ABC-3 --base master --title ABC-3: .* --body > ABC-3: .* --draft$/.test(l)), f.ghLog().join('\n'));
  assert.deepEqual(f.variation('A')['merge-request'], [{ key: '#7', 'build-status': 'Pending', url: 'https://github.com/owner/repo/pull/7', status: 'Open' }]);
  assert.deepEqual(f.glabLog(), []);                                    // GitLab never asked
  assert.match(readFileSync(join(f.tmp, 'ssh.log'), 'utf8'), /git@github\.com/);   // the fetch went to the stub, not the network
  writeFileSync(join(f.tmp, 'pr-list.json'), JSON.stringify([{ number: 7, url: 'https://github.com/owner/repo/pull/7' }]));
  assert.equal(JSON.parse((await f.agent('merge-request:create', 'p', 'ABC-3', 'A')).stdout).created, false);   // reused
  await f.agent('code:take-out-of-draft-mode', 'p', 'ABC-3', 'A');
  assert.equal(f.ghLog().at(-1), 'pr ready 7 --repo owner/repo');
});

test('ASS-86 AC4: merge-request:create names an off-board ticket (its url a file://, or none) plain on the first line, "<KEY>: <title>", never linked to a file or to null', async () => {
  for (const url of ['file:///h/src/off-board/x/ABC-3.md', null]) {
    const f = onGitHub();
    await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
    await f.agent('code:create-worktree', 'p', 'ABC-3', 'A');
    const sprint = f.sprint();
    sprint.features[0].title = 'Close the account'; sprint.features[0].url = url;
    writeFileSync(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(sprint));
    await f.agent('merge-request:create', 'p', 'ABC-3', 'A');
    assert.ok(f.ghLog().some(l => l.endsWith('--body > ABC-3: Close the account --draft')), f.ghLog().join('\n'));
  }
});

test('on a GitHub origin, merge-request:merge marks the pull request ready and merges it itself, then confirms it merged; refused when it is not open or did not merge', async () => {
  const f = onGitHub();
  const file = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  sprint.features[0].variations[0]['merge-request'] = [{ key: '#7', 'build-status': 'Pending', url: 'https://github.com/owner/repo/pull/7' }];
  writeFileSync(file, JSON.stringify(sprint, null, 4));
  f.view({ state: 'OPEN' });
  writeFileSync(join(f.tmp, 'pr-merged.json'), JSON.stringify({ state: 'MERGED' }));         // what gh says once it has merged it
  assert.deepEqual(JSON.parse((await f.agent('merge-request:merge', 'p', 'ABC-3', 'A')).stdout), { iid: 7, merged: true });
  assert.ok(f.ghLog().includes('pr ready 7 --repo owner/repo'), f.ghLog().join('\n'));
  assert.ok(f.ghLog().includes('pr merge 7 --repo owner/repo --merge --delete-branch'), f.ghLog().join('\n'));
  assert.equal(f.variation('A')['merge-request'][0].status, 'Merged');
  const merges = f.ghLog().filter(l => /^pr merge/.test(l)).length;
  assert.equal((await f.agent('merge-request:merge', 'p', 'ABC-3', 'A')).stdout, '');           // merged already: a re-run merges nothing
  assert.equal(f.ghLog().filter(l => /^pr merge/.test(l)).length, merges);
  rmSync(join(f.tmp, 'pr-merged.json'));
  writeFileSync(file, JSON.stringify(sprint, null, 4));                                        // recorded unmerged again: Merged is never made Open (ASS-177)
  f.view({ state: 'OPEN' });                                                                   // gh said nothing went wrong, yet it is not merged
  await fails(f.agent('merge-request:merge', 'p', 'ABC-3', 'A'), /#7 is Open, not merged/);
  const g = onGitHub();
  await fails(g.agent('merge-request:merge', 'p', 'ABC-3', 'A'), /no merge request/);
  const lab = workspace();                                                                     // GitLab: not the harness's forge
  const labSprint = JSON.parse(readFileSync(join(lab.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8'));
  labSprint.features[0].variations[0]['merge-request'] = [{ key: '!42', 'build-status': 'Pending', url: 'https://gitlab.com/group/project/-/merge_requests/42' }];
  writeFileSync(join(lab.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(labSprint, null, 4));
  await fails(lab.agent('merge-request:merge', 'p', 'ABC-3', 'A'), /merges GitHub pull requests only/);
});

test('code:update-workspace fast-forwards the workspace to the default branch from origin, keeping local changes the update does not touch; refused, changing nothing, when it would overwrite one or the workspace is on another branch', async () => {
  const f = workspace();
  git(f.ws, 'remote', 'set-url', 'origin', f.origin);                                         // fetchable here
  const other = join(f.tmp, 'other');
  execFileSync('git', ['clone', '--quiet', f.origin, other], { stdio: 'ignore' });
  git(other, 'config', 'user.email', 't@example.com'); git(other, 'config', 'user.name', 'T');
  writeFileSync(join(other, 'code.js'), 'fixed\n');
  git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'merged elsewhere'); git(other, 'push', '-q', 'origin', 'master');
  writeFileSync(join(f.ws, 'README.md'), 'live data\n');                                     // the harness's data files change as it runs
  assert.deepEqual(JSON.parse((await f.agent('code:update-workspace', 'p')).stdout), { branch: 'master', head: git(other, 'rev-parse', 'HEAD') });
  assert.equal(git(f.ws, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
  assert.equal(readFileSync(join(f.ws, 'README.md'), 'utf8'), 'live data\n');               // kept
  writeFileSync(join(other, 'README.md'), 'theirs\n');
  git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'touches the live file'); git(other, 'push', '-q', 'origin', 'master');
  const before = git(f.ws, 'rev-parse', 'HEAD');
  await fails(f.agent('code:update-workspace', 'p'), /would be overwritten/);
  assert.deepEqual([git(f.ws, 'rev-parse', 'HEAD'), readFileSync(join(f.ws, 'README.md'), 'utf8')], [before, 'live data\n']);   // nothing changed
  git(f.ws, 'checkout', '--', 'README.md');
  git(f.ws, 'checkout', '-q', '-b', 'side');
  const onSide = git(f.ws, 'rev-parse', 'HEAD');
  await fails(f.agent('code:update-workspace', 'p'), /on side, not master/);
  assert.equal(git(f.ws, 'rev-parse', 'HEAD'), onSide);                                        // the branch guard runs before any fetch: HEAD unmoved
});

test('code:update-workspace never drops a local commit: with commits of its own not on origin, once origin has moved on it cannot fast-forward and is refused, the commit and its file kept', async () => {
  const f = workspace();
  git(f.ws, 'remote', 'set-url', 'origin', f.origin);
  const other = join(f.tmp, 'other');
  execFileSync('git', ['clone', '--quiet', f.origin, other], { stdio: 'ignore' });
  git(other, 'config', 'user.email', 't@example.com'); git(other, 'config', 'user.name', 'T');
  writeFileSync(join(other, 'code.js'), 'merged\n');
  git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'merged elsewhere'); git(other, 'push', '-q', 'origin', 'master');
  git(f.ws, 'config', 'user.email', 't@example.com'); git(f.ws, 'config', 'user.name', 'T');
  writeFileSync(join(f.ws, 'local.js'), 'mine\n');
  git(f.ws, 'add', 'local.js'); git(f.ws, 'commit', '-q', '-m', 'not pushed');
  const mine = git(f.ws, 'rev-parse', 'HEAD');
  await fails(f.agent('code:update-workspace', 'p'), /could not fast-forward/);
  assert.deepEqual([git(f.ws, 'rev-parse', 'HEAD'), readFileSync(join(f.ws, 'local.js'), 'utf8'), git(f.ws, 'status', '--porcelain')], [mine, 'mine\n', '']);
});

test('ASS-319 AC1: code:update-workspace survives a concurrent plain `git fetch origin` in the same workspace — 40 rounds, each exits 0 and lands that round\'s pushed SHA, so the shared-ref race no longer sends a merged ticket to Blocked', { timeout: 300_000 }, async () => {
  const f = workspace();
  git(f.ws, 'remote', 'set-url', 'origin', f.origin);                                         // fetchable here (as the two tests above)
  const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // A `git` put first on the CLI's PATH: on the workspace fetch/pull the command
  // is about to run, it first launches a plain `git fetch origin` in the
  // background, so the CLI's own fetch and the "other ticket's" plain fetch hit
  // the shared refs at the same instant (a naive start-both never races — the
  // CLI's startup outlasts a plain fetch). Same alignment as the ASS-318 race
  // test (merge-in-turn.test.js). The real git is called by absolute path, so
  // the wrapper does not recurse; only fetch/pull triggers the background fetch.
  const gitbin = join(f.tmp, 'gitbin');
  mkdirSync(gitbin);
  writeFileSync(join(gitbin, 'git'), `#!/usr/bin/env bash
real=${JSON.stringify(realGit)}
ws=${JSON.stringify(f.ws)}
sub=
for a in "$@"; do
  if [ -n "\${skip:-}" ]; then skip=; continue; fi
  case "$a" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path) skip=1 ;;
    --*=*|-*) : ;;
    *) sub="$a"; break ;;
  esac
done
if [ "$sub" = fetch ] || [ "$sub" = pull ]; then "$real" -C "$ws" fetch --quiet origin >/dev/null 2>&1 & bg=$!; fi
"$real" "$@"; code=$?
[ -n "\${bg:-}" ] && wait "$bg" 2>/dev/null
exit $code
`);
  chmodSync(join(gitbin, 'git'), 0o755);
  const env = { ...f.env, PATH: `${gitbin}:${f.env.PATH}` };
  const seed = join(f.tmp, 'seed');                                                            // a second clone that moves master every round
  execFileSync('git', ['clone', '--quiet', f.origin, seed], { stdio: 'ignore' });
  git(seed, 'config', 'user.email', 't@example.com'); git(seed, 'config', 'user.name', 'T');
  const update = async () => {
    try { await run(AGENT, ['code:update-workspace', 'p'], { env }); return { code: 0, err: '' }; }
    catch (e) { return { code: e.code ?? 1, err: String(e.stderr || '').trim() }; }
  };
  const failures = [];
  for (let round = 1; round <= 40; round++) {                                                  // a real ref move every round: a no-op fetch cannot race
    writeFileSync(join(seed, 'f.txt'), `round ${round}\n`);
    git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', `round ${round}`); git(seed, 'push', '-q', 'origin', 'master');
    const pushed = git(seed, 'rev-parse', 'HEAD');
    const r = await update();
    if (r.code !== 0) { failures.push(`round ${round}: exit ${r.code}: ${r.err}`); continue; }
    const head = git(f.ws, 'rev-parse', 'HEAD');
    if (head !== pushed) failures.push(`round ${round}: HEAD ${head} !== pushed ${pushed}`);
  }
  assert.deepEqual(failures, [], `update-workspace failed in ${failures.length} of 40 rounds`);
});

test('code:update-workspace exits 1, changing nothing, when it cannot fetch the default branch from origin (origin unreachable)', async () => {
  const f = workspace();                                                                       // origin left at the fixture's git@gitlab.com: url; the ssh stub makes it unreachable
  const before = git(f.ws, 'rev-parse', 'HEAD');
  await fails(f.agent('code:update-workspace', 'p'), /code:update-workspace:/);                // its own prefixed message, exit 1 (the new fetch-failure branch the fix adds)
  assert.equal(git(f.ws, 'rev-parse', 'HEAD'), before);                                        // HEAD unmoved
});

test('on a GitHub origin, merge-request:check reads the pull request with gh — changes requested, a failed check, conflicts or behind its base — and :ensure-auto-merge sets gh\'s auto-merge when it is off', async () => {
  const f = onGitHub();
  const file = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  sprint.features[0].variations[0]['merge-request'] = [{ key: '#7', 'build-status': 'Pending', url: 'https://github.com/owner/repo/pull/7' }];
  writeFileSync(file, JSON.stringify(sprint, null, 4));
  const check = async () => JSON.parse((await f.agent('merge-request:check', 'p', 'ABC-3', 'A')).stdout);
  f.view({});
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': false, merged: false });
  assert.equal(f.ghLog().at(-1), 'pr view 7 --repo owner/repo --json state,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,statusCheckRollup,baseRefName,title,isDraft');
  f.view({ reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }], mergeable: 'CONFLICTING', autoMergeRequest: { enabledAt: 'x' } });
  assert.deepEqual(await check(), { 'needs-attention': true, reasons: ['open-threads', 'build-failed', 'needs-rebase'], 'auto-merge': true, merged: false });
  f.view({ mergeStateStatus: 'BEHIND' });
  assert.deepEqual((await check()).reasons, ['needs-rebase']);
  f.view({ state: 'MERGED' });
  assert.deepEqual(await check(), { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: true });
  writeFileSync(file, JSON.stringify(sprint, null, 4));                // recorded unmerged again: Merged is never made Open (ASS-177)
  f.view({});
  assert.deepEqual(JSON.parse((await f.agent('merge-request:ensure-auto-merge', 'p', 'ABC-3', 'A')).stdout), { iid: 7, 'auto-merge': true });
  assert.equal(f.ghLog().at(-1), 'pr merge 7 --repo owner/repo --auto --merge');
  f.view({ autoMergeRequest: { enabledAt: 'x' } });
  await f.agent('merge-request:ensure-auto-merge', 'p', 'ABC-3', 'A');
  assert.match(f.ghLog().at(-1), /^pr view 7 /);                       // already on: looked, set nothing
});

test('every one fails, writing nothing, without a workspace or on a bad usage', async () => {
  const f = fixture();
  const before = f.snapshot();
  for (const command of ['code:create-branch', 'code:create-worktree', 'merge-request:create', 'code:checkout-in-workspace', 'code:release-workspace']) {
    await fails(f.agent(command, 'p', 'ABC-3', 'A'), /no local-pc environment/);
    await fails(f.agent(command, 'p', 'ABC-3'), /usage/);
  }
  // Planned merge requests need no workspace (ASS-81): with none recorded there is nothing to take out of draft.
  await fails(f.agent('code:take-out-of-draft-mode', 'p', 'ABC-3', 'A'), /ABC-3 A has no merge request/);
  await fails(f.agent('code:take-out-of-draft-mode', 'p', 'ABC-3'), /usage/);
  assert.equal(f.snapshot(), before);
});

// ASS-96 — a project with a dev-container runs worktree-setup and its tests
// there (in_project, code.bash). The fake docker answers inspect for the
// container `ctr` (running, the fixture's folder bound at /ctr; `stopped` is
// not running) and runs exec for real — the harness's shim, its trap and its
// stdin — in the -w folder mapped back to the host, with the -e vars and the
// fixture's TMPDIR, logging each call's argv to docker.log.
function inContainer(extra = {}) {
  const f = workspace();
  const dir = f.tmp, home = join(dir, 'home'), tmp = join(dir, 'tmp');
  mkdirSync(home); mkdirSync(tmp);
  writeFileSync(join(dir, 'bin', 'docker'), `#!/usr/bin/env bash
[ "$FAKE_DOCKER" = down ] && { echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1; }
printf '%s\\n' "$*" >> "${join(dir, 'docker.log')}"
case "$1" in
  inspect) name="\${@: -1}"
    case "$name" in ctr) up=true ;; stopped) up=false ;; *) echo "Error: No such object: $name" >&2; exit 1 ;; esac
    echo "$up [{\\"Type\\":\\"bind\\",\\"Source\\":\\"${dir}\\",\\"Destination\\":\\"/ctr\\"}]" ;;
  exec) shift; envs=(); w=
    while [[ "$1" == -* ]]; do case "$1" in -i) shift ;; -w) w="$2"; shift 2 ;; -e) envs+=("$2"); shift 2 ;; esac; done
    name="$1"; shift
    [ "$name" = ctr ] || { echo "Error response from daemon: No such container: $name" >&2; exit 1; }
    cd "${dir}\${w#/ctr}" && exec env "\${envs[@]}" TMPDIR="${tmp}" "$@" ;;
esac
`);
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  const file = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'dev-container': 'ctr', ...extra }));
  const env = { ...f.env, HOME: home };
  const agent = (...args) => run(AGENT, args, { env });
  const dockerLog = () => (existsSync(join(dir, 'docker.log')) ? readFileSync(join(dir, 'docker.log'), 'utf8') : '');
  const folder = join(f.ws, '.worktrees', 'ABC-3');
  const inside = `/ctr${folder.slice(dir.length)}`;
  return { ...f, env, agent, home, tmp, dockerLog, folder, inside };
}

// The ticket's recorded tests, as generate-automated-tests writes them.
function recordTests(f, tests) {
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'automated-tests-A.json'), JSON.stringify(tests));
  return () => readFileSync(join(folder, 'automated-test-results-A.md'), 'utf8');
}

async function worktreeIn(f, setup) {
  if (setup) withSetup(f, setup);
  await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
  await f.agent('code:create-worktree', 'p', 'ABC-3', 'A');
}

const exitsWith = (promise, code, message = /./) => assert.rejects(promise, e => e.code === code && message.test(e.stderr));

test('code:create-worktree runs worktree-setup in the dev container at the worktree\'s container path, with the operator\'s ~/.npmrc as the npm user config, and leaves no copy of it behind', async () => {
  const f = inContainer();
  writeFileSync(join(f.home, '.npmrc'), 'token=x\n');
  await worktreeIn(f, 'cat "$NPM_CONFIG_USERCONFIG" > seen');
  assert.equal(readFileSync(join(f.folder, 'seen'), 'utf8'), 'token=x\n');
  assert.match(f.dockerLog(), new RegExp(`^exec -i -w ${f.inside} ctr bash -c `, 'm'));
  assert.doesNotMatch(f.dockerLog(), /token=x/);
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('in the dev container the copied ~/.npmrc is removed even when worktree-setup execs', async () => {
  const f = inContainer();
  writeFileSync(join(f.home, '.npmrc'), 'token=x\n');
  await worktreeIn(f, 'exec true');
  assert.equal(f.variation('A').build.worktree, 'ABC-3');
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('without ~/.npmrc, worktree-setup in the dev container runs with no npm user config set', async () => {
  const f = inContainer();
  await worktreeIn(f, 'echo "[${NPM_CONFIG_USERCONFIG-unset}]" > seen');
  assert.equal(readFileSync(join(f.folder, 'seen'), 'utf8'), '[unset]\n');
});

test('a worktree-setup that fails in the dev container removes the worktree and records nothing', async () => {
  const f = inContainer();
  withSetup(f, 'echo "401 Unauthorized" >&2; exit 1');
  await f.agent('code:create-branch', 'p', 'ABC-3', 'A');
  await fails(f.agent('code:create-worktree', 'p', 'ABC-3', 'A'), /worktree-setup failed[\s\S]*401 Unauthorized/);
  assert.equal(existsSync(f.folder), false);
  assert.equal(f.variation('A').build.worktree, undefined);
});

test('automated-tests:verify-success runs every test in the dev container, each in turn, with and without ~/.npmrc', async () => {
  for (const npmrc of [true, false]) {
    const f = inContainer();
    if (npmrc) writeFileSync(join(f.home, '.npmrc'), 'token=x\n');
    await worktreeIn(f);
    const results = recordTests(f, [{ list: 'echo a', run: 'echo first' }, { list: 'echo b', run: 'echo second' }]);
    assert.deepEqual(JSON.parse((await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A')).stdout), { passed: 2, failed: 0 });
    assert.match(results(), /first[\s\S]*second/);
    assert.equal(f.dockerLog().match(new RegExp(`^exec -i -w ${f.inside} ctr `, 'gm')).length, 2);
  }
});

test('automated-tests:verify-exist-and-runnable runs every list command in the dev container', async () => {
  const f = inContainer();
  await worktreeIn(f);
  recordTests(f, [{ list: 'echo a', run: 'true' }, { list: 'echo b', run: 'true' }]);
  assert.deepEqual(JSON.parse((await f.agent('automated-tests:verify-exist-and-runnable', 'p', 'ABC-3', 'A')).stdout), { tests: 2, listed: ['a', 'b'] });
  assert.equal(f.dockerLog().match(new RegExp(`^exec -i -w ${f.inside} ctr `, 'gm')).length, 2);
});

test('the dev container gets project.json\'s dev-container-env, {folder} as the worktree\'s host path; with none, no -e', async () => {
  const f = inContainer({ 'dev-container-env': { HOST_PROJECT_PATH: '{folder}', X: '1' } });
  await worktreeIn(f);
  const results = recordTests(f, [{ list: 'true', run: 'echo "[$HOST_PROJECT_PATH $X]"' }]);
  await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A');
  assert.match(results(), new RegExp(`\\[${f.folder} 1\\]`));
  const plain = inContainer();
  await worktreeIn(plain);
  recordTests(plain, [{ list: 'true', run: 'true' }]);
  await plain.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A');
  assert.doesNotMatch(plain.dockerLog(), / -e /);
});

test('automated-tests:verify-success exits 3, an environment problem, when the dev container is gone, stopped, unreachable or does not mount the worktree', async () => {
  const f = inContainer();
  await worktreeIn(f);
  recordTests(f, [{ list: 'true', run: 'true' }]);
  const project = join(f.dir, 'projects', 'p', 'project.json');
  const set = extra => writeFileSync(project, JSON.stringify({ ...JSON.parse(readFileSync(project, 'utf8')), ...extra }));
  set({ 'dev-container': 'gone' });
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 3, /could not run/);
  set({ 'dev-container': 'stopped' });
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 3, /could not run/);
  set({ 'dev-container': 'ctr' });
  await exitsWith(run(AGENT, ['automated-tests:verify-success', 'p', 'ABC-3', 'A'], { env: { ...f.env, FAKE_DOCKER: 'down' } }), 3, /could not run/);
  // A worktree outside the container's mounts.
  const elsewhere = mkdtempSync(join(tmpdir(), 'out-'));
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  writeFileSync(sprint, readFileSync(sprint, 'utf8').replaceAll(f.folder, elsewhere));
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 3, /could not run/);
  assert.match(readFileSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3', 'automated-test-results-A.md'), 'utf8'), /does not mount/);
});

test('without a dev-container, automated-tests:verify-success runs every test on the host in the worktree, never through docker', async () => {
  const f = inContainer({ 'dev-container': undefined });
  await worktreeIn(f);
  const results = recordTests(f, [{ list: 'true', run: 'pwd' }, { list: 'true', run: 'echo second' }]);
  assert.deepEqual(JSON.parse((await f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A')).stdout), { passed: 2, failed: 0 });
  assert.match(results(), new RegExp(`${f.folder}[\\s\\S]*second`));
  assert.equal(f.dockerLog(), '');
});

test('ASS-329 AC1: in the dev container, the limit stops the run and everything it started there, not only the docker exec', async () => {
  const f = inContainer();
  await worktreeIn(f);
  const results = recordTests(f, [{ list: 'echo t', run: sleeping(f), reproduces: true }]);
  minutes(f, 0.02);
  await exitsWith(f.agent('automated-tests:verify-success', 'p', 'ABC-3', 'A'), 1, /1 of 1 failed/);
  assert.equal(pids(f).length, 4);
  assert.ok(gone(f));
  assert.match(results(), /- the command timed out after 0\.02 minutes\n/);
  assert.equal(f.dockerLog().match(new RegExp(`^exec -i -w ${f.inside} ctr bash -c `, 'gm')).length, 2);
});
