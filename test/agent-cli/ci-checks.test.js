// ci-checks:verify (ASS-249): the grouped Build's CI Checks step runs, in
// the variation's VM, the merge-request CI checks a project declares in its
// golden-image folder's ci-checks.json, for each repository with a merge
// request not Closed — a check whose changes globs the diff misses skipped,
// CI_CHECK_BASE the merge base with origin/<base> — and passes when each
// passes or fails only as on master. limactl is test/support/fake-limactl.js;
// the VM's root a folder holding real git checkouts (vm-fixture.js: harness
// on main, example-corpus on master).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lima, git, edit } from './vm-fixture.js';
import { run, AGENT, idless } from './harness-fixture.js';

// ABC-3 A, its VM abc-3-a recorded and running; its plan an open merge
// request in harness (change/ABC-3-1, a commit adding src/app/fix.js) and a
// Closed one in example-corpus; project p's golden-image folder holding
// `checks` as ci-checks.json (none written when undefined; a function is
// given `log`, a file outside the VM's repositories a check may log to).
function setup(checks) {
  const l = lima(), golden = mkdtempSync(join(tmpdir(), 'golden-')), log = join(l.v.dir, 'runs.log');
  l.v.instance('abc-3-a', 'Running');
  if (typeof checks === 'function') checks = checks(log);
  edit(join(l.f.dir, 'projects', 'p', 'project.json'), p => { p['golden-image'] = { folder: golden }; });
  edit(join(l.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    Object.assign(s.features[0].variations[0], {
      vm: { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' },
      'merge-request': [
        { id: 1, repository: 'https://github.com/o/harness', branch: 'change/ABC-3-1', base: 'main', contents: 'c', 'depends-on': [], status: 'Open', key: null, url: null, 'build-status': null },
        { id: 2, repository: 'https://gitlab.com/g/example-corpus.git', branch: 'change/ABC-3-2', contents: 'c', 'depends-on': [], status: 'Closed', key: null, url: null, 'build-status': null },
      ],
    });
  });
  if (checks !== undefined) writeFileSync(join(golden, 'ci-checks.json'), typeof checks === 'string' ? checks : JSON.stringify(checks));
  const own = l.vmFile('repos', 'harness');
  git(own, 'config', 'user.email', 't@example.com'); git(own, 'config', 'user.name', 'T');
  git(own, 'checkout', '-q', '-b', 'change/ABC-3-1');
  mkdirSync(join(own, 'src', 'app'), { recursive: true });
  writeFileSync(join(own, 'src', 'app', 'fix.js'), 'fix\n'); git(own, 'add', '.'); git(own, 'commit', '-q', '-m', 'fix');
  const results = join(l.folder, 'ci-checks-results-A.md');
  return {
    ...l, own, golden, log,
    verify: () => l.cli('ci-checks:verify', 'p', 'ABC-3', 'A'),
    failure: () => l.cli('ci-checks:verify', 'p', 'ABC-3', 'A').then(() => assert.fail('it passed'), e => e),
    results: () => readFileSync(results, 'utf8'),
    hasResults: () => existsSync(results),
    runs: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    shells: () => l.v.calls().filter(c => c.vm === 'abc-3-a'),
  };
}
const checksFor = (repo, list) => ({ repositories: { [repo]: list } });
const MASTER_SHA = s => git(s.own, 'rev-parse', 'origin/main');

test('ASS-249 AC2: each declared check runs in the VM in /repos/<repo>, every one whatever the ones before did, CI_CHECK_BASE the merge base with origin/<base>; the results — job, command, exit, output — go to the ticket folder, replaced each run', async () => {
  const s = setup(checksFor('harness', [
    { name: 'secret-scan-mr', command: 'echo "base=$CI_CHECK_BASE"; echo "in=$(basename "$PWD")"', baseline: false },
    { name: 'hygiene', command: 'echo hygiene ok' },
  ]));
  const { stdout } = await s.verify();
  assert.deepEqual(JSON.parse(stdout), { passed: 2, failed: 0, skipped: 0 });
  const base = git(s.own, 'merge-base', 'HEAD', 'origin/main');
  assert.match(s.results(), /^# CI check results — ABC-3 A, /);
  assert.match(s.results(), new RegExp(`## ✓ harness: secret-scan-mr \\(exit 0\\)\\n\\n\`echo "base=\\$CI_CHECK_BASE"; echo "in=\\$\\(basename "\\$PWD"\\)"\`\\n\\n\`\`\`\\nbase=${base}\\nin=harness\\n\`\`\``));
  assert.match(s.results(), /## ✓ harness: hygiene \(exit 0\)/);
  assert.ok(s.shells().some(c => c.workdir === '/repos/harness'), 'run in the VM, in /repos/harness');
  // The Closed merge request's repository runs nothing, though it declares checks.
  writeFileSync(join(s.golden, 'ci-checks.json'), JSON.stringify({ repositories: { harness: [{ name: 'lint', command: 'echo lint' }], 'example-corpus': [{ name: 'never', command: `echo never >> ${s.log}` }] } }));
  await s.verify();
  assert.deepEqual(s.runs(), []);
  assert.doesNotMatch(s.results(), /hygiene|secret-scan-mr/, 'replaced, not appended');
  assert.match(s.results(), /## ✓ harness: lint \(exit 0\)/);
});

test('ASS-249 AC2: a check with changes globs runs only when the merge request\'s diff touches one — ** across folders, * within one, {a,b} either — else it is skipped, named in the results', async () => {
  const s = setup(checksFor('harness', [
    { name: 'docs-only', command: 'echo docs', changes: ['docs/**', '*.md'] },
    { name: 'app-js', command: 'echo app', changes: ['src/**/*.{js,ts}'] },
    { name: 'top-js', command: 'echo top', changes: ['*.js'] },
    { name: 'always', command: 'echo always' },
  ]));
  assert.deepEqual(JSON.parse((await s.verify()).stdout), { passed: 2, failed: 0, skipped: 2 });
  assert.match(s.results(), /## – harness: docs-only \(skipped: the merge request changes none of docs\/\*\*, \*\.md\)/);
  assert.match(s.results(), /## – harness: top-js \(skipped/);
  assert.match(s.results(), /## ✓ harness: app-js \(exit 0\)/);
  // A change not yet committed counts too, as the checkout holds it.
  writeFileSync(join(s.own, 'NOTES.md'), 'x\n');
  assert.deepEqual(JSON.parse((await s.verify()).stdout), { passed: 3, failed: 0, skipped: 1 });
});

test('ASS-249 AC3: a check failing on the branch and not on master exits 1 (back to Generate Solution); master\'s run is in the same repository, switched to origin/<base> and back, recorded by master\'s SHA and run again only when master moves', async () => {
  const s = setup(log => checksFor('harness', [{ name: 'policy', command: `git rev-parse --abbrev-ref HEAD >> ${log}; ! test -f src/app/fix.js || { echo "policy: src/app/fix.js not allowed"; exit 1; }` }]));
  const e = await s.failure();
  assert.equal(e.code, 1, e.stderr);
  assert.match(e.stderr, /1 of 1 failed/);
  assert.deepEqual(s.runs(), ['change/ABC-3-1', 'HEAD']);                    // the branch, then master
  assert.equal(git(s.own, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3-1');   // and back
  assert.match(s.results(), /## ✗ harness: policy \(exit 1\)\n\nNew failure: the command exits 1, and 0 on master\n\n`[^`]+`\n\n```\npolicy: src\/app\/fix\.js not allowed\n```/);
  const baseline = JSON.parse(readFileSync(join(s.folder, 'ci-checks-baseline-A.json'), 'utf8'));
  assert.equal(baseline.harness.master, MASTER_SHA(s));
  await s.failure();
  assert.deepEqual(s.runs(), ['change/ABC-3-1', 'HEAD', 'change/ABC-3-1'], 'master\'s run kept');
  // Master moves (origin/main fetched a commit on): run on master again.
  git(s.origins.harness.work, 'commit', '-q', '--allow-empty', '-m', 'three'); git(s.own, 'fetch', '-q', 'origin');
  await s.failure();
  assert.deepEqual(s.runs().slice(3), ['change/ABC-3-1', 'HEAD']);
  assert.equal(JSON.parse(readFileSync(join(s.folder, 'ci-checks-baseline-A.json'), 'utf8')).harness.master, MASTER_SHA(s));
});

test('ASS-249 AC3: a check red on master as on the branch passes (exit 0), noted as failing as on master; a baseline: false check has no master run, so its failure is always new', async () => {
  const s = setup(checksFor('harness', [{ name: 'red-everywhere', command: 'echo "3 violations"; exit 1' }]));
  assert.deepEqual(JSON.parse((await s.verify()).stdout), { passed: 1, failed: 0, skipped: 0 });
  assert.match(s.results(), /## ✓ harness: red-everywhere \(exit 1: fails as it does on master\)/);
  assert.match(s.results(), /### On master \(exit 1\)\n\n```\n3 violations\n```/);
  writeFileSync(join(s.golden, 'ci-checks.json'), JSON.stringify(checksFor('harness', [{ name: 'secret-scan-mr', command: `git rev-parse --abbrev-ref HEAD >> ${s.log}; echo "leak found"; exit 1`, baseline: false }])));
  const e = await s.failure();
  assert.equal(e.code, 1, e.stderr);
  assert.deepEqual(s.runs(), ['change/ABC-3-1'], 'never run on master');
  assert.match(s.results(), /## ✗ harness: secret-scan-mr \(exit 1\)\n\nNew failure: the command exits 1 \(baseline: false — no master run\)/);
});

test('ASS-249 AC3: a check that could not run — exit 125/126/127, or a not-runnable pattern — exits 3 (Blocked), not 1, the others still run; a new failure beside it still exits 3', async () => {
  for (const command of ['no-such-scanner --mr', 'exit 126', 'echo "Error: Cannot find module \'conftest\'" >&2; exit 1']) {
    const s = setup(checksFor('harness', [{ name: 'broken', command }, { name: 'after', command: 'echo ran after' }]));
    const e = await s.failure();
    assert.equal(e.code, 3, command);
    assert.match(e.stderr, /could not run 1 of 2: an environment problem, not a failed check/, command);
    assert.match(s.results(), /## ⚠ harness: broken \(exit \d+: could not run\)/, command);
    assert.match(s.results(), /## ✓ harness: after \(exit 0\)/, command);
  }
  const s = setup(checksFor('harness', [{ name: 'broken', command: 'exit 127' }, { name: 'new-red', command: '! test -f src/app/fix.js' }]));
  assert.equal((await s.failure()).code, 3);
  assert.match(s.results(), /## ✗ harness: new-red \(exit 1\)/);
});

// ASS-320: a check whose only NOT_RUNNABLE hit is a test runner's own result
// line (a passing ✔ name that holds "is not running") is runnable — red on the
// branch only exits 1 (## ✗), not "could not run"; a real error after such a
// line still exits 3.
test('ASS-320: a ✔ "… is not running …" result line does not make a red check "could not run"; a real error after such a line still does', async () => {
  // AC1: a ✔ result line then a branch-only failure (src/app/fix.js committed on the branch, absent on master) → runnable, master comparison runs, ## ✗ (exit 1), not could not run.
  const s = setup(log => checksFor('harness', [{ name: 'policy', command: `git rev-parse --abbrev-ref HEAD >> ${log}; echo "✔ ASS-159: whose VM is not running (1ms)"; ! test -f src/app/fix.js` }]));
  const e = await s.failure();
  assert.equal(e.code, 1, e.stderr);
  assert.match(e.stderr, /1 of 1 failed/);
  assert.doesNotMatch(e.stderr, /could not run/);
  assert.match(s.results(), /## ✗ harness: policy \(exit 1\)/);
  assert.doesNotMatch(s.results(), /could not run/);
  // AC2: a ✔ result line followed by a real environment error → still not runnable (exit 3, could not run).
  for (const command of ['echo "✔ ok (1ms)"; echo "bash: foo: command not found" >&2; exit 1', 'echo "✔ ok (1ms)"; echo "Error: No such container: x" >&2; exit 1']) {
    const t = setup(checksFor('harness', [{ name: 'broken', command }]));
    const err = await t.failure();
    assert.equal(err.code, 3, command);
    assert.match(err.stderr, /could not run 1 of 1: an environment problem, not a failed check/, command);
    assert.match(t.results(), /## ⚠ harness: broken \(exit \d+: could not run\)/, command);
  }
});

test('ASS-249 AC3: a project with no ci-checks.json, or none declared for the ticket\'s repositories, exits 0 with nothing run — not even the VM reached', async () => {
  const s = setup(undefined);
  assert.deepEqual(JSON.parse((await s.verify()).stdout), { passed: 0, failed: 0, skipped: 0 });
  assert.match(s.results(), /Nothing run: p declares no CI checks/);
  assert.deepEqual(s.shells(), []);
  const t = setup(checksFor('example-corpus', [{ name: 'lint', command: 'echo x' }]));
  assert.deepEqual(JSON.parse((await t.verify()).stdout), { passed: 0, failed: 0, skipped: 0 });
  assert.match(t.results(), /Nothing run: no repository the ticket changes declares a CI check/);
  assert.deepEqual(t.shells(), []);
  // A project with no golden-image folder at all declares none either.
  const u = setup(undefined);
  edit(join(u.f.dir, 'projects', 'p', 'project.json'), p => { delete p['golden-image']; });
  assert.equal((await u.verify()).stdout.trim(), JSON.stringify({ passed: 0, failed: 0, skipped: 0 }));
});

test('ASS-249 AC1: a malformed ci-checks.json fails the step (exit 3, Blocked: no code change fixes it) with a message naming the problem', async () => {
  for (const [checks, message] of [
    ['{ not json', /ci-checks\.json is not valid JSON/],
    [{ checks: [] }, /ci-checks\.json: "repositories" must be an object/],
    [{ repositories: { harness: {} } }, /repositories\.harness must be a list of checks/],
    [{ repositories: { harness: [{ command: 'true' }] } }, /repositories\.harness\[0\]: "name" must be a non-empty string/],
    [{ repositories: { harness: [{ name: 'x' }] } }, /repositories\.harness\[0\]: "command" must be a non-empty string/],
    [{ repositories: { harness: [{ name: 'x', command: 'true', changes: 'src/**' }] } }, /repositories\.harness\[0\]: "changes" must be a list of globs/],
    [{ repositories: { harness: [{ name: 'x', command: 'true', baseline: 'no' }] } }, /repositories\.harness\[0\]: "baseline" must be true or false/],
    [{ repositories: { harness: [{ name: 'x', command: 'true', basline: false }] } }, /repositories\.harness\[0\]: unknown key "basline"/],
    [{ repositories: { 'no-such-repo': [] } }, /names no-such-repo, not one of p's repositories/],
  ]) {
    const s = setup(checks);
    const e = await s.failure();
    assert.equal(e.code, 3, String(message));
    assert.match(e.stderr, message);
    assert.deepEqual(s.shells(), [], String(message));
  }
});

test('ASS-249: the results and baseline files are the harness\'s own: an agent cannot write them through work:write', async () => {
  const s = setup(undefined);
  for (const name of ['ci-checks-results.md', 'ci-checks-baseline.json']) {
    const e = await run(AGENT, ['work:write', 'p', 'ABC-3', 'A', name], { env: s.env }).then(() => null, error => error);
    assert.match(e?.stderr ?? '', /is the harness's own: not written/, name);
  }
});

test('ASS-321 AC2: an id-less merge-request entry (no repository), placed before the planned ones, does not abort verify.sh; the repository list and CI_CHECK_BASE still come from the planned entry alone', async () => {
  const s = setup(checksFor('harness', [{ name: 'hygiene', command: 'echo hygiene ok' }]));
  edit(join(s.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), j => {
    j.features[0].variations[0]['merge-request'].unshift(idless());
  });
  assert.deepEqual(JSON.parse((await s.verify()).stdout), { passed: 1, failed: 0, skipped: 0 });
  assert.match(s.results(), /## ✓ harness: hygiene \(exit 0\)/);
  assert.doesNotMatch(s.results(), /## ⚠ : /);
  const base = git(s.own, 'merge-base', 'HEAD', 'origin/main');
  assert.match(s.results(), new RegExp(`CI_CHECK_BASE for harness: ${base} `));
});

test('ASS-321 AC2: the same, with the id-less entry Closed — the null-repository guard and the Closed filter work together', async () => {
  const s = setup(checksFor('harness', [{ name: 'hygiene', command: 'echo hygiene ok' }]));
  edit(join(s.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), j => {
    j.features[0].variations[0]['merge-request'].unshift(idless({ status: 'Closed' }));
  });
  assert.deepEqual(JSON.parse((await s.verify()).stdout), { passed: 1, failed: 0, skipped: 0 });
});

test('ASS-321 AC2: a merge-request array holding only id-less entries (no repository) exits 0 with nothing run, as when the ticket declares no repository with a CI check', async () => {
  const s = setup(checksFor('harness', [{ name: 'hygiene', command: 'echo hygiene ok' }]));
  edit(join(s.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), j => {
    j.features[0].variations[0]['merge-request'] = [idless()];
  });
  assert.deepEqual(JSON.parse((await s.verify()).stdout), { passed: 0, failed: 0, skipped: 0 });
  assert.match(s.results(), /Nothing run: no repository the ticket changes declares a CI check/);
  assert.deepEqual(s.shells(), []);
});

test('ASS-249: with checks declared and no VM on the variation it exits 3, naming why', async () => {
  const s = setup(checksFor('harness', [{ name: 'lint', command: 'true' }]));
  edit(join(s.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), j => { delete j.features[0].variations[0].vm; });
  const e = await s.failure();
  assert.equal(e.code, 3);
  assert.match(e.stderr, /ABC-3 A has no VM/);
});
