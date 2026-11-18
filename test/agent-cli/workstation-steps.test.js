// A ticket variation's steps on a GCP workstation (ASS-468), through the bash
// commands: workstation:claim holds a free workstation for one step — its
// holder and the variation's `workstation` set, the shared repositories
// cloned once and checked out on the variation's branches (made from the
// planned base when GitLab has none), every other on master at the latest,
// their git hooks refusing a commit on master (AC10), the ticket's copy,
// credentials and token there (AC1, AC2, AC6) — and workstation:release ends
// the step: what a completed step left uncommitted committed on its branch,
// an unfinished one's discarded and named (AC9), committed work pushed to its
// branch (never master, never forced; a rejected push said, its commits
// kept), a master ahead of GitLab's reset to it, its commits named (AC10),
// the step's containers, credentials, token and binding removed and the
// holder cleared (AC3); a second variation claims it between the first's
// steps, and none while one holds it; a holder from before ASS-468 is
// migrated, its committed work pushed and its folder removed (AC7); the
// variation's VM is moved to its branches before a step there and cleaned
// after it (AC4). Against a fake workstation (test/support/fake-workstation.js),
// bare local repositories standing in for GitLab.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wsFixture, closeAll, git, edit, ID } from './workstation-fixture.js';
import { lima } from './vm-fixture.js';

afterEach(closeAll);

const plan = (s, name, entries) => edit(s.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => { sp.features[0].variations.find(v => v.name === name)['merge-request'] = entries; });
const remote = (bare, ref) => { try { return git(bare, 'rev-parse', '--verify', '-q', ref); } catch { return null; } };
const head = dir => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
const status = dir => git(dir, 'status', '--porcelain', '--untracked-files=all');
const commit = (dir, file, text) => { writeFileSync(join(dir, file), text); git(dir, 'add', file); git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', file); return git(dir, 'rev-parse', 'HEAD'); };

async function connected(s) {
  const c = await s.result('workstation:connect', 'p', ID);
  assert.equal(c.code, 0, c.err);
  const u = await s.result('workstation:setup', 'p', ID);
  assert.equal(u.code, 0, u.err);
}

test('AC1, AC2, AC3, AC6, AC9: a step claims the workstation, its shared repositories on the variation\'s branches; its end pushes committed work, discards what an unfinished step left (named), puts master back and frees it; a completed step\'s leftovers are committed on its branch', async () => {
  const s = wsFixture();
  await connected(s);
  plan(s, 'B', [{ id: 1, repository: s.origins.harness, branch: 'change/ABC-3.B-1', status: 'Not Created' }, { id: 2, contents: 'found on the forge' }]);
  const root = s.root(), machine = `workstation:p:${ID}:${root}`;

  const claim = await s.result('workstation:claim', 'p', 'ABC-3', 'B');
  assert.equal(claim.code, 0, claim.err);
  assert.equal(JSON.parse(claim.out).machine, machine);
  assert.deepEqual({ ticket: s.entry().holder.ticket, variation: s.entry().holder.variation, folder: s.entry().holder.folder }, { ticket: 'ABC-3', variation: 'B', folder: root });
  assert.deepEqual({ ...s.variation('B').workstation, since: undefined }, { name: ID, project: 'p', folder: root, since: undefined });
  // Cloned once into the shared root; the planned repository on its branch, made from its base (not on GitLab yet); the other on master.
  assert.equal(head(s.repo('harness')), 'change/ABC-3.B-1');
  assert.equal(git(s.repo('harness'), 'rev-parse', 'HEAD'), remote(s.origins.harness, 'main'));
  assert.equal(head(s.repo('example-corpus')), 'master');
  assert.match(claim.err, /made change\/ABC-3\.B-1 from origin\/main \(not on GitLab yet\)/);
  assert.ok(!existsSync(s.folder('B')), 'no folder of its own');
  assert.equal(readFileSync(join(root, 'ticket', 'plan.md'), 'utf8'), 'the plan\n');
  const runtime = s.entry().setup.runtime;
  assert.ok(existsSync(join(runtime, 'agent-token')) && existsSync(join(runtime, 'env')));
  assert.equal(s.tokens()[machine].variation, 'B');

  // Another variation finds it held (AC1: never two at once).
  const busy = await s.result('workstation:claim', 'p', 'ABC-3', 'C');
  assert.equal(busy.code, 4);
  assert.match(busy.err, /no workstation of p's is free: ada-dev: held by ABC-3 B/);

  // The step's work: a commit on its branch; then it is stopped before committing the rest; an ignored cache too.
  const sha = commit(s.repo('harness'), 'feature.txt', 'built\n');
  writeFileSync(join(s.repo('harness'), 'README.md'), 'changed\n');
  writeFileSync(join(s.repo('harness'), 'test.txt'), 'a test\n');
  writeFileSync(join(s.repo('harness'), '.git', 'info', 'exclude'), 'node_modules/\n');
  mkdirSync(join(s.repo('harness'), 'node_modules'), { recursive: true });
  writeFileSync(join(s.repo('harness'), 'node_modules', 'dep.js'), 'cache\n');
  writeFileSync(join(s.repo('example-corpus'), 'notes.txt'), 'scratch\n');

  const end = await s.result('workstation:release', 'p', ID);   // not --completed: the step did not complete
  assert.equal(end.code, 0, end.err);
  const out = JSON.parse(end.out);
  assert.deepEqual(out.pushed, [{ repository: 'harness', branch: 'change/ABC-3.B-1', commits: 1 }]);
  assert.deepEqual(out['push-failed'], []);
  assert.deepEqual(out.committed, []);
  assert.deepEqual(out.discarded.map(d => [d.repository, d.branch, d.files.sort()]).sort(), [['example-corpus', 'master', ['notes.txt']], ['harness', 'change/ABC-3.B-1', ['README.md', 'test.txt']]]);
  assert.match(end.err, /harness: discarded its uncommitted changes \(README\.md,test\.txt\)/);
  assert.equal(remote(s.origins.harness, 'refs/heads/change/ABC-3.B-1'), sha, 'pushed to its branch on GitLab');
  assert.equal(remote(s.origins.harness, 'main'), git(s.repo('harness'), 'rev-parse', 'origin/main'), 'master never pushed to');
  for (const r of ['harness', 'example-corpus']) assert.equal(status(s.repo(r)), '', `${r} clean`);
  assert.equal(head(s.repo('harness')), 'main');
  assert.equal(head(s.repo('example-corpus')), 'master');
  assert.ok(existsSync(join(s.repo('harness'), 'node_modules', 'dep.js')), 'the ignored cache kept');
  assert.equal(git(s.repo('harness'), 'rev-parse', 'change/ABC-3.B-1'), sha, 'the local branch kept');
  assert.equal(s.entry().holder, undefined);
  assert.equal(s.variation('B').workstation, undefined);
  for (const f of ['env', 'gitconfig', 'agent-token']) assert.ok(!existsSync(join(runtime, f)), f);
  assert.ok(existsSync(join(runtime, 'agent-url')), 'setup\'s stays');
  assert.equal(s.tokens()[machine], undefined);
  assert.ok(!existsSync(s.at('projects', 'p', 'work', 'ABC-3', 'carry-B')), 'nothing carried between steps');
  assert.match(end.err, /workstation ada-dev freed: ABC-3 B's step ended there/);

  // Between B's steps, C takes it, and gives it back.
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'C')).code, 0);
  assert.equal(head(s.repo('harness')), 'main', 'C plans nothing: master');
  assert.equal(s.entry().holder.variation, 'C');
  assert.equal((await s.result('workstation:release', 'p', ID)).code, 0);

  // B's next step: its branch, from GitLab now. It completes, leaving a change uncommitted: the harness commits it there and pushes.
  const again = await s.result('workstation:claim', 'p', 'ABC-3', 'B');
  assert.equal(again.code, 0, again.err);
  assert.equal(head(s.repo('harness')), 'change/ABC-3.B-1');
  assert.equal(git(s.repo('harness'), 'rev-parse', 'HEAD'), sha);
  writeFileSync(join(s.repo('harness'), 'left.txt'), 'left over\n');
  const done = await s.result('workstation:release', 'p', ID, '--completed', 'Generate Solution');
  assert.equal(done.code, 0, done.err);
  const summary = JSON.parse(done.out);
  assert.deepEqual(summary.committed, [{ repository: 'harness', branch: 'change/ABC-3.B-1', files: ['left.txt'] }]);
  assert.deepEqual(summary.discarded, []);
  assert.deepEqual(summary.pushed, [{ repository: 'harness', branch: 'change/ABC-3.B-1', commits: 1 }]);
  assert.equal(git(s.origins.harness, 'log', '-1', '--format=%s', 'change/ABC-3.B-1'), 'ABC-3 B Generate Solution: what the step left uncommitted, committed by the harness at its end (ASS-468)');
  assert.equal(git(s.origins.harness, 'show', 'change/ABC-3.B-1:left.txt'), 'left over');
});

test('AC10: the shared repositories refuse a commit on master, naming the ticket\'s branch, and allow one on it; a repository\'s own hook still runs; a master ahead of GitLab\'s is reset at the step\'s end, its commits named', async () => {
  const s = wsFixture();
  await connected(s);
  plan(s, 'B', [{ id: 1, repository: s.origins.harness, branch: 'change/ABC-3.B-1', status: 'Open' }]);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'B')).code, 0);
  const repo = s.repo('harness'), corpus = s.repo('example-corpus');
  // The repository's own pre-commit hook, chained: it still runs.
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran >> "${join(s.w.dir, 'own-hook')}"\n`, { mode: 0o755 });
  const sha = commit(repo, 'ok.txt', 'on the branch\n');
  assert.ok(sha, 'a commit on the ticket\'s branch is allowed');
  assert.equal(readFileSync(join(s.w.dir, 'own-hook'), 'utf8'), 'ran\n');
  writeFileSync(join(corpus, 'bad.txt'), 'x\n');
  git(corpus, 'add', 'bad.txt');
  assert.throws(() => git(corpus, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'on master'),
    e => /no commit on master, the repository's default branch/.test(e.stderr) && /change\/ABC-3\.B-<id>/.test(e.stderr));
  // Once more (idempotent), then a commit on master that got past the hook (--no-verify) is reset away at the end.
  assert.equal((await s.result('workstation:release', 'p', ID)).code, 0);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'B')).code, 0);
  assert.equal(git(corpus, 'config', 'core.hooksPath'), join(realpathSync(corpus), '.git', 'harness-hooks'));
  assert.equal(git(corpus, 'config', '--get-all', 'core.hooksPath').split('\n').length, 1);
  writeFileSync(join(corpus, 'sneaky.txt'), 'x\n');
  git(corpus, 'add', 'sneaky.txt');
  git(corpus, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--no-verify', '-m', 'sneaked onto master');
  const lost = git(corpus, 'rev-parse', '--short', 'HEAD');
  const end = await s.result('workstation:release', 'p', ID, '--completed', 'Generate Solution');
  assert.equal(end.code, 0, end.err);
  assert.deepEqual(JSON.parse(end.out)['master-reset'], [{ repository: 'example-corpus', branch: 'master', commits: `${lost} sneaked onto master` }]);
  assert.equal(git(corpus, 'rev-parse', 'HEAD'), remote(s.origins['example-corpus'], 'master'), 'master at GitLab\'s');
  assert.notEqual(remote(s.origins['example-corpus'], 'master'), git(corpus, 'rev-parse', lost), 'never pushed');
  assert.equal(git(corpus, 'for-each-ref', 'refs/harness/'), '', 'nothing kept of it');
});

test('AC3: a push GitLab rejects is said and its commits kept on the local branch; the trees are cleaned and the workstation freed all the same', async () => {
  const s = wsFixture();
  await connected(s);
  plan(s, 'B', [{ id: 1, repository: s.origins.harness, branch: 'change/ABC-3.B-1', status: 'Open' }]);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'B')).code, 0);
  const sha = commit(s.repo('harness'), 'feature.txt', 'built\n');
  writeFileSync(join(s.origins.harness, 'hooks', 'pre-receive'), '#!/bin/sh\necho "You are not allowed to push code to this project." >&2\nexit 1\n', { mode: 0o755 });
  const end = await s.result('workstation:release', 'p', ID);
  assert.equal(end.code, 0, end.err);
  const out = JSON.parse(end.out);
  assert.equal(out['push-failed'].length, 1, end.out);
  assert.match(out['push-failed'][0].why, /not allowed to push/);
  assert.equal(remote(s.origins.harness, 'refs/heads/change/ABC-3.B-1'), null);
  assert.equal(git(s.repo('harness'), 'rev-parse', 'change/ABC-3.B-1'), sha, 'kept for its next step');
  assert.equal(head(s.repo('harness')), 'main');
  assert.equal(status(s.repo('harness')), '');
  assert.equal(s.entry().holder, undefined);
});

test('AC7: a holder from before ASS-468, in a folder of its own, is migrated: its committed work pushed, its folder removed, the workstation freed; setup removes a leftover folder', async () => {
  const s = wsFixture();
  await connected(s);
  plan(s, 'A', [{ id: 1, repository: s.origins.harness, branch: 'change/ABC-3-1', status: 'Open' }]);
  const old = s.folder('A'), leftover = s.folder('C');
  for (const r of ['harness', 'example-corpus']) execFileSync('git', ['clone', '-q', s.origins[r], join(old, 'repos', r)]);
  git(join(old, 'repos', 'harness'), 'checkout', '-q', '-b', 'change/ABC-3-1');
  const sha = commit(join(old, 'repos', 'harness'), 'work.txt', 'from ASS-435\n');
  mkdirSync(join(leftover, 'repos'), { recursive: true });
  edit(s.at('projects', 'p', 'workstations.json'), w => { w[ID].holder = { ticket: 'ABC-3', variation: 'A', since: '2026-11-15T08:28:13Z', folder: old }; });
  // Setup keeps the holder's folder, and removes the one no holder records.
  const setup = await s.result('workstation:setup', 'p', ID);
  assert.equal(setup.code, 0, setup.err);
  assert.ok(existsSync(old) && !existsSync(leftover));
  assert.ok(s.entry().setup.did.some(d => d.includes(`removed ${leftover}`)), JSON.stringify(s.entry().setup.did));
  const end = await s.result('workstation:release', 'p', ID, '--force');
  assert.equal(end.code, 0, end.err);
  assert.equal(JSON.parse(end.out).released.migrated, true);
  assert.equal(remote(s.origins.harness, 'refs/heads/change/ABC-3-1'), sha);
  assert.ok(!existsSync(old));
  assert.equal(s.entry().holder, undefined);
  assert.match(end.err, /its folder .*ABC-3-A removed \(a holder from before ASS-468\)/);
});

test('vm:create records the workstation pool on the variation, claiming nothing; Setup is marked on the variation', async () => {
  const s = wsFixture();
  const r = await s.result('vm:create', 'p', 'ABC-3', 'B');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { name: ID, machine: `workstation:p:${ID}:${s.root()}`, ip: null, created: true });
  assert.equal(s.variation('B').vm.folder, s.root());
  assert.equal(s.entry().holder, undefined, 'nothing claimed');
  assert.equal((await s.result('vm:setup-complete', 'p', 'ABC-3', 'B')).code, 1);
  assert.equal((await s.result('vm:mark-setup-complete', 'p', 'ABC-3', 'B')).code, 0);
  assert.equal((await s.result('vm:setup-complete', 'p', 'ABC-3', 'B')).code, 0);
});

test('AC4, AC9, AC10: before a step in its VM, its repositories are moved to its branches, their hooks set; after it, a completed step\'s leftovers committed, its commits pushed, the trees back on master', async () => {
  const l = lima();
  l.v.instance('abc-3-a', 'Running');
  l.mount();
  edit(l.f.dir + '/projects/p/sprints/sprint-10/sprint.json', sp => {
    Object.assign(sp.features[0].variations[0], { vm: { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' }, 'merge-request': [{ id: 1, repository: 'https://github.com/o/harness', branch: 'change/ABC-3-1', status: 'Open' }] });
  });
  const own = l.vmFile('repos', 'harness'), ref = l.vmFile('repos', 'example-corpus');
  const start = await l.cli('vm:step-start', 'p', 'ABC-3', 'A');
  assert.equal(head(own), 'change/ABC-3-1');
  assert.equal(git(own, 'rev-parse', 'HEAD'), git(l.origins.harness.work, 'rev-parse', 'main'), 'made from the latest origin/main');
  assert.equal(git(ref, 'rev-parse', 'HEAD'), git(l.origins['example-corpus'].work, 'rev-parse', 'HEAD'), 'the other at master\'s latest');
  assert.match(start.stderr, /made change\/ABC-3-1 from origin\/main/);
  assert.equal(git(ref, 'config', 'harness.ticket-branch').startsWith("the ticket's branch for this repository, change/ABC-3-<id>"), true);

  const sha = commit(own, 'fix.txt', 'fixed\n');
  writeFileSync(join(own, 'more.txt'), 'not committed\n');
  const end = JSON.parse((await l.cli('vm:step-end', 'p', 'ABC-3', 'A', '--completed', 'Generate Solution')).stdout);
  assert.deepEqual(end.committed, [{ repository: 'harness', branch: 'change/ABC-3-1', files: ['more.txt'] }]);
  assert.deepEqual(end.pushed, [{ repository: 'harness', branch: 'change/ABC-3-1', commits: 2 }]);
  assert.equal(git(l.origins.harness.work, 'rev-parse', 'change/ABC-3-1~1'), sha);
  assert.equal(head(own), 'main');
  assert.equal(status(own), '');
});

test('AC2: a branch GitLab had, rewritten since by a rebase pushed from elsewhere, is taken from GitLab at the next step', async () => {
  const s = wsFixture();
  await connected(s);
  plan(s, 'B', [{ id: 1, repository: s.origins.harness, branch: 'change/ABC-3.B-1', status: 'Open' }]);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'B')).code, 0);
  commit(s.repo('harness'), 'one.txt', 'one\n');
  assert.equal((await s.result('workstation:release', 'p', ID)).code, 0);
  // Its VM's step rebased the branch and force-pushed it.
  const elsewhere = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['clone', '-q', '-b', 'change/ABC-3.B-1', s.origins.harness, elsewhere]);
  git(elsewhere, 'reset', '-q', '--hard', 'origin/main');
  const rebased = commit(elsewhere, 'rebased.txt', 'rebased\n');
  git(elsewhere, 'push', '-q', '--force', 'origin', 'change/ABC-3.B-1');
  const again = await s.result('workstation:claim', 'p', 'ABC-3', 'B');
  assert.equal(again.code, 0, again.err);
  assert.equal(git(s.repo('harness'), 'rev-parse', 'HEAD'), rebased);
  assert.match(again.err, /GitLab's change\/ABC-3\.B-1 was rewritten since; taken/);
});

// ASS-478: a step's end on a shared workstation pushes only its own ticket's branches; a branch GitLab deleted after
// its merge is never pushed back; the claim prunes stale merged branches, keeping any with work master lacks.
const onBranch = (dir, branch, file, text, from) => { const was = head(dir); git(dir, 'checkout', '-q', ...(from ? ['-b', branch, from] : [branch])); const sha = commit(dir, file, text); git(dir, 'checkout', '-q', was); return sha; };
function squashMerged(bare, branch, base = 'main') {
  const work = join(execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim(), 'w');
  execFileSync('git', ['clone', '-q', '-b', base, bare, work]);
  git(work, 'merge', '-q', '--squash', `origin/${branch}`);
  git(work, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', `Merge ${branch} (squashed)`);
  git(work, 'push', '-q', 'origin', base);
  git(work, 'push', '-q', 'origin', '--delete', branch);
}

test('ASS-478 AC1, AC4: a release pushes only its own ticket\'s branch; another ticket\'s unpushed branch on the workstation is left alone, and a rejected push names only its own', async () => {
  const s = wsFixture();
  await connected(s);
  plan(s, 'B', [{ id: 1, repository: s.origins.harness, branch: 'change/ABC-3.B-1', status: 'Open' }]);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'B')).code, 0);
  const repo = s.repo('harness');
  const theirs = onBranch(repo, 'change/XYZ-9-1', 'theirs.txt', 'another ticket\'s\n', 'origin/main');
  const own = commit(repo, 'own.txt', 'its own\n');
  const end = await s.result('workstation:release', 'p', ID);
  assert.equal(end.code, 0, end.err);
  assert.deepEqual(JSON.parse(end.out).pushed, [{ repository: 'harness', branch: 'change/ABC-3.B-1', commits: 1 }]);
  assert.equal(remote(s.origins.harness, 'refs/heads/change/ABC-3.B-1'), own);
  assert.equal(remote(s.origins.harness, 'refs/heads/change/XYZ-9-1'), null, 'another ticket\'s branch is not pushed');
  assert.equal(git(repo, 'rev-parse', 'change/XYZ-9-1'), theirs, 'and is kept for its own step');

  // C plans nothing: its end pushes nothing, not even the other ticket's branch.
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'C')).code, 0);
  assert.equal(git(repo, 'rev-parse', 'change/XYZ-9-1'), theirs, 'never pushed, so never pruned');
  const c = await s.result('workstation:release', 'p', ID);
  assert.equal(c.code, 0, c.err);
  assert.deepEqual(JSON.parse(c.out).pushed, []);
  assert.equal(remote(s.origins.harness, 'refs/heads/change/XYZ-9-1'), null);

  // GitLab refuses every push: the release's failure names its own branch only.
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'B')).code, 0);
  commit(repo, 'more.txt', 'more\n');
  writeFileSync(join(s.origins.harness, 'hooks', 'pre-receive'), '#!/bin/sh\necho "You are not allowed to push code to this project." >&2\nexit 1\n', { mode: 0o755 });
  const refused = await s.result('workstation:release', 'p', ID);
  assert.equal(refused.code, 0, refused.err);
  assert.deepEqual(JSON.parse(refused.out)['push-failed'].map(f => f.branch), ['change/ABC-3.B-1']);
});

test('ASS-478 AC2: a ticket branch GitLab deleted after its merge is never pushed back by any release, its commits kept and said', async () => {
  const s = wsFixture();
  await connected(s);
  plan(s, 'B', [{ id: 1, repository: s.origins.harness, branch: 'change/ABC-3.B-1', status: 'Open' }]);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'B')).code, 0);
  const repo = s.repo('harness');
  commit(repo, 'feature.txt', 'built\n');
  assert.equal((await s.result('workstation:release', 'p', ID)).code, 0);
  assert.equal(git(repo, 'config', 'branch.change/ABC-3.B-1.merge'), 'refs/heads/change/ABC-3.B-1', 'tracks GitLab\'s once pushed');
  // Its merge request is squash-merged, the source branch deleted; the local branch has a commit more (as the incident's had).
  squashMerged(s.origins.harness, 'change/ABC-3.B-1');
  const late = onBranch(repo, 'change/ABC-3.B-1', 'late.txt', 'after the merge\n');

  // Another variation's release does not push it.
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'C')).code, 0);
  assert.equal((await s.result('workstation:release', 'p', ID)).code, 0);
  assert.equal(remote(s.origins.harness, 'refs/heads/change/ABC-3.B-1'), null);

  // Nor does its own, while its plan still names the branch (not yet synced as Merged).
  const claim = await s.result('workstation:claim', 'p', 'ABC-3', 'B');
  assert.equal(claim.code, 0, claim.err);
  assert.match(claim.err, /kept change\/ABC-3\.B-1: its branch on GitLab is gone, but it has commits main lacks: \w+ late\.txt/);
  const end = await s.result('workstation:release', 'p', ID);
  assert.equal(end.code, 0, end.err);
  assert.deepEqual(JSON.parse(end.out).pushed, []);
  assert.deepEqual(JSON.parse(end.out)['push-failed'], []);
  assert.match(end.err, /not pushing change\/ABC-3\.B-1: its branch on GitLab is gone/);
  assert.equal(remote(s.origins.harness, 'refs/heads/change/ABC-3.B-1'), null, 'never resurrected');
  assert.equal(git(repo, 'rev-parse', 'change/ABC-3.B-1'), late, 'its unmerged commit kept');
});

test('ASS-478 AC3: the claim prunes branches GitLab deleted whose work is on master (merged or squashed), and keeps one with unmerged commits and one never pushed', async () => {
  const s = wsFixture();
  await connected(s);
  plan(s, 'B', [{ id: 1, repository: s.origins.harness, branch: 'change/ABC-3.B-1', status: 'Open' }]);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'B')).code, 0);
  const repo = s.repo('harness');
  // Branches as other tickets' steps left them: pushed to GitLab by the code before ASS-478 (tracking origin/main),
  // or never pushed.
  for (const b of ['change/OLD-1-1', 'change/OLD-2-1', 'change/OLD-3-1']) {
    onBranch(repo, b, `${b.split('/')[1]}.txt`, `${b}\n`, 'origin/main');
    git(repo, 'push', '-q', 'origin', `${b}:${b}`);
  }
  const unpushed = onBranch(repo, 'change/NEW-4-1', 'new.txt', 'never pushed\n', 'origin/main');
  commit(repo, 'feature.txt', 'built\n');
  assert.equal((await s.result('workstation:release', 'p', ID)).code, 0);
  // The next claim sees them on GitLab: each now tracks its GitLab branch.
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'C')).code, 0);
  assert.equal(git(repo, 'config', 'branch.change/OLD-1-1.merge'), 'refs/heads/change/OLD-1-1');
  assert.equal((await s.result('workstation:release', 'p', ID)).code, 0);
  // OLD-1 squash-merged and deleted; B's own too; OLD-2 merged with a merge commit and deleted; OLD-3 deleted with work
  // master never got, a commit more locally besides.
  squashMerged(s.origins.harness, 'change/OLD-1-1');
  squashMerged(s.origins.harness, 'change/ABC-3.B-1');
  const work = join(execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim(), 'w');
  execFileSync('git', ['clone', '-q', '-b', 'main', s.origins.harness, work]);
  git(work, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'merge', '-q', '--no-ff', '-m', 'merge OLD-2', 'origin/change/OLD-2-1');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'push', '-q', 'origin', '--delete', 'change/OLD-2-1', 'change/OLD-3-1');
  const kept = onBranch(repo, 'change/OLD-3-1', 'more.txt', 'more\n');

  const claim = await s.result('workstation:claim', 'p', 'ABC-3', 'C');
  assert.equal(claim.code, 0, claim.err);
  const branches = git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();
  assert.deepEqual(branches, ['change/NEW-4-1', 'change/OLD-3-1', 'main']);
  assert.match(claim.err, /removed change\/OLD-1-1: its branch on GitLab is gone and its work is on main/);
  assert.match(claim.err, /removed change\/OLD-2-1/);
  assert.match(claim.err, /removed change\/ABC-3\.B-1/);
  assert.match(claim.err, /kept change\/OLD-3-1: its branch on GitLab is gone, but it has commits main lacks/);
  assert.equal(git(repo, 'rev-parse', 'change/OLD-3-1'), kept);
  assert.equal(git(repo, 'rev-parse', 'change/NEW-4-1'), unpushed);
  assert.equal((await s.result('workstation:release', 'p', ID)).code, 0);
  for (const b of ['change/OLD-1-1', 'change/OLD-2-1', 'change/OLD-3-1', 'change/ABC-3.B-1', 'change/NEW-4-1']) assert.equal(remote(s.origins.harness, `refs/heads/${b}`), null, `${b} not pushed`);
});

// ASS-480: the stray branches a step finds in the shared repositories — set aside under refs/harness/stray/<branch>/<time>.
const strays = dir => git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/harness/stray/').split('\n').filter(Boolean).map(l => l.split(' '));
// gitlabMoved(s, branch) — GitLab's <branch> made (from main) with a commit pushed from elsewhere; its sha.
function gitlabMoved(s, branch) {
  const elsewhere = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['clone', '-q', s.origins.harness, elsewhere]);
  git(elsewhere, 'checkout', '-q', '-b', branch);
  const sha = commit(elsewhere, 'moved.txt', 'moved on\n');
  git(elsewhere, 'push', '-q', 'origin', branch);
  return sha;
}
const branchSha = (dir, b) => { try { return git(dir, 'rev-parse', '--verify', '-q', `refs/heads/${b}`); } catch { return null; } };

test('ASS-480 AC3: a step\'s end pushes only its own branch; another ticket\'s local branch that has parted from GitLab\'s, with commits GitLab lacks, is set aside under refs/harness/stray, its local branch deleted, never pushed, and named for its ticket', async () => {
  const s = wsFixture();
  await connected(s);
  plan(s, 'B', [{ id: 1, repository: s.origins.harness, branch: 'change/ABC-3.B-1', status: 'Open' }]);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'B')).code, 0);
  const repo = s.repo('harness');
  const own = commit(repo, 'own.txt', 'its own\n');
  // An earlier step of ABC-9 left a local branch of its own with a commit GitLab lacks, its push rejected: GitLab's
  // change/ABC-9-1 has moved on since (pushed from elsewhere), so it could never be pushed as it is.
  gitlabMoved(s, 'change/ABC-9-1');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'branch', '-q', 'change/ABC-9-1', 'origin/main');
  git(repo, 'checkout', '-q', 'change/ABC-9-1');
  const stray = commit(repo, 'stray.txt', 'another ticket\'s\n');
  // And ABC-7's, merely ahead of GitLab's (not on GitLab yet): ASS-478 leaves it for its own ticket's next step.
  git(repo, 'checkout', '-q', '-b', 'change/ABC-7-1', 'origin/main');
  const ahead = commit(repo, 'ahead.txt', 'pushable\n');
  git(repo, 'checkout', '-q', 'change/ABC-3.B-1');
  const end = await s.result('workstation:release', 'p', ID);
  assert.equal(end.code, 0, end.err);
  const out = JSON.parse(end.out);
  assert.deepEqual(out.pushed, [{ repository: 'harness', branch: 'change/ABC-3.B-1', commits: 1 }]);
  assert.deepEqual(out['push-failed'], []);
  assert.equal(out['set-aside'].length, 1, end.out);
  const [aside] = out['set-aside'];
  assert.deepEqual({ ...aside, ref: undefined }, { repository: 'harness', branch: 'change/ABC-9-1', ref: undefined, commits: 1, why: 'not this ticket variation\'s branch, and parted from GitLab\'s, which moved on: a push would be rejected' });
  assert.match(aside.ref, /^refs\/harness\/stray\/change\/ABC-9-1\/\d{8}T\d{6}Z$/);
  assert.equal(remote(s.origins.harness, 'refs/heads/change/ABC-3.B-1'), own, 'its own pushed');
  assert.notEqual(remote(s.origins.harness, 'refs/heads/change/ABC-9-1'), stray, 'the stray never pushed');
  assert.equal(remote(s.origins.harness, 'refs/heads/change/ABC-7-1'), null, 'nor ABC-7\'s');
  assert.equal(branchSha(repo, 'change/ABC-7-1'), ahead, 'ABC-7\'s, pushable by its own next step, left where it is (ASS-478)');
  assert.deepEqual(strays(repo), [[aside.ref, stray]], 'kept out of the way');
  assert.equal(branchSha(repo, 'change/ABC-9-1'), null, 'its local branch deleted');
  assert.equal(head(repo), 'main');
  assert.equal(s.entry().holder, undefined);
  assert.match(end.err, /harness: set change\/ABC-9-1 aside under refs\/harness\/stray\/change\/ABC-9-1\/\S+ \(1 commit\(s\) GitLab lacks; .*\): never pushed; its local branch deleted/);
});

test('ASS-480 AC4: at a step\'s start another ticket\'s stray branch is set aside before the checkout, and its own local branch, parted from GitLab\'s with commits GitLab never had, is set aside too and GitLab\'s taken', async () => {
  const s = wsFixture();
  await connected(s);
  plan(s, 'B', [{ id: 1, repository: s.origins.harness, branch: 'change/ABC-3.B-1', status: 'Open' }]);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'C')).code, 0);   // the shared repositories cloned
  assert.equal((await s.result('workstation:release', 'p', ID)).code, 0);
  const repo = s.repo('harness');
  // GitLab's change/ABC-3.B-1, pushed from elsewhere (its VM).
  const elsewhere = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['clone', '-q', s.origins.harness, elsewhere]);
  git(elsewhere, 'checkout', '-q', '-b', 'change/ABC-3.B-1');
  const gitlab = commit(elsewhere, 'gitlab.txt', 'on GitLab\n');
  git(elsewhere, 'push', '-q', 'origin', 'change/ABC-3.B-1');
  // Left in the shared repository: a local change/ABC-3.B-1 of its own GitLab never had, and ABC-9's stray.
  git(repo, 'checkout', '-q', '-b', 'change/ABC-3.B-1', 'origin/main');
  const stale = commit(repo, 'stale.txt', 'never pushed\n');
  gitlabMoved(s, 'change/ABC-9-1');
  git(repo, 'checkout', '-q', '-b', 'change/ABC-9-1', 'origin/main');
  const stray = commit(repo, 'stray.txt', 'another ticket\'s\n');
  const claim = await s.result('workstation:claim', 'p', 'ABC-3', 'B');
  assert.equal(claim.code, 0, claim.err);
  const out = JSON.parse(claim.out);
  assert.deepEqual(out['set-aside'].map(a => [a.repository, a.branch, a.commits]).sort(), [['harness', 'change/ABC-3.B-1', 1], ['harness', 'change/ABC-9-1', 1]]);
  assert.match(out['set-aside'].find(a => a.branch === 'change/ABC-3.B-1').why, /parted from GitLab's change\/ABC-3\.B-1/);
  assert.equal(head(repo), 'change/ABC-3.B-1');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), gitlab, 'GitLab\'s taken: the step never starts on the stale commit');
  assert.equal(branchSha(repo, 'change/ABC-9-1'), null);
  assert.deepEqual(strays(repo).map(([, sha]) => sha).sort(), [stale, stray].sort(), 'both kept, out of the way');
  assert.match(claim.err, /its change\/ABC-3\.B-1 and GitLab's had parted; the local one set aside, GitLab's taken/);
  // Its end pushes nothing of either.
  const end = await s.result('workstation:release', 'p', ID);
  assert.equal(end.code, 0, end.err);
  assert.deepEqual(JSON.parse(end.out).pushed, []);
  assert.equal(remote(s.origins.harness, 'refs/heads/change/ABC-3.B-1'), gitlab);
  assert.notEqual(remote(s.origins.harness, 'refs/heads/change/ABC-9-1'), stray);
});

// ASS-503: after vm:step-start moves its VM's checkouts, each repository whose pnpm-lock.yaml differs from the one its
// node_modules was installed from (node_modules/.harness-installed-lock.yaml) gets `pnpm install --frozen-lockfile`,
// a "vm:step-start: <repo>: deps installed|skipped" line on stderr; stdout stays the summary; a failed install fails it.
// The VM's pnpm a stub: logs "<cwd>|<args>|CI=<CI>", makes node_modules, exits per <dir>/pnpm-exit.
function depsVm() {
  const l = lima();
  l.v.instance('abc-3-a', 'Running');
  l.mount();
  edit(l.f.dir + '/projects/p/sprints/sprint-10/sprint.json', sp => {
    Object.assign(sp.features[0].variations[0], { vm: { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' }, 'merge-request': [{ id: 1, repository: 'https://github.com/o/harness', branch: 'change/ABC-3-1', status: 'Open' }] });
  });
  const log = join(l.v.dir, 'pnpm.log'), exit = join(l.v.dir, 'pnpm-exit');
  l.v.inVm('pnpm', `echo "$(pwd -P)|$*|CI=\${CI-}" >> '${log}'; mkdir -p node_modules
rc=$(cat '${exit}' 2>/dev/null || echo 0); [ "$rc" -eq 0 ] || echo "ERR_STUB_PNPM: lockfile broken" >&2; exit "$rc"`);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(x => { const [cwd, args, ci] = x.split('|'); return { cwd, args, ci }; }) : []);
  const ref = l.vmFile('repos', 'example-corpus');
  // The lockfile moved on master since the golden build (node_modules ignored, as a pnpm repository has it).
  const work = l.origins['example-corpus'].work;
  writeFileSync(join(work, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n'); writeFileSync(join(work, '.gitignore'), 'node_modules\n');
  git(work, 'add', '.'); git(work, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'lockfile');
  const stamp = join(ref, 'node_modules', '.harness-installed-lock.yaml');
  return { ...l, ref, calls, stamp, fail: code => writeFileSync(exit, String(code)), lock: () => readFileSync(join(ref, 'pnpm-lock.yaml'), 'utf8'), start: () => l.cli('vm:step-start', 'p', 'ABC-3', 'A') };
}

test('ASS-503 AC1: vm:step-start installs a repository whose lockfile changed (CI=true, --frozen-lockfile), says so on stderr, its stdout still the summary', async () => {
  const s = depsVm();
  const { stdout, stderr } = await s.start();
  assert.deepEqual(s.calls(), [{ cwd: realpathSync(s.ref), args: 'install --frozen-lockfile', ci: 'CI=true' }]);
  assert.match(stderr, /^vm:step-start: example-corpus: deps installed \(pnpm-lock\.yaml changed\)$/m);
  assert.doesNotMatch(stderr, /harness: deps/);
  assert.doesNotThrow(() => JSON.parse(stdout), 'stdout parses as the summary');
  assert.equal(readFileSync(s.stamp, 'utf8'), s.lock());
});

test('ASS-503 AC2: a second vm:step-start with no lockfile change skips it, no install; the installed lockfile is the checkout\'s (verify-deps-style)', async () => {
  const s = depsVm();
  await s.start();
  const { stderr } = await s.start();
  assert.equal(s.calls().length, 1, 'no second install');
  assert.match(stderr, /^vm:step-start: example-corpus: deps skipped \(pnpm-lock\.yaml unchanged\)$/m);
  assert.equal(readFileSync(s.stamp, 'utf8'), s.lock());
});

test('ASS-503 AC2: installed by vm:refresh-repositories, a vm:step-start after it skips the repository (one stamp)', async () => {
  const s = depsVm();
  await s.cli('vm:refresh-repositories', 'p', 'ABC-3', 'A');
  assert.equal(s.calls().length, 1);
  const { stderr } = await s.start();
  assert.equal(s.calls().length, 1);
  assert.match(stderr, /example-corpus: deps skipped \(pnpm-lock\.yaml unchanged\)/);
});

test('ASS-503 AC3: vm:step-start with a failing install exits non-zero, stderr naming the repository; once pnpm succeeds, a rerun installs and exits 0', async () => {
  const s = depsVm();
  s.fail(1);
  const e = await s.start().then(() => assert.fail('it passed'), e => e);
  assert.notEqual(e.code, 0);
  assert.match(e.stderr, /example-corpus: pnpm install --frozen-lockfile failed/);
  assert.match(e.stderr, /dependencies could not be installed in abc-3-a/);
  assert.ok(!existsSync(s.stamp));
  s.fail(0);
  const { stderr } = await s.start();
  assert.match(stderr, /example-corpus: deps installed/);
  assert.equal(s.calls().length, 2);
});
