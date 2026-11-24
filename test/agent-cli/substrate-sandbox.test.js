// ASS-535 AC1, AC6: a ticket variation's own Substrate sandbox — made from the project's image on the cluster of its
// seat's machine, started, run in (through the image's command server), stopped, deleted — on the Mac and on a remote
// machine, with a fake Substrate client: fake-substrate.js's kit (kubectl-ate keeps templates and actors in the fake
// cluster; its `proxy actor` serves fake-command-server.js, which runs commands here with the sandbox's / a folder of
// its own) on a fake Mac, or on a fake workstation reached over its fake SSH master (fake-workstation.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, ID } from './workstation-fixture.js';
import { fakeVm } from '../support/fake-vm.js';
import { sandboxed, branchOnOrigin, MACHINE_BASH, DIGEST } from './sandbox-fixture.js';

const run = promisify(execFile);

for (const remote of [false, true]) {
  const where = remote ? 'on a workstation (its cluster reached over its SSH connection)' : 'on the Mac';
  test(`AC1, AC6: ${where} — a variation's sandbox is made from the project's image, runs commands through its command server (stdin, output, exit code, workdir), stops, resumes on use and is deleted; another variation's is its own`, async () => {
    const t = await sandboxed({ remote });
    const sha = branchOnOrigin(t.s);
    const up = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', t.machine);
    assert.equal(up.code, 0, up.err);
    assert.equal(up.json.machine, `substrate:p:${t.machine}:abc-3-a`);
    assert.equal(up.json.created, true);
    assert.equal(up.json.template, 'sandbox-dddddddddddd');
    assert.deepEqual(up.json.branches, [{ repo: 'harness', branch: 'change/ABC-3-1' }]);
    // The template names the image in the cluster's registry by digest, with the capabilities sudo needs.
    const template = JSON.parse(readFileSync(join(t.m.k8s(), 'templates-harness-p.json'), 'utf8')).actorTemplates[0];
    assert.match(template.containers[0].image, /^localhost:\d+\/sandbox\/p@sha256:d{64}$/);
    assert.ok(template.containers[0].securityContext.capabilities.add.includes('SETUID'));
    assert.equal(template.workerSelector.matchLabels.workload, 'harness-p');
    // Recorded on the variation; running; the ticket folder's copy read-only at /mnt/ticket; the branch checked out.
    const record = t.s.variation('A').sandbox;
    assert.deepEqual([record.name, record.project, record.machine, record.state, record.image], ['abc-3-a', 'p', t.machine, 'running', DIGEST]);
    assert.equal(t.state('abc-3-a'), 'ACTOR_STATE_RUNNING');
    assert.equal(readFileSync(join(t.root('abc-3-a'), 'mnt', 'ticket', 'plan.md'), 'utf8'), 'the plan\n');
    assert.throws(() => writeFileSync(join(t.root('abc-3-a'), 'mnt', 'ticket', 'plan.md'), 'x'));
    assert.equal(git(join(t.root('abc-3-a'), 'repos', 'harness'), 'rev-parse', 'HEAD'), sha);
    assert.equal(git(join(t.root('abc-3-a'), 'repos', 'harness'), 'symbolic-ref', '--short', 'HEAD'), 'change/ABC-3-1');
    // A command run in it: stdin in, stdout and stderr out, its exit code, its workdir a sandbox path.
    const name = up.json.machine;
    const r = await t.inMachine(name, 'pwd; cat; echo oops >&2; exit 7', { stdin: 'hello\n', workdir: '/repos/harness' });
    assert.equal(r.code, 7);
    assert.equal(r.out, `${join(t.root('abc-3-a'), 'repos', 'harness')}\nhello\n`);
    assert.equal(r.err, 'oops\n');
    // Another variation: a sandbox of its own (the pool grown by a worker for it), never A's.
    const b = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'B', t.machine);
    assert.equal(b.code, 0, b.err);
    assert.equal(b.json.machine, `substrate:p:${t.machine}:abc-3-b`);
    assert.notEqual(b.json.port, up.json.port);
    assert.equal(JSON.parse(readFileSync(join(t.m.k8s(), 'ns', 'harness-p', 'workerpool-harness-p.json'), 'utf8')).spec.replicas, 2);
    await t.inMachine(b.json.machine, 'echo b > /tmp/mine'.replace('/tmp', '"$HARNESS_VM_ROOT"/tmp'));
    assert.ok(existsSync(join(t.root('abc-3-b'), 'tmp', 'mine')) && !existsSync(join(t.root('abc-3-a'), 'tmp', 'mine')), 'each its own');
    // Its status through the machine layer; stopped (hibernated: suspended, the record says so), then resumed by a command.
    const status = n => run('bash', ['-c', `source "${MACHINE_BASH}"; machine_status "$0"`, n], { env: t.s.env }).then(x => x.stdout.trim());
    assert.equal(await status(name), 'Running');
    const stop = await t.call('substrate:sandbox-stop', 'p', 'ABC-3', 'A');
    assert.equal(stop.code, 0, stop.err);
    assert.equal(t.state('abc-3-a'), 'ACTOR_STATE_SUSPENDED');
    assert.equal(t.s.variation('A').sandbox.state, 'stopped');
    assert.equal(await status(name), 'Stopped');
    const again = await t.inMachine(name, 'echo back');
    assert.deepEqual([again.code, again.out], [0, 'back\n'], again.err);
    assert.equal(t.state('abc-3-a'), 'ACTOR_STATE_RUNNING');
    // Deleted: the actor and its record gone; B's untouched.
    const del = await t.call('substrate:sandbox-delete', 'p', 'ABC-3', 'B');
    assert.equal(del.code, 0, del.err);
    assert.equal(t.state('abc-3-b'), null);
    assert.equal(t.s.variation('B').sandbox, undefined);
    assert.equal(t.state('abc-3-a'), 'ACTOR_STATE_RUNNING');
    // On every call kubectl and kubectl-ate were given the cluster's own kubeconfig (never ~/.kube/config).
    const calls = readFileSync(t.s.env.FAKE_SUBSTRATE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(calls.every(c => !c['default-kubeconfig']), 'no default kubeconfig');
  });
}

test('AC1: deleting with --keep-work commits what was left and pushes the variation\'s branch to origin through the Mac (the sandbox has no forge credentials); a sandbox on another machine is refused until then', async () => {
  const t = await sandboxed();
  branchOnOrigin(t.s);
  const up = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(up.code, 0, up.err);
  const repo = join(t.root('abc-3-a'), 'repos', 'harness');
  writeFileSync(join(repo, 'more.txt'), 'committed in the sandbox\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'ABC-3: more');
  writeFileSync(join(repo, 'left.txt'), 'left uncommitted\n');
  const elsewhere = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', ID);
  assert.notEqual(elsewhere.code, 0);
  const del = await t.call('substrate:sandbox-delete', 'p', 'ABC-3', 'A', '--keep-work');
  assert.equal(del.code, 0, del.err);
  assert.deepEqual(del.json.branches, [{ repo: 'harness', branch: 'change/ABC-3-1' }]);
  const log = execFileSync('git', ['--git-dir', t.s.origins.harness, 'log', '--format=%s', 'change/ABC-3-1'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(log.slice(0, 3), ['ABC-3: work left uncommitted on its sandbox on mac', 'ABC-3: more', 'ABC-3: the last step']);
  assert.equal(t.state('abc-3-a'), null);
  assert.equal(t.s.variation('A').sandbox, undefined);
});

test('AC4: a Build whose agent steps run in the sandbox and whose Docker-based test step runs on the local VM — its branch moves sandbox → VM → sandbox through the Mac (code:hand-over), each place\'s commits carried on; vm_of names the place its run target says', async () => {
  const t = await sandboxed();
  const vm = fakeVm(t.s.env);
  Object.assign(t.s.env, { ...vm.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
  const inVm = join(vm.root, 'repos', 'harness');
  execFileSync('git', ['clone', '-q', t.s.origins.harness, inVm]);
  vm.instance('abc-3-a', 'Running');
  await t.s.cli('ticket:set-vm', 'p', 'ABC-3', 'A', 'abc-3-a', '');
  // Its first Build step (an agent's) on local-substrate: the sandbox made, the branch begun and committed there.
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  const box = join(t.root('abc-3-a'), 'repos', 'harness');
  let h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-substrate');
  assert.equal(h.code, 0, h.err);
  assert.equal(t.s.variation('A')['run-target'].target, 'local-substrate');
  git(box, 'checkout', '-q', '-b', 'change/ABC-3-1');
  writeFileSync(join(box, 'feature.txt'), 'the change\n');
  git(box, 'add', '.'); git(box, 'commit', '-q', '-m', 'ABC-3: the change');
  const code = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'code.bash');
  const vmOf = target => execFileSync('bash', ['-c', `source "${code}" && vm_of t p ABC-3 A`], { encoding: 'utf8', env: { ...t.s.env, ...(target ? { HARNESS_RUN_TARGET: target } : {}) } }).trim();
  assert.deepEqual([vmOf(), vmOf('local-substrate'), vmOf('local-vm')], ['substrate:p:mac:abc-3-a', 'substrate:p:mac:abc-3-a', 'abc-3-a']);
  // The test step needs Docker: on the local VM, which gets the branch (pushed from the Mac: the sandbox has no credentials).
  h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-vm');
  assert.equal(h.code, 0, h.err);
  assert.deepEqual([h.json.from, h.json.to, h.json.branch], ['local-substrate', 'local-vm', 'change/ABC-3-1']);
  assert.equal(git(inVm, 'symbolic-ref', '--short', 'HEAD'), 'change/ABC-3-1');
  assert.equal(readFileSync(join(inVm, 'feature.txt'), 'utf8'), 'the change\n');
  assert.equal(vmOf(), 'abc-3-a');
  // The test step fixes a test there; Review's agent, back in the sandbox, has it (fast-forwarded).
  writeFileSync(join(inVm, 'test.txt'), 'a fixed test\n');
  git(inVm, 'add', '.'); git(inVm, 'commit', '-q', '-m', 'ABC-3: fix the test');
  h = await t.call('code:hand-over', 'p', 'ABC-3', 'A', 'local-substrate');
  assert.equal(h.code, 0, h.err);
  assert.equal(readFileSync(join(box, 'test.txt'), 'utf8'), 'a fixed test\n');
  assert.equal(git(box, 'rev-parse', 'HEAD'), git(inVm, 'rev-parse', 'HEAD'));
  assert.equal(execFileSync('git', ['--git-dir', t.s.origins.harness, 'rev-parse', 'change/ABC-3-1'], { encoding: 'utf8' }).trim(), git(box, 'rev-parse', 'HEAD'), 'on origin too');
});
