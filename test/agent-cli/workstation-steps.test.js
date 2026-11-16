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
