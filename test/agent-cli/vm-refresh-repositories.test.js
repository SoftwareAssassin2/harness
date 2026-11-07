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
import { writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { lima, git, edit } from './vm-fixture.js';

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
