// The machine layer (src/control/machine.js, ASS-432 AC1): a ticket
// variation's machine named from what it records (its vm { name, kind }),
// Lima the only backend, and each operation — a command run in it (workdir,
// stdin, a marker to stop it by), files copied in and out, status, stop —
// through test/support/fake-limactl.js on PATH as the Lima backend's limactl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVm } from '../support/fake-vm.js';
import { machineOf, parseMachine, machineCommand, runInMachine, stopMarked, copyIn, copyOut, machineStatus, machineStatuses, stopMachine, newMarker } from '../../src/control/machine.js';

const until = async (check, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (check()) return true; return check(); };

test('machineOf: a variation\'s machine is its VM\'s Lima name without a kind or with kind lima, <kind>:<name> for any other; none without a VM', () => {
  assert.equal(machineOf({ vm: { name: 'ass-74-a', ip: '192.168.64.15' } }), 'ass-74-a');
  assert.equal(machineOf({ vm: { name: 'ass-74-a', kind: 'lima' } }), 'ass-74-a');
  assert.equal(machineOf({ vm: { name: 'box-1', kind: 'other' } }), 'other:box-1');
  assert.equal(machineOf({ vm: { name: 'ws-1', kind: 'workstation', project: 'p', folder: '/home/me/harness/ASS-1-A' } }), 'workstation:p:ws-1:/home/me/harness/ASS-1-A');   // ASS-435
  assert.equal(machineOf({ name: 'A' }), undefined);
  assert.equal(machineOf(undefined), undefined);
  assert.deepEqual(parseMachine('ass-74-a'), { kind: 'lima', name: 'ass-74-a' });
  assert.deepEqual(parseMachine('workstation:ws-1'), { kind: 'workstation', name: 'ws-1' });
});

test('a machine of a kind with no backend is refused, naming it', () => {
  assert.throws(() => machineCommand('other:box-1', ['true']), /box-1: no machine backend for its kind 'other' \(there is: lima, workstation, cloud-vm, substrate\)/);
});

test('machineCommand: a Lima VM\'s command is limactl shell [--workdir <cwd>] <vm> --, under its marker when given, with LIMA_HOME set', () => {
  const env = { HOME: '/home/me', LIMA_HOME: '/vms' };
  assert.deepEqual(machineCommand('ass-74-a', ['git', 'status'], { cwd: '/repos/', env }), { argv: ['limactl', 'shell', '--workdir', '/repos/', 'ass-74-a', '--', 'git', 'status'], env });
  assert.deepEqual(machineCommand('ass-74-a', ['true'], { env }).argv, ['limactl', 'shell', 'ass-74-a', '--', 'true']);
  const marked = machineCommand('ass-74-a', ['claude'], { cwd: '/repos/', marker: 'harness-step-x', env }).argv;
  assert.deepEqual([...marked.slice(0, 8), ...marked.slice(9)], ['limactl', 'shell', '--workdir', '/repos/', 'ass-74-a', '--', 'bash', '-c', 'harness-step-x', 'claude']);
  assert.equal(machineCommand('ass-74-a', ['true'], { env: { HOME: '/home/me', HARNESS_FILE: '/no/such/harness.json', HARNESS_LOCAL_FILE: '/no/such/local.json' } }).env.LIMA_HOME, '/home/me/.lima');
});

test('runInMachine runs the command in the VM in its workdir, its stdout back and its exit code on the error', async () => {
  const v = fakeVm();
  v.instance('ass-74-a', 'Running');
  assert.deepEqual(await runInMachine('ass-74-a', ['bash', '-c', 'pwd; echo err >&2'], { cwd: '/repos/', env: v.env }), { stdout: `${join(realpathSync(v.root), 'repos')}\n`, stderr: 'err\n' });
  await assert.rejects(runInMachine('ass-74-a', ['bash', '-c', 'exit 3'], { env: v.env }), e => e.code === 3);
  assert.deepEqual(v.calls()[0], { vm: 'ass-74-a', workdir: '/repos/', argv: ['bash', '-c', 'pwd; echo err >&2'] });
});

test('a command spawned under a marker gets its stdin, and stopMarked ends it in the VM, which the local signal never reaches', async () => {
  const v = fakeVm(), marker = newMarker();
  v.instance('ass-74-a', 'Running');
  const { argv: [file, ...args], env } = machineCommand('ass-74-a', ['bash', '-c', 'read -r line; echo "got $line"; sleep 60'], { marker, env: v.env });
  const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stdin.write('hello\n');
  assert.ok(await until(() => out === 'got hello\n'), out);
  stopMarked('ass-74-a', marker, v.env);
  assert.ok(await until(() => v.calls().some(c => c.argv[0] === 'pkill')));
  assert.deepEqual(v.calls().find(c => c.argv[0] === 'pkill'), { vm: 'ass-74-a', workdir: null, argv: ['pkill', '-TERM', '-f', `[h]${marker.slice(1)}`] });
  assert.ok(await until(() => child.exitCode !== null || child.signalCode !== null), 'the process in the VM ends');
});

test('copyIn and copyOut copy a file or a folder into and out of the VM (limactl copy -r)', async () => {
  const v = fakeVm(), local = mkdtempSync(join(tmpdir(), 'local-'));
  v.instance('ass-74-a', 'Running');
  mkdirSync(join(local, 'folder'));
  writeFileSync(join(local, 'folder', 'a.txt'), 'in');
  await copyIn('ass-74-a', join(local, 'folder'), '/tmp/folder', { env: v.env });
  assert.equal(readFileSync(join(v.root, 'tmp', 'folder', 'a.txt'), 'utf8'), 'in');
  await copyOut('ass-74-a', '/tmp/folder/a.txt', join(local, 'back.txt'), { env: v.env });
  assert.equal(readFileSync(join(local, 'back.txt'), 'utf8'), 'in');
  assert.deepEqual(v.calls().map(c => c.argv), [['copy', '-r', join(local, 'folder'), 'ass-74-a:/tmp/folder'], ['copy', '-r', 'ass-74-a:/tmp/folder/a.txt', join(local, 'back.txt')]]);
  await assert.rejects(copyOut('ass-74-a', '/no/such/file', join(local, 'x'), { env: v.env }));
});

test('machineStatus, machineStatuses and stopMachine: each VM\'s status, all of them by machine, and a stop (forced or not)', async () => {
  const v = fakeVm();
  v.instance('ass-74-a', 'Running');
  v.instance('ass-75-a', 'Stopped');
  assert.equal(await machineStatus('ass-74-a', { env: v.env }), 'Running');
  assert.equal(await machineStatus('no-such-vm', { env: v.env }), null);
  assert.deepEqual(await machineStatuses({ env: v.env }), new Map([['ass-74-a', 'Running'], ['ass-75-a', 'Stopped']]));
  await stopMachine('ass-74-a', { env: v.env });
  assert.equal(await machineStatus('ass-74-a', { env: v.env }), 'Stopped');
  await stopMachine('ass-75-a', { force: true, env: v.env });
  assert.deepEqual(v.calls().filter(c => c.argv[0] === 'stop').map(c => c.argv), [['stop', 'ass-74-a'], ['stop', '-f', 'ass-75-a']]);
  await assert.rejects(machineStatuses({ env: { ...v.env, PATH: '/nonexistent' } }));
});

test('ASS-578 AC1/AC2: a project keeping its VMs in its own Lima folder — every instance\'s status read across every folder in use, and each VM\'s command, status and stop run with the folder holding it as LIMA_HOME', async () => {
  const v = fakeVm();
  const own = realpathSync(mkdtempSync(join(tmpdir(), 'own-lima-'))), projects = mkdtempSync(join(tmpdir(), 'projects-'));
  mkdirSync(join(projects, 'big'));
  writeFileSync(join(projects, 'big', 'project.json'), JSON.stringify({ name: 'Big', 'lima-home': own }));
  v.instance('ass-1-a', 'Running');
  for (const [name, status] of [['big-1-a', 'Running'], ['golden-big', 'Stopped']]) {
    mkdirSync(join(own, name)); writeFileSync(join(own, name, 'status'), status); writeFileSync(join(own, name, 'ssh-port'), '0');
  }
  const env = { ...v.env, LIMA_HOME: v.instances, PROJECTS_DIR: projects, FAKE_LIMA_BY_HOME: '1' };
  assert.deepEqual(Object.fromEntries(await machineStatuses({ env })), { 'ass-1-a': 'Running', 'big-1-a': 'Running', 'golden-big': 'Stopped' });
  assert.equal(machineCommand('big-1-a', ['true'], { env }).env.LIMA_HOME, own);
  assert.equal(machineCommand('ass-1-a', ['true'], { env }).env.LIMA_HOME, v.instances);
  assert.equal(await machineStatus('big-1-a', { env }), 'Running');
  await stopMachine('big-1-a', { env });
  assert.equal(readFileSync(join(own, 'big-1-a', 'status'), 'utf8'), 'Stopped');
  const calls = v.calls();
  assert.deepEqual(calls.filter(c => c.argv[0] !== 'list' || c.argv[1] !== '--format').map(c => [c.argv[0], c.home]), [['list', own], ['stop', own]]);
});
