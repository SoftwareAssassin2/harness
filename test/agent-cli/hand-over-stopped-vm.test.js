// ASS-577: a ticket's Lima VM is stopped between its steps (ASS-527), so code:hand-over found it stopped and Lima
// refused to bundle its branches ("instance `…` is stopped, run `limactl start …`"), retried forever. AC1: the hand-over
// starts it (vm:start), bundles and pushes, moves the branches to the new target, and stops it again — onto a Substrate
// sandbox (the live case, through the Mac's relay) and onto a Mac worktree; a VM running already is left as it is; a
// hand-over that fails after starting it still stops it. AC3: a VM that no longer exists is said so, the branches are
// taken from the forge (or what was lost is said), and the hand-over finishes — so it is never retried for ever.
// The fake limactl refuses a shell or copy into a stopped instance here (FAKE_LIMA_REFUSE_STOPPED), as Lima does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, edit } from './workstation-fixture.js';
import { fakeVm } from '../support/fake-vm.js';
import { sandboxed, branchOnOrigin } from './sandbox-fixture.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };

// withVm({ status, exists }) — sandboxed()'s project p, and ABC-3 A's Lima VM abc-3-a as vm:start finds one (its ssh
// port pinned, its tmpfs, sudo and lima0 faked), `status`, its /repos/harness a clone of origin; the variation records
// it and no run-target (last worked on local-vm before run targets existed, as ABC-89 A). exists false: recorded only.
async function withVm({ status = 'Stopped', exists = true } = {}) {
  const t = await sandboxed();
  const vm = fakeVm(t.s.env);
  Object.assign(t.s.env, { ...vm.env, LIMA_HOME: vm.instances, FAKE_LIMA_REFUSE_STOPPED: '1', ...IDENTITY });
  vm.script('sandbox-exec', '[[ "$1" == -p ]] || exit 2; shift 2; exec "$@"');
  vm.inVm('sudo', 'exec "$@"');
  vm.inVm('findmnt', 'echo tmpfs');
  vm.inVm('mountpoint', '[[ "$1" == -q && -d "$2" ]]');
  vm.inVm('ip', 'echo "3: lima0    inet 192.168.64.15/24 brd 192.168.64.255 scope global dynamic lima0"');
  for (const d of ['run', join('etc', 'profile.d'), join('usr', 'local', 'bin')]) mkdirSync(join(vm.root, d), { recursive: true });
  edit(t.s.at('harness.json'), h => { h['vm-disk-limit-gb'] = 100; });   // vm:stop reconciles the inventory against it
  vm.script('df', `echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'; echo '/dev/fake 1000000000 1 999999999 1% /'`);
  const inVm = join(vm.root, 'repos', 'harness');
  execFileSync('git', ['clone', '-q', t.s.origins.harness, inVm]);
  if (exists) vm.instance('abc-3-a', status, String(40000 + Math.floor(Math.random() * 20000)));
  assert.equal((await t.s.result('ticket:set-vm', 'p', 'ABC-3', 'A', 'abc-3-a', '')).code, 0);
  const statusOf = () => readFileSync(join(vm.instances, 'abc-3-a', 'status'), 'utf8').trim();
  const lifecycle = () => vm.calls().filter(c => c.argv && ['start', 'stop'].includes(c.argv[0])).map(c => c.argv[0]);
  return { ...t, vm, inVm, statusOf, lifecycle };
}

// A commit on change/ABC-3-1 in the VM, never pushed, and a file left uncommitted: the work its last step left there.
function workInVm(inVm) {
  git(inVm, 'checkout', '-q', '-b', 'change/ABC-3-1');
  writeFileSync(join(inVm, 'feature.txt'), 'built in the VM\n');
  git(inVm, 'add', '.'); git(inVm, 'commit', '-q', '-m', 'ABC-3: built in the VM');
  writeFileSync(join(inVm, 'loose.txt'), 'left over\n');
}

test('AC1: from a stopped Lima VM onto a Substrate sandbox, code:hand-over starts the VM, bundles and pushes its branches, brings them into the sandbox, and stops the VM again', async () => {
  const t = await withVm();
  workInVm(t.inVm);
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);   // control makes the sandbox first
  const h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-substrate');
  assert.equal(h.code, 0, h.err);
  assert.deepEqual([h.json.from, h.json.to, h.json.branch, h.json['started-vm'], h.json['stopped-again']], ['local-vm', 'local-substrate', 'change/ABC-3-1', 'abc-3-a', true], h.err);
  assert.equal(t.statusOf(), 'Stopped', 'stopped again');
  assert.deepEqual(t.lifecycle(), ['start', 'stop'], 'started once for the hand-over, stopped once after it');
  // The branch, its leftovers committed on the way, is on origin and checked out in the sandbox.
  const box = join(t.root('abc-3-a'), 'repos', 'harness');
  assert.equal(git(box, 'symbolic-ref', '--short', 'HEAD'), 'change/ABC-3-1');
  assert.equal(readFileSync(join(box, 'feature.txt'), 'utf8'), 'built in the VM\n');
  assert.equal(readFileSync(join(box, 'loose.txt'), 'utf8'), 'left over\n');
  assert.equal(execFileSync('git', ['--git-dir', t.s.origins.harness, 'log', '-1', '--format=%s', 'change/ABC-3-1'], { encoding: 'utf8' }).trim(), 'ABC-3: work left uncommitted on local-vm');
  assert.equal(t.s.variation('A')['run-target'].target, 'local-substrate');
  // vm:start ran as it always does: its forwarder token issued for the VM.
  assert.ok(t.s.tokens()['abc-3-a'], 'a forwarder token for the VM');
});

test('AC1: from a stopped Lima VM onto a Mac worktree, the branch is pushed from the started VM, the worktree made from it, and the VM stopped again', async () => {
  const t = await withVm();
  const ws = join(mkdtempSync(join(tmpdir(), 'ws-')), 'harness');
  execFileSync('git', ['clone', '-q', t.s.origins.harness, ws]);
  edit(t.s.at('projects', 'p', 'project.json'), p => { p['local-environments'] = [{ name: 'local-pc', type: 'local-pc', folder: ws }]; });
  workInVm(t.inVm);
  const h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-worktree');
  assert.equal(h.code, 0, h.err);
  assert.deepEqual([h.json.from, h.json.branch, h.json['started-vm'], h.json['stopped-again']], ['local-vm', 'change/ABC-3-1', 'abc-3-a', true]);
  assert.equal(readFileSync(join(h.json.folder, 'feature.txt'), 'utf8'), 'built in the VM\n');
  assert.equal(readFileSync(join(h.json.folder, 'loose.txt'), 'utf8'), 'left over\n');
  assert.equal(t.statusOf(), 'Stopped');
  assert.deepEqual(t.lifecycle(), ['start', 'stop']);
});

test('AC1: a VM running already is handed over from as it is — neither started nor stopped', async () => {
  const t = await withVm({ status: 'Running' });
  workInVm(t.inVm);
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  const h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-substrate');
  assert.equal(h.code, 0, h.err);
  assert.equal(h.json['started-vm'], undefined);
  assert.equal(t.statusOf(), 'Running');
  assert.deepEqual(t.lifecycle(), []);
});

test('AC1: a hand-over that fails after starting the VM (its branch diverged from origin\'s) still stops it again, and fails as before', async () => {
  const t = await withVm();
  branchOnOrigin(t.s);   // origin's change/ABC-3-1 has a commit the VM's lacks
  workInVm(t.inVm);
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  const h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-substrate');
  assert.notEqual(h.code, 0);
  assert.match(h.err, /could not be pushed to origin/);
  assert.equal(t.statusOf(), 'Stopped', 'stopped again on the way out');
  assert.deepEqual(t.lifecycle(), ['start', 'stop']);
  assert.notEqual(t.s.variation('A')['run-target']?.target, 'local-substrate', 'nothing recorded');
});

test('AC3: a VM that no longer exists — the hand-over says so, takes the branch from the forge, says what was lost, and finishes (no retry for ever)', async () => {
  const t = await withVm({ exists: false });
  const sha = branchOnOrigin(t.s);
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  const h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-substrate');
  assert.equal(h.code, 0, h.err);
  assert.equal(h.json['missing-vm'], 'abc-3-a');
  assert.match(h.json.lost, /^whatever abc-3-a held that was never pushed \(on the forge: harness change\/ABC-3-1\)$/);
  assert.match(h.err, /ABC-3 A's Lima VM abc-3-a no longer exists; its branches are taken from the forge instead/);
  assert.equal(git(join(t.root('abc-3-a'), 'repos', 'harness'), 'rev-parse', 'HEAD'), sha, 'the forge\'s branch in the sandbox');
  assert.equal(t.s.variation('A')['run-target'].target, 'local-substrate', 'recorded: control does not hand over again');
  assert.deepEqual(t.lifecycle(), [], 'nothing started');
});

test('AC3: a VM gone and nothing of the variation on the forge — all its work there is said lost, and the hand-over still finishes; onto a Mac worktree the branch is the forge\'s too', async () => {
  const t = await withVm({ exists: false });
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  const h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-substrate');
  assert.equal(h.code, 0, h.err);
  assert.equal(h.json.lost, 'all of ABC-3 A\'s work in abc-3-a: none of its branches is on the forge');
  assert.equal(t.s.variation('A')['run-target'].target, 'local-substrate');
  // Onto a Mac worktree from a VM gone (no run-target recorded, its branch pushed by an earlier step): the forge's branch.
  const u = await withVm({ exists: false });
  const sha = branchOnOrigin(u.s);
  const ws = join(mkdtempSync(join(tmpdir(), 'ws-')), 'harness');
  execFileSync('git', ['clone', '-q', u.s.origins.harness, ws]);
  edit(u.s.at('projects', 'p', 'project.json'), p => { p['local-environments'] = [{ name: 'local-pc', type: 'local-pc', folder: ws }]; });
  const w = await u.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-worktree');
  assert.equal(w.code, 0, w.err);
  assert.deepEqual([w.json.branch, w.json['missing-vm']], ['change/ABC-3-1', 'abc-3-a']);
  assert.equal(git(w.json.folder, 'rev-parse', 'HEAD'), sha);
});

test('AC3: a limactl that fails while the VM\'s instance is still there is not taken for a VM gone: the hand-over fails, nothing taken from the forge', async () => {
  const t = await withVm();
  workInVm(t.inVm);
  // A limactl of its own first on the PATH (never written over the fake's symlink): every call fails.
  const broken = mkdtempSync(join(tmpdir(), 'broken-'));
  writeFileSync(join(broken, 'limactl'), '#!/bin/bash\necho "limactl: broken" >&2; exit 1\n', { mode: 0o755 });
  t.s.env.PATH = `${broken}:${t.s.env.PATH}`;
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  const h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-substrate');
  assert.notEqual(h.code, 0);
  assert.match(h.err, /could not read the state of ABC-3 A's Lima VM abc-3-a/);
  assert.equal(h.json?.['missing-vm'], undefined);
});
