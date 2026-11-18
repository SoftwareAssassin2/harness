// vm:refresh-repositories (ASS-218): before Build's work and before each
// Automated Testing, every repository in a ticket variation's VM that its
// merge requests do not change is fetched and brought to origin's default
// branch — a dirty or diverged checkout, or one that cannot be fetched, left
// as it is and logged — and the ticket's own checkouts are never touched.
// limactl is test/support/fake-limactl.js; the VM's root a folder
// (HARNESS_VM_ROOT) holding real git checkouts (vm-fixture.js: harness on
// main, example-corpus on master, origin one commit ahead of each).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, renameSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { lima, git, edit } from './vm-fixture.js';
import { idless } from './harness-fixture.js';

// ABC-3 A, its VM abc-3-a recorded and running, its merge request plan
// changing harness alone: harness on the ticket's branch with a commit of its own.
function setup() {
  const l = lima();
  l.v.instance('abc-3-a', 'Running');
  edit(join(l.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    Object.assign(s.features[0].variations[0], {
      vm: { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' },
      'merge-request': [{ id: 1, repository: 'https://github.com/o/harness', branch: 'change/ABC-3-1', contents: 'c', 'depends-on': [], status: 'Open', key: null, url: null, 'build-status': null }],
    });
  });
  const own = l.vmFile('repos', 'harness'), ref = l.vmFile('repos', 'example-corpus');
  for (const r of [own, ref]) { git(r, 'config', 'user.email', 't@example.com'); git(r, 'config', 'user.name', 'T'); }
  git(own, 'checkout', '-q', '-b', 'change/ABC-3-1'); writeFileSync(join(own, 'fix.txt'), 'fix\n'); git(own, 'add', '.'); git(own, 'commit', '-q', '-m', 'fix');
  const head = r => [git(r, 'rev-parse', 'HEAD'), git(r, 'rev-parse', '--abbrev-ref', 'HEAD')];
  return { ...l, own, ref, head, refresh: () => l.cli('vm:refresh-repositories', 'p', 'ABC-3', 'A') };
}

test('ASS-218 AC1/AC2/AC3: a stale reference checkout — on master or left detached by Automated Testing — is fetched and brought to origin\'s default branch, logged; the ticket\'s own checkout is untouched', async () => {
  const s = setup(), origin = git(s.origins['example-corpus'].work, 'rev-parse', 'HEAD'), before = s.head(s.own);
  assert.notEqual(git(s.ref, 'rev-parse', 'HEAD'), origin, 'stale, as the golden image left it');
  const { stdout } = await s.refresh();
  assert.deepEqual(s.head(s.ref), [origin, 'master']);
  assert.match(stdout, /^example-corpus: brought from [0-9a-f]+ to [0-9a-f]+ \(origin\/master\)$/m);
  assert.match(stdout, /^harness: the ticket's own, untouched$/m);
  assert.deepEqual(s.head(s.own), before);
  assert.notEqual(git(s.own, 'rev-parse', 'origin/main'), git(s.origins.harness.work, 'rev-parse', 'HEAD'), 'not even fetched');
  assert.ok(s.v.calls().some(c => c.vm === 'abc-3-a'), 'done in the VM');
  // Detached at an older master (verify-success's to-master), origin moved on again: brought current all the same.
  git(s.ref, 'checkout', '-q', '--detach', 'HEAD~1');
  git(s.origins['example-corpus'].work, 'commit', '-q', '--allow-empty', '-m', 'three');
  const again = await s.refresh();
  assert.deepEqual(s.head(s.ref), [git(s.origins['example-corpus'].work, 'rev-parse', 'HEAD'), 'master']);
  assert.match(again.stdout, /^example-corpus: brought from/m);
  assert.match((await s.refresh()).stdout, /^example-corpus: current at [0-9a-f]+$/m);
});

test('ASS-218 AC1/AC3: a dirty reference checkout, or one with commits origin\'s default branch lacks, is left as it is and logged; nothing is discarded, and the step still succeeds', async () => {
  const s = setup();
  writeFileSync(join(s.ref, 'README.md'), 'edited\n');
  const dirty = s.head(s.ref);
  assert.match((await s.refresh()).stdout, /^example-corpus: left as is: changes not committed$/m);
  assert.deepEqual(s.head(s.ref), dirty);
  assert.equal(readFileSync(join(s.ref, 'README.md'), 'utf8'), 'edited\n');
  git(s.ref, 'commit', '-q', '-am', 'local');
  const diverged = s.head(s.ref);
  assert.match((await s.refresh()).stdout, /^example-corpus: left as is: 1 commit\(s\) not on origin\/master$/m);
  assert.deepEqual(s.head(s.ref), diverged);
  // A local master with commits of its own, though HEAD is detached elsewhere: still diverged, never reset.
  git(s.ref, 'checkout', '-q', '--detach', 'origin/master');
  assert.match((await s.refresh()).stdout, /^example-corpus: left as is: 1 commit\(s\) not on origin\/master$/m);
  assert.equal(git(s.ref, 'rev-parse', 'master'), diverged[0]);
});

test('ASS-218: a reference checkout that cannot be fetched is left as it is and logged, the step succeeding; with no running VM it fails, naming why', async () => {
  const s = setup(), work = s.origins['example-corpus'].work, before = s.head(s.ref);
  renameSync(work, `${work}.gone`);
  assert.match((await s.refresh()).stdout, /^example-corpus: left as is: could not fetch$/m);
  assert.deepEqual(s.head(s.ref), before);
  renameSync(`${work}.gone`, work);
  writeFileSync(join(s.v.instances, 'abc-3-a', 'status'), 'Stopped');
  await assert.rejects(s.refresh(), /abc-3-a is not running/);
});

test('ASS-321 AC1: an id-less merge-request entry (no repository), placed before the planned one, does not abort the script; the planned repository is still reported "the ticket\'s own, untouched", and the reference repo is still refreshed, reaching limactl', async () => {
  const s = setup();
  edit(join(s.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), j => {
    j.features[0].variations[0]['merge-request'].unshift(idless());
  });
  const origin = git(s.origins['example-corpus'].work, 'rev-parse', 'HEAD'), before = s.head(s.own);
  const { stdout } = await s.refresh();
  assert.match(stdout, /^harness: the ticket's own, untouched$/m);
  assert.doesNotMatch(stdout, /^: /m);
  assert.deepEqual(s.head(s.ref), [origin, 'master']);
  assert.deepEqual(s.head(s.own), before);
});

test('ASS-321 AC1: a merge-request array holding only id-less entries (no repository) does not abort either; with nothing planned, harness itself is then treated as a reference repo, not the ticket\'s own', async () => {
  const s = setup();
  edit(join(s.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), j => {
    j.features[0].variations[0]['merge-request'] = [idless()];
  });
  const { stdout } = await s.refresh();
  assert.match(stdout, /^harness: /m);
  assert.doesNotMatch(stdout, /the ticket's own, untouched/);
});

// ASS-396: a passing hiccup — the VM not reached, a fetch failing as a network does — is retried in the command,
// then waited out on the step's timer for 30 minutes, then Blocked; any other failure is as before.
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
function hiccups() {
  const s = setup();
  s.env.REFRESH_RETRY_SLEEPS = '0 0';
  const sprint = join(s.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const variation = () => JSON.parse(readFileSync(sprint, 'utf8')).features[0].variations[0];
  // atStep(step, minutesAgo): at grouped-build's <step>, entered that long ago.
  const atStep = (step, minutesAgo) => {
    const entered = new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    edit(sprint, j => {
      const v = j.features[0].variations[0];
      v['harness-status'] = { state: 'build', 'state-engine': 'harness-development-grouped', 'sub-status': { state: step, 'state-engine': 'grouped-build' } };
      v['state-changes'] = [...(v['state-changes'] ?? []), { 'state-engine': 'harness-development-grouped', 'from-state': 'build', 'to-state': 'build', 'sub-state-change': { 'state-engine': 'grouped-build', 'from-state': 'await-dependencies', 'to-state': step }, timestamp: entered, 'agent-dispatch-log': [], 'work-is-done': false }];
    });
    return entered;
  };
  // failFetches(n): the VM's next n fetches fail with a connection reset.
  const left = join(s.v.dir, 'fetch-failures');
  const failFetches = n => writeFileSync(left, String(n));
  failFetches(0);
  s.v.inVm('git', `if [[ " $* " == *" fetch "* ]]; then n=$(cat '${left}'); if (( n > 0 )); then echo $((n - 1)) > '${left}'; echo "fatal: unable to access 'https://gitlab.com/g/example-corpus.git/': Recv failure: Connection reset by peer" >&2; exit 128; fi; fi; exec '${realGit}' "$@"`);
  const failure = () => s.refresh().then(() => assert.fail('it passed'), e => e);
  const shells = () => s.v.calls().filter(c => c.vm === 'abc-3-a').length;
  return { ...s, variation, atStep, failFetches, failure, shells };
}

test('ASS-396 AC1, AC3: a fetch reset twice is retried in the command and the repository refreshed; a clean run reaches the VM once', async () => {
  const s = hiccups();
  s.atStep('refresh-repositories', 0);
  s.failFetches(2);
  const origin = git(s.origins['example-corpus'].work, 'rev-parse', 'HEAD');
  const { stdout } = await s.refresh();
  assert.match(stdout, /^example-corpus: brought from/m);
  assert.deepEqual(s.head(s.ref), [origin, 'master']);
  // +1 each run that got through: ASS-503's deps install (vm_install_deps), one shell after the refresh's.
  assert.equal(s.shells(), 3 + 1, 'the VM reached 3 times, then the install');
  assert.deepEqual([s.variation()['refresh-wait'], s.variation()['ai-feedback-short']], [undefined, undefined]);
  await s.refresh();
  assert.equal(s.shells(), 4 + 2);
});

test('ASS-396 AC1, AC3: a VM not reached after 3 tries waits (exit 2), its feedback saying so; a later timer tick that reaches it refreshes and clears the feedback', async () => {
  const s = hiccups();
  const entered = s.atStep('refresh-before-testing', 5);
  s.v.unreachable('abc-3-a');
  const e = await s.failure();
  assert.equal(e.code, 2, e.stderr);
  assert.equal(s.shells(), 3, 'tried 3 times');
  const short = n => `Refresh Repositories: can't reach the VM (abc-3-a), retrying (attempt ${n}, since ${entered})`;
  assert.equal(s.variation()['ai-feedback-short'], short(1));
  assert.match(s.variation()['ai-feedback-long'], /limactl shell abc-3-a \(exit 255\): ssh: connect to host .* Connection refused/);
  assert.deepEqual(s.variation()['refresh-wait'], { entered, since: entered, attempt: 1, feedback: s.variation()['ai-feedback-long'] });
  assert.equal((await s.failure()).code, 2);
  assert.equal(s.variation()['ai-feedback-short'], short(2));
  rmSync(join(s.v.instances, 'abc-3-a', 'unreachable'));
  assert.match((await s.refresh()).stdout, /^example-corpus: brought from/m);
  assert.deepEqual([s.variation()['refresh-wait'], s.variation()['ai-feedback-short'], s.variation()['ai-feedback-long']], [undefined, null, null]);
});

test('ASS-396 AC1, AC3: a fetch still failing 30 minutes after the step was entered exits 3 (Blocked), its output naming the failing call and its last error; run elsewhere it exits 3 at once', async () => {
  const s = hiccups();
  s.atStep('refresh-repositories', 29);
  s.failFetches(100);
  assert.equal((await s.failure()).code, 2, 'under 30 minutes: waits');
  assert.match(s.variation()['ai-feedback-short'], /^Refresh Repositories: can't reach the forge, from the VM \(abc-3-a\), retrying \(attempt 1, since /);
  const entered = s.atStep('refresh-repositories', 31);
  const e = await s.failure();
  assert.equal(e.code, 3, e.stderr);
  const out = JSON.parse(e.stdout);
  assert.equal(out['ai-feedback-short'], `Refresh Repositories: still can't reach the forge, from the VM (abc-3-a) after 30 minutes (attempt 1, since ${entered}); Blocked`);
  assert.match(out['ai-feedback-long'], /What kept failing, with its last error:\nexample-corpus: git fetch origin in the VM: fatal: unable to access .*Connection reset by peer/);
  assert.equal(s.variation()['refresh-wait'], undefined);
  // Not at a grouped-build Refresh step (by hand): 3 at once, nothing written.
  edit(join(s.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), j => { delete j.features[0].variations[0]['harness-status']['sub-status']; });
  assert.equal((await s.failure()).code, 3);
  assert.equal(s.variation()['refresh-wait'], undefined);
});

test('ASS-396 AC2: a fetch failing for want of a repository is not retried: left as is, the step succeeding, as before', async () => {
  const s = hiccups();
  s.atStep('refresh-repositories', 0);
  const work = s.origins['example-corpus'].work;
  renameSync(work, `${work}.gone`);
  assert.match((await s.refresh()).stdout, /^example-corpus: left as is: could not fetch$/m);
  assert.equal(s.shells(), 1 + 1, 'once, then ASS-503\'s deps install');
});

// ASS-503: after a refresh, each repository whose pnpm-lock.yaml differs from the one its node_modules was installed
// from (the harness's stamp, node_modules/.harness-installed-lock.yaml) gets `pnpm install --frozen-lockfile`, a line
// on stderr per pnpm repository saying installed or skipped; a failed install fails the command, naming the repository.
// The VM's pnpm a stub: logs "<cwd>|<args>|CI=<CI>", makes node_modules, exits per <dir>/pnpm-exit-<repo> or <dir>/pnpm-exit.
function pnpmStub(v) {
  const log = join(v.dir, 'pnpm.log');
  v.inVm('pnpm', `echo "$(pwd -P)|$*|CI=\${CI-}" >> '${log}'; mkdir -p node_modules
rc=$(cat "${v.dir}/pnpm-exit-$(basename "$PWD")" 2>/dev/null || cat '${v.dir}/pnpm-exit' 2>/dev/null || echo 0)
[ "$rc" -eq 0 ] || echo "ERR_STUB_PNPM: lockfile broken in $(basename "$PWD")" >&2
exit "$rc"`);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => { const [cwd, args, ci] = l.split('|'); return { cwd, args, ci }; }) : []);
  const fail = (code, repo) => writeFileSync(join(v.dir, repo ? `pnpm-exit-${repo}` : 'pnpm-exit'), String(code));
  return { calls, fail };
}
// lockfile(dir, text): pnpm-lock.yaml (node_modules ignored, as a pnpm repository has it) committed in dir.
function lockfile(dir, text) {
  writeFileSync(join(dir, 'pnpm-lock.yaml'), text); writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  git(dir, 'add', '.'); git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'lockfile');
}
const STAMP = ['node_modules', '.harness-installed-lock.yaml'];
const deps = s => { const p = pnpmStub(s.v); return { ...s, ...p, stamp: r => join(r, ...STAMP), lock: r => readFileSync(join(r, 'pnpm-lock.yaml'), 'utf8') }; };

test('ASS-503 AC1: a reference repository whose pnpm-lock.yaml changed (no stamp) gets `pnpm install --frozen-lockfile` with CI=true, logged "installed", its stamp the lockfile; a repository with no lockfile gets nothing', async () => {
  const s = deps(setup());
  lockfile(s.origins['example-corpus'].work, 'lockfileVersion: 9.0\n');
  const { stderr } = await s.refresh();
  assert.deepEqual(s.calls(), [{ cwd: realpathSync(s.ref), args: 'install --frozen-lockfile', ci: 'CI=true' }]);
  assert.match(stderr, /example-corpus: deps installed \(pnpm-lock\.yaml changed\)/);
  assert.doesNotMatch(stderr, /harness: deps/);
  assert.equal(readFileSync(s.stamp(s.ref), 'utf8'), s.lock(s.ref));
});

test('ASS-503 AC1: the ticket\'s own repository, its lockfile changed, is installed too, its checkout untouched', async () => {
  const s = deps(setup());
  lockfile(s.own, 'lockfileVersion: 9.0\nown: 1\n');
  const before = s.head(s.own);
  const { stderr } = await s.refresh();
  assert.deepEqual(s.calls(), [{ cwd: realpathSync(s.own), args: 'install --frozen-lockfile', ci: 'CI=true' }]);
  assert.match(stderr, /harness: deps installed \(pnpm-lock\.yaml changed\)/);
  assert.deepEqual(s.head(s.own), before);
  assert.equal(readFileSync(s.stamp(s.own), 'utf8'), s.lock(s.own));
});

test('ASS-503 AC1: a lockfile edited since its stamp is installed again, the stamp updated; node_modules removed (stamp gone), installed again', async () => {
  const s = deps(setup()), work = s.origins['example-corpus'].work;
  lockfile(work, 'lockfileVersion: 9.0\n');
  await s.refresh();
  lockfile(work, 'lockfileVersion: 9.0\nchanged: 1\n');
  const { stderr } = await s.refresh();
  assert.equal(s.calls().length, 2);
  assert.match(stderr, /example-corpus: deps installed \(pnpm-lock\.yaml changed\)/);
  assert.equal(readFileSync(s.stamp(s.ref), 'utf8'), 'lockfileVersion: 9.0\nchanged: 1\n');
  rmSync(join(s.ref, 'node_modules'), { recursive: true });
  assert.match((await s.refresh()).stderr, /example-corpus: deps installed \(pnpm-lock\.yaml changed\)/);
  assert.equal(s.calls().length, 3);
  assert.equal(readFileSync(s.stamp(s.ref), 'utf8'), s.lock(s.ref));
});

test('ASS-503 AC2: a second refresh with no lockfile change skips the repository, logged "skipped", no install; its stamp is its lockfile', async () => {
  const s = deps(setup());
  lockfile(s.origins['example-corpus'].work, 'lockfileVersion: 9.0\n');
  await s.refresh();
  assert.equal(s.calls().length, 1);
  const { stderr } = await s.refresh();
  assert.equal(s.calls().length, 1, 'no second install');
  assert.match(stderr, /example-corpus: deps skipped \(pnpm-lock\.yaml unchanged\)/);
  assert.equal(readFileSync(s.stamp(s.ref), 'utf8'), s.lock(s.ref));
});

test('ASS-503 AC3: a failing install exits 1 (not waiting, blocked or retried), stderr naming the repository, the VM and pnpm\'s own error; no stamp, so the next run tries again', async () => {
  const s = deps(setup());
  lockfile(s.origins['example-corpus'].work, 'lockfileVersion: 9.0\n');
  s.fail(1);
  const e = await s.refresh().then(() => assert.fail('it passed'), e => e);
  assert.equal(e.code, 1, e.stderr);
  assert.match(e.stderr, /example-corpus: pnpm install --frozen-lockfile failed/);
  assert.match(e.stderr, /dependencies could not be installed in abc-3-a/);
  assert.match(e.stderr, /ERR_STUB_PNPM: lockfile broken in example-corpus/);
  assert.ok(!existsSync(s.stamp(s.ref)), 'no stamp');
  s.fail(0);
  await s.refresh();
  assert.equal(s.calls().length, 2, 'tried again');
  assert.equal(readFileSync(s.stamp(s.ref), 'utf8'), s.lock(s.ref));
});

test('ASS-503 AC3: of two repositories to install, one failing: the other is still installed and stamped, exit 1, only the failing one named', async () => {
  const s = deps(setup());
  lockfile(s.origins['example-corpus'].work, 'lockfileVersion: 9.0\n');
  lockfile(s.own, 'lockfileVersion: 9.0\nown: 1\n');
  s.fail(1, 'example-corpus');
  const e = await s.refresh().then(() => assert.fail('it passed'), e => e);
  assert.equal(e.code, 1, e.stderr);
  assert.equal(s.calls().length, 2);
  assert.match(e.stderr, /example-corpus: pnpm install --frozen-lockfile failed/);
  assert.doesNotMatch(e.stderr, /harness: pnpm install --frozen-lockfile failed/);
  assert.match(e.stderr, /harness: deps installed \(pnpm-lock\.yaml changed\)/);
  assert.equal(readFileSync(s.stamp(s.own), 'utf8'), s.lock(s.own));
  assert.ok(!existsSync(s.stamp(s.ref)));
});

test('ASS-503 AC1: a project with no repositories reaches the VM no more than before; a listed repository with no checkout gets no line and no failure', async () => {
  const s = deps(setup());
  const project = join(s.f.dir, 'projects', 'p', 'project.json');
  const shells = () => s.v.calls().filter(c => c.vm === 'abc-3-a').length;
  edit(project, p => { p.repositories = []; });
  await s.refresh();
  assert.equal(shells(), 0, 'no shell into the VM');
  edit(project, p => { p.repositories = [{ url: 'https://github.com/o/harness' }, { url: 'https://gitlab.com/g/example-corpus.git' }, { url: 'https://github.com/o/missing' }]; });
  lockfile(s.origins['example-corpus'].work, 'lockfileVersion: 9.0\n');
  const { stderr } = await s.refresh();
  assert.doesNotMatch(stderr, /missing: (deps|pnpm)/);
  assert.match(stderr, /example-corpus: deps installed/);
});

test('ASS-503 AC1: a refresh that waits (exit 2) or is Blocked (exit 3) installs nothing', async () => {
  const s = hiccups(), p = pnpmStub(s.v);
  lockfile(s.own, 'lockfileVersion: 9.0\n');
  s.atStep('refresh-repositories', 0);
  s.v.unreachable('abc-3-a');
  assert.equal((await s.failure()).code, 2);
  rmSync(join(s.v.instances, 'abc-3-a', 'unreachable'));
  s.atStep('refresh-repositories', 31);
  s.failFetches(100);
  assert.equal((await s.failure()).code, 3);
  assert.deepEqual(p.calls(), []);
});
