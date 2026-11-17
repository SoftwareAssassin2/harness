// A project's cloud VM (ASS-481 AC2, AC3, AC4, AC7) through the bash
// commands: workstation:connect starts a TERMINATED VM, resumes a SUSPENDED
// one and waits out a STOPPING one (gcloud compute instances), waits for its
// SSH banner through IAP and times out, recorded as last-error kind timeout;
// its master is OpenSSH's own through the IAP tunnel, with OS Login, the
// forwarder, Hindsight and zot reverse-forwarded, no terminal (-N -T: no pts
// session to hold off the VM's idle stop); the machine layer runs, copies and
// stops a marked command on it as cloud-vm:<project>:<id>:<folder>; claims
// fill the pool in order (workstations first) and record kind cloud-vm; Create
// VM records it as kind cloud-vm; disconnect closes the master and never
// stops the VM. Against fake-gcloud-compute.js and fake-ssh-master.js
// (test/support/fake-workstation.js cloudVm).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, AGENT } from './harness-fixture.js';
import { fakeWorkstation } from '../support/fake-workstation.js';
import { wsFixture, closeAll, ID } from './workstation-fixture.js';
import { controlPath } from '../../src/control/workstation-connection.js';
import { cloudVmState } from '../../src/control/workstation-machines.js';
import { lostWhy } from '../../src/control/seat-kinds.js';

const run = promisify(execFile);
const MACHINE_BASH = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'machine.bash');
const VM = 'vm-1';
const opened = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await s.cli('workstation:disconnect', 'p', VM).catch(() => {});
  await closeAll();
});
const bash = (script, env) => run('bash', ['-c', `source "${MACHINE_BASH}" && ${script}`], { env }).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));

// Project p in workstation mode on cloud VM vm-1 alone (its gcloud login under ~/.config/example/gcloud), its
// Hindsight on 8888 and zot on 5101; harness.json's forwarder on 7787. The VM's status is `status`.
function setup({ status = 'TERMINATED', vm = {}, env = {} } = {}) {
  const f = fixture(), w = fakeWorkstation(f.env);
  const pj = join(f.dir, 'projects', 'p', 'project.json'), hj = join(f.dir, 'harness.json');
  const p = JSON.parse(readFileSync(pj, 'utf8'));
  p['dev-environments'] = { mode: 'workstation', 'cloud-vms': [{ id: VM, 'gcp-project': 'example-gcp-project', zone: 'us-central1-a', 'gcloud-config': '~/.config/example/gcloud', ...vm }] };
  p.hindsight = { port: 8888 };
  p.registry = { port: 5101 };
  writeFileSync(pj, JSON.stringify(p));
  const h = JSON.parse(readFileSync(hj, 'utf8'));
  h['forwarder-port'] = 7787;
  writeFileSync(hj, JSON.stringify(h));
  w.cloudVm(VM, status);
  const runEnv = { ...w.env, CLOUD_VM_PROBE_SECONDS: '2', ...env };
  const cli = (...args) => run(AGENT, args, { env: runEnv });
  const result = (...args) => cli(...args).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));
  const file = join(f.dir, 'projects', 'p', 'workstations.json');
  const entry = () => JSON.parse(readFileSync(file, 'utf8'))[VM];
  const calls = () => w.gcloudCalls().map(c => c.argv.filter(a => !a.startsWith('--')).slice(0, 3).join(' '));
  const self = { f, w, cli, result, entry, calls, socket: controlPath(w.env, 'p', VM) };
  opened.push(self);
  return self;
}

test('AC2: a TERMINATED cloud VM is started (gcloud compute instances start --async, under its gcloud-config), waited for until RUNNING and its SSH banner answers through IAP, then one master through the IAP tunnel with OS Login, the forwarder, Hindsight and zot reverse-forwarded, no terminal', async () => {
  const s = setup();
  writeFileSync(join(s.w.dir, 'workstations', VM, 'ssh-wait'), '2');   // the guest's sshd answers at the third probe
  const r = await s.result('workstation:connect', 'p', VM);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.started, true);
  assert.equal(out.connected, true);
  assert.equal(s.w.status(VM), 'RUNNING');
  const calls = s.calls();
  assert.deepEqual(calls.slice(0, 2), ['compute instances describe', 'compute instances start']);
  assert.ok(calls.indexOf('compute start-iap-tunnel vm-1') > calls.lastIndexOf('compute instances describe'), 'the banner waited for once it runs');
  assert.equal(calls.filter(c => c === 'compute start-iap-tunnel vm-1').length, 3, 'probed until the banner answered');
  const home = s.w.env.HOME;
  for (const c of s.w.gcloudCalls().filter(x => x.argv.includes('compute'))) {
    assert.equal(c.config, join(home, '.config', 'example', 'gcloud'));
    assert.ok(c.argv.includes('--zone=us-central1-a') && c.argv.includes('--project=example-gcp-project'), c.argv.join(' '));
  }
  assert.ok(s.w.gcloudCalls().find(c => c.argv.includes('start')).argv.includes('--async'));
  const flags = s.w.flags(VM);
  assert.deepEqual(flags.slice(0, 5), ['-M', '-S', s.socket, '-N', '-T'], 'a master, no command and no terminal: no pts session (AC4)');
  const opt = name => flags.filter((x, i) => flags[i - 1] === '-o' && x.startsWith(`${name}=`)).map(x => x.slice(name.length + 1));
  assert.deepEqual(opt('ExitOnForwardFailure'), ['yes']);
  assert.deepEqual(opt('BatchMode'), ['yes']);
  assert.match(opt('ProxyCommand')[0], /^gcloud --quiet --verbosity=error compute start-iap-tunnel vm-1 22 --listen-on-stdin --zone=us-central1-a --project=example-gcp-project$/);
  assert.equal(flags[flags.indexOf('-l') + 1], 'ada_lovelace_example_com', 'the OS Login user of the gcloud account');
  assert.equal(flags[flags.indexOf('-i') + 1], join(home, '.ssh', 'google_compute_engine'));
  assert.deepEqual(flags.filter((x, i) => flags[i - 1] === '-R'), ['127.0.0.1:7787:127.0.0.1:7787', '127.0.0.1:8888:127.0.0.1:8888', '127.0.0.1:5101:127.0.0.1:5101']);
  assert.equal(readFileSync(join(s.w.dir, 'workstations', VM, 'ssh-config'), 'utf8'), join(home, '.config', 'example', 'gcloud'), 'the ProxyCommand under its gcloud-config');
  assert.ok(existsSync(s.socket));
  const e = s.entry();
  assert.equal(e.state, 'running');
  assert.equal(e.connected, true);
  assert.equal(e['last-error'], null);
  assert.deepEqual(e.forwards, [7787, 8888, 5101]);
  assert.match(e['boot-id'], /^[0-9a-f-]{36}$/, 'its boot recorded: a new one, it was started');
  // A session over it; then disconnect closes the master and leaves the VM running (AC4: never stopped here).
  assert.equal((await s.cli('workstation:ssh', 'p', VM, 'echo', 'hi')).stdout, 'hi\n');
  assert.equal(JSON.parse((await s.cli('workstation:disconnect', 'p', VM)).stdout).connected, false);
  assert.ok(!existsSync(s.socket));
  assert.equal(s.w.status(VM), 'RUNNING');
  assert.ok(!s.calls().some(c => /instances (stop|suspend|reset|delete)/.test(c)), 'never stopped, suspended, reset or deleted');
});

test('AC2: a SUSPENDED cloud VM is resumed (its boot kept), a STOPPING one waited out and then started; a running one is connected at once, no start and no probe; ssh-user overrides the OS Login user', async () => {
  const suspended = setup({ status: 'SUSPENDED' });
  const r = await suspended.result('workstation:connect', 'p', VM);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).started, true);
  assert.ok(suspended.calls().includes('compute instances resume'));
  assert.ok(!suspended.calls().includes('compute instances start'));
  assert.equal(suspended.entry()['boot-id'], `boot-${VM}-1`, 'a resume keeps the boot');

  const stopping = setup({ status: 'STOPPING' });
  writeFileSync(join(stopping.w.dir, 'workstations', VM, 'settle'), '2');
  const s2 = await stopping.result('workstation:connect', 'p', VM);
  assert.equal(s2.code, 0, s2.err);
  const calls = stopping.calls();
  assert.deepEqual(calls.slice(0, 3), ['compute instances describe', 'compute instances describe', 'compute instances describe'], 'STOPPING waited out');
  assert.equal(calls.filter(c => c === 'compute instances start').length, 1, 'then started, once');

  const running = setup({ status: 'RUNNING', vm: { 'ssh-user': 'ada' } });
  const s3 = await running.result('workstation:connect', 'p', VM);
  assert.equal(s3.code, 0, s3.err);
  assert.equal(JSON.parse(s3.out).started, false);
  assert.deepEqual(running.calls(), ['compute instances describe']);
  const flags = running.w.flags(VM);
  assert.equal(flags[flags.indexOf('-l') + 1], 'ada');
  assert.equal(running.entry()['boot-id'], `boot-${VM}-1`);
});

test('AC2: the SSH banner wait and the start wait are bounded: each timing out fails the connect, recorded as last-error kind timeout — the footer\'s "start timed out", its seat lost', async () => {
  const s = setup({ env: { CLOUD_VM_SSH_TIMEOUT: '1', CLOUD_VM_PROBE_SECONDS: '1' } });
  writeFileSync(join(s.w.dir, 'workstations', VM, 'no-banner'), '');
  const r = await s.result('workstation:connect', 'p', VM);
  assert.equal(r.code, 1);
  assert.match(r.err, /p's cloud VM vm-1: waiting for its SSH timed out: it runs, but its SSH did not answer through IAP within 1 seconds/);
  const e = s.entry();
  assert.equal(e['last-error'].kind, 'timeout');
  assert.equal(e.connected, false);
  assert.equal(cloudVmState(e), 'start timed out');
  assert.match(lostWhy(e), /^its start timed out/);
  // Its sshd answering again, the next connect works and clears it.
  s.w.unmark(VM, 'no-banner');
  const again = await s.result('workstation:connect', 'p', VM);
  assert.equal(again.code, 0, again.err);
  assert.equal(s.entry()['last-error'], null);

  const slow = setup({ status: 'STOPPING', env: { WORKSTATION_START_TIMEOUT: '1' } });
  writeFileSync(join(slow.w.dir, 'workstations', VM, 'settle'), '1000');
  const r2 = await slow.result('workstation:connect', 'p', VM);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /its start timed out: it is still stopping after 1 seconds/);
  assert.equal(slow.entry()['last-error'].kind, 'timeout');
  assert.equal(slow.entry().state, 'starting');
});

test('AC2, AC3: claimed for a step, the machine layer runs, copies and stops a marked command on the cloud VM as cloud-vm:<project>:<id>:<folder>, in its shared root; Create VM records it as kind cloud-vm', async () => {
  const s = wsFixture({ ids: [], cloudVms: [VM] });
  assert.equal((await s.result('workstation:connect', 'p', VM)).code, 0);
  assert.equal((await s.result('workstation:setup', 'p', VM)).code, 0);
  const placed = await s.result('vm:create', 'p', 'ABC-3', 'B');
  assert.equal(placed.code, 0, placed.err);
  assert.equal(JSON.parse(placed.out).machine, `cloud-vm:p:${VM}:${s.root(VM)}`);
  assert.equal(s.variation('B').vm.kind, 'cloud-vm');
  const claimed = await s.result('workstation:claim', 'p', 'ABC-3', 'B');
  assert.equal(claimed.code, 0, claimed.err);
  const machine = `cloud-vm:p:${VM}:${s.root(VM)}`;
  assert.equal(JSON.parse(claimed.out).machine, machine);
  assert.equal(s.variation('B').workstation.kind, 'cloud-vm');
  assert.ok(s.tokens()[machine], 'the forwarder binding under its machine');
  assert.equal((await bash(`jq -r "$machine_of" <<< '${JSON.stringify(s.variation('B'))}'`, s.env)).out, `${machine}\n`);

  const pwd = await bash(`machine_run --workdir /repos/harness "${machine}" -- bash -c 'pwd; echo "$HARNESS_VM_ROOT"; exit 3'`, s.env);
  assert.equal(pwd.code, 3, pwd.err);
  assert.deepEqual(pwd.out.trim().split('\n'), [s.repo('harness', VM), s.root(VM)]);
  assert.equal((await bash(`machine_status "${machine}"`, s.env)).out, 'Running\n');
  const local = mkdtempSync(join(tmpdir(), 'cvm-copy-'));
  writeFileSync(join(local, 'in.txt'), 'to the VM\n');
  assert.equal((await bash(`machine_copy_in "${machine}" "${join(local, 'in.txt')}" /repos/in.txt`, s.env)).code, 0);
  assert.equal(readFileSync(join(s.root(VM), 'repos', 'in.txt'), 'utf8'), 'to the VM\n');
  mkdirSync(join(local, 'back'));
  assert.equal((await bash(`machine_copy_out "${machine}" /repos/in.txt "${join(local, 'back')}/"`, s.env)).code, 0);
  assert.equal(readFileSync(join(local, 'back', 'in.txt'), 'utf8'), 'to the VM\n');

  const marker = `harness-step-test-${process.pid}-${Date.now()}`, pidFile = join(s.w.dir, 'sleeper');
  const child = spawn('bash', ['-c', `source "${MACHINE_BASH}" && machine_run --marker ${marker} "${machine}" -- bash -c 'echo $$ > ${pidFile}; exec sleep 60'`], { env: s.env, stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await bash(`machine_stop_marked "${machine}" ${marker}`, s.env)).code, 0);
  const ended = () => child.exitCode !== null || child.signalCode !== null;
  for (let i = 0; i < 100 && !ended(); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(ended(), 'the marked process ended there');
  assert.equal((await bash(`machine_stop "${machine}"`, s.env)).code, 0);
  assert.equal(s.w.status(VM), 'RUNNING', 'machine_stop never stops a cloud VM');

  const released = await s.result('workstation:release', 'p', VM, '--force');
  assert.equal(released.code, 0, released.err);
  assert.equal(s.variation('B').workstation, undefined);
  assert.equal(s.tokens()[machine], undefined);
});

test('AC3: claims fill the pool in its order, workstations first, then cloud VMs; a cloud VM set up under the boot it runs now needs no setup again after a reconnect', async () => {
  const s = wsFixture({ mode: 'vm+workstation', ids: [ID], cloudVms: [VM] });
  for (const id of [ID, VM]) { assert.equal((await s.result('workstation:connect', 'p', id)).code, 0); assert.equal((await s.result('workstation:setup', 'p', id)).code, 0); }
  const first = await s.result('workstation:claim', 'p', 'ABC-3', 'B');
  assert.equal(JSON.parse(first.out).name, ID);
  const second = await s.result('workstation:claim', 'p', 'ABC-3', 'C');
  assert.equal(second.code, 0, second.err);
  assert.equal(JSON.parse(second.out).name, VM);
  assert.equal(s.variation('C').workstation.kind, 'cloud-vm');
  assert.equal(s.variation('B').workstation.kind, undefined, 'a workstation\'s claim as before');
  await s.cli('workstation:release', 'p', VM, '--force');
  // Reconnected: the cloud VM's setup still holds (same boot), so a claim needs no setup run first.
  await s.cli('workstation:disconnect', 'p', VM);
  assert.equal((await s.result('workstation:connect', 'p', VM)).code, 0);
  const checked = s.entry(VM).setup['checked-at'];
  const again = await s.result('workstation:claim', 'p', 'ABC-3', 'C', '--workstation', VM);
  assert.equal(again.code, 0, again.err);
  assert.equal(s.entry(VM).setup['checked-at'], checked, 'no setup ran');
});
