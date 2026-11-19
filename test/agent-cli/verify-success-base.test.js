// ASS-509 AC4/AC5: automated-tests:verify-success in a ticket's VM. "Red on
// master" is decided against the current origin/<base>, fetched for that
// check — never the VM's stale copy — and the block names the commit
// compared; and a branch behind its origin/<base> has the base brought in
// (rebased, pushed) before any test runs, so a re-run after master moved is
// not doomed to repeat. limactl is test/support/fake-limactl.js, the VM's
// root a folder of real git checkouts whose origin is a local repository
// (vm-fixture.js: harness on main, its origin moved on since the clone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { lima, git, edit } from './vm-fixture.js';
import { run, AGENT } from './harness-fixture.js';

const commit = (dir, files, message) => {
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); }
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', message);
};

// ABC-3 A in its VM abc-3-a; harness checked out on change/ABC-3-1 (a commit of its own); origin's main then gains
// `lands`, never fetched in the VM. `mrs` its merge requests; the recorded test runs `check` in harness.
function setup({ lands, check, mrs = [] }) {
  const l = lima();
  l.v.instance('abc-3-a', 'Running');
  edit(join(l.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    Object.assign(s.features[0].variations[0], { vm: { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-11-18T00:00:00Z' }, 'merge-request': mrs });
  });
  const own = l.vmFile('repos', 'harness'), origin = l.origins.harness.work;
  for (const dir of [own, origin]) { git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 'T'); }
  git(own, 'checkout', '-q', '-b', 'change/ABC-3-1');
  commit(own, { 'src/feature.js': 'mine\n' }, 'mine');
  git(own, 'push', '-q', 'origin', 'change/ABC-3-1');
  commit(origin, lands, 'main moves on');
  writeFileSync(join(l.folder, 'automated-tests-A.json'), JSON.stringify([{ list: 'cd harness && echo listed', run: `cd harness && ${check}` }]));
  return { ...l, own, origin, verify: () => l.cli('automated-tests:verify-success', 'p', 'ABC-3', 'A'),
    // control's own run of the step (the forwarder's CATCH_UP_BASE, no agent at work) or a re-check
    asStep: () => run(AGENT, ['automated-tests:verify-success', 'p', 'ABC-3', 'A'], { env: { ...l.env, CATCH_UP_BASE: '1' } }), results: () => readFileSync(join(l.folder, 'automated-test-results-A.md'), 'utf8') };
}

test('ASS-509 AC4: red on the VM\'s stale origin/main but green on the current one is the branch\'s failure, not master\'s — exit 1, never "red on master too"; the commit compared is the one just fetched', async () => {
  const s = setup({ lands: { 'fixed.txt': 'fixed\n' }, check: 'test -f fixed.txt' });   // no merge request: nothing brought in first
  const stale = git(s.own, 'rev-parse', 'origin/main');
  const e = await s.verify().then(() => assert.fail('it passed'), x => x);
  assert.equal(e.code, 1, e.stderr);
  assert.doesNotMatch(e.stderr, /red on master too/);
  const current = git(s.origin, 'rev-parse', 'main');
  assert.notEqual(stale, current);
  assert.equal(git(s.own, 'rev-parse', 'origin/main'), current, 'fetched for the check');
  assert.equal(JSON.parse(readFileSync(join(s.folder, 'automated-test-baseline-A.json'), 'utf8')).master.includes(current), true, 'compared with the current origin/main');
  assert.match(s.results(), /New failures, not failing on master/);
});

test('ASS-509 AC4: red on the current origin/main too, the block names the commit compared', async () => {
  const s = setup({ lands: { 'other.txt': 'x\n' }, check: 'echo boom; exit 2' });
  const e = await s.verify().then(() => assert.fail('it passed'), x => x);
  assert.equal(e.code, 3, e.stderr);
  const current = git(s.origin, 'rev-parse', 'main');
  assert.match(s.results(), new RegExp(`red on master too \\(origin's default branch, fetched for this check: harness at ${current}\\)`));
  assert.match(s.results(), new RegExp(`### On master \\(exit 2; origin's default branch, fetched for this check: harness at ${current}\\)`));
});

test('ASS-509 AC5: a branch behind its origin/<base> has the base brought in before the tests run — merged in (its merge request open) and pushed — so a check reading the base\'s files as deleted passes; said at the top of the results', async () => {
  const s = setup({
    lands: { 'db/R__report.sql': 'report\n' }, check: 'test -f db/R__report.sql',
    mrs: [{ id: 1, repository: 'https://github.com/o/harness', branch: 'change/ABC-3-1', base: 'main', contents: 'c', 'depends-on': [], status: 'Open', key: '#5', url: null, 'build-status': null }],
  });
  // An agent's call (no CATCH_UP_BASE): the read-only check, as before — nothing brought in, nothing pushed.
  const pushed = git(s.origin, 'rev-parse', 'change/ABC-3-1');
  await s.verify().then(() => assert.fail('it passed'), e => assert.equal(e.code, 1, e.stderr));
  assert.equal(git(s.origin, 'rev-parse', 'change/ABC-3-1'), pushed);
  assert.doesNotMatch(s.results(), /Brought up to date/);
  assert.deepEqual(JSON.parse((await s.asStep()).stdout), { passed: 1, failed: 0 });
  assert.match(s.results(), /^# Automated test results — ABC-3 A, .*\n\nBrought up to date with the base first \(ASS-509\):\n- harness change\/ABC-3-1: merged — merged origin\/main .*\(plain push: its merge request #5 is open on the forge, so never rewritten/);
  assert.equal(git(s.origin, 'rev-list', '--count', 'change/ABC-3-1..main'), '0', 'pushed with the base in');
  assert.equal(git(s.own, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3-1');
  // A conflict is left as it was: the tests run on the branch as it stands.
  commit(s.origin, { 'src/feature.js': 'main\'s\n' }, 'main touches the same file');
  const before = git(s.own, 'rev-parse', 'HEAD');
  await s.asStep();
  assert.equal(git(s.own, 'rev-parse', 'HEAD'), before);
  assert.match(s.results(), /- harness change\/ABC-3-1: conflict — merging origin\/main .* into change\/ABC-3-1 does not apply cleanly: conflicts in src\/feature\.js/);
});
