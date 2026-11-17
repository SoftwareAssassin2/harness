// ASS-501: workstation:connect failing on "remote port forwarding failed for
// listen port <p>" — a stale sshd session of the harness's own SSH user on the
// machine still listening on a forward's port — clears it and connects, for a
// GCP workstation and a cloud VM alike: with no live connection on the Mac
// (AC1), a short session without forwards ends only that user's sshd
// sessions listening on 127.0.0.1 at a forward port, never its own, another
// user's or anything else, each logged with its pid and start time (AC2);
// with a live one it ends nothing (AC3); a retry that fails too fails as
// before, saying a clear was tried (AC4). Against fake-gcloud.js, fake-ssh.js
// and fake-ssh-master.js (fake-workstation.js): a stale session is a real
// process the test starts, listed by the machine's fake `ss` (listen()), and
// a master is refused while one holds a port it forwards.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, AGENT } from './harness-fixture.js';
import { fakeWorkstation } from '../support/fake-workstation.js';
import { controlPath } from '../../src/control/workstation-connection.js';

const run = promisify(execFile);
const WORKSTATION_BASH = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'workstation.bash');
const opened = [], processes = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await s.cli('workstation:disconnect', 'p', s.id).catch(() => {});
  for (const p of processes.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
});

// A process standing in for an sshd session (or anything else) on the machine: its own, alive until ended.
function stale(argv = ['sleep', '600']) {
  const p = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: true });
  p.unref();
  processes.push(p);
  return p;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const gone = async pid => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 100)); return !alive(pid); };
const line = (address, name, pid) => `LISTEN 0      128        ${address}      0.0.0.0:*    users:(("${name}",pid=${pid},fd=10))`;

// Project p on one running machine — the GCP workstation ada-dev or the cloud VM vm-1 — its Hindsight on 8888 and
// zot on 5101, harness.json's forwarder on 7787. shortSessions() lists the argv of the sessions opened apart from a
// master (ASS-501's), masters() how many masters were tried.
function setup(kind) {
  const f = fixture(), w = fakeWorkstation(f.env);
  const id = kind === 'workstation' ? 'ada-dev' : 'vm-1';
  const pj = join(f.dir, 'projects', 'p', 'project.json'), hj = join(f.dir, 'harness.json');
  const p = JSON.parse(readFileSync(pj, 'utf8'));
  p['dev-environments'] = kind === 'workstation'
    ? { mode: 'workstation', workstations: [{ id, 'gcp-project': 'example-gcp-project', region: 'us-central1', cluster: 'example-workstations', config: 'example-config' }] }
    : { mode: 'workstation', 'cloud-vms': [{ id, 'gcp-project': 'example-gcp-project', zone: 'us-central1-a' }] };
  p.hindsight = { port: 8888 };
  p.registry = { port: 5101 };
  writeFileSync(pj, JSON.stringify(p));
  const h = JSON.parse(readFileSync(hj, 'utf8'));
  h['forwarder-port'] = 7787;
  writeFileSync(hj, JSON.stringify(h));
  if (kind === 'workstation') w.workstation(id, 'STATE_RUNNING'); else w.cloudVm(id, 'RUNNING');
  const cli = (...args) => run(AGENT, args, { env: w.env });
  const result = (...args) => cli(...args).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));
  const entry = () => JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'workstations.json'), 'utf8'))[id];
  const calls = () => (kind === 'workstation' ? w.gcloudCalls().filter(c => c.argv[1] === 'ssh') : w.sshCalls().filter(c => c.argv.includes(`cloud-vm-${id}`))).map(c => c.argv);
  const shortSessions = () => calls().filter(a => (kind === 'workstation' ? a.some(x => x.startsWith('--command=')) : !a.includes('-M')));
  const masters = () => calls().length - shortSessions().length;
  const self = { f, w, id, cli, result, entry, shortSessions, masters, socket: controlPath(w.env, 'p', id) };
  opened.push(self);
  return self;
}

for (const kind of ['workstation', 'cloud VM']) {
  test(`AC1, AC2 (${kind}): a stale sshd session of its user holding a forwarded port is ended through a short session without forwards, logged with its pid and start time, and the connect retried and made; nothing else is ended`, async () => {
    const s = setup(kind);
    const forwarder = stale(), hindsight = stale(), otherPort = stale(), anyAddress = stale();
    s.w.listen(s.id, [
      line('127.0.0.1:7787', 'sshd', forwarder.pid),
      line('127.0.0.1:8888', 'sshd-session', hindsight.pid),
      line('127.0.0.1:9999', 'sshd', otherPort.pid),          // not a forward port
      line('0.0.0.0:5101', 'sshd', anyAddress.pid),           // not on 127.0.0.1
      line('127.0.0.1:5101', 'sshd', 'SESSION'),              // the short session's own sshd
    ]);
    const r = await s.result('workstation:connect', 'p', s.id);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).connected, true);
    assert.equal(s.entry().connected, true);
    assert.equal(s.entry()['last-error'], null);
    assert.ok(await gone(forwarder.pid) && await gone(hindsight.pid), 'the stale sessions on the forward ports ended');
    for (const p of [otherPort, anyAddress]) assert.ok(alive(p.pid), 'nothing else ended');
    const noun = kind === 'workstation' ? 'workstation' : 'cloud VM';
    for (const [port, p] of [[7787, forwarder], [8888, hindsight]]) {
      assert.match(r.err, new RegExp(`workstation:connect: p's ${noun} ${s.id}: ended a stale SSH session holding its forwarded port ${port}: pid ${p.pid}, started \\w{3} \\w{3} +\\d+ \\d\\d:\\d\\d:\\d\\d \\d{4}`));
    }
    assert.equal(r.err.match(/ended a stale SSH session/g).length, 2, 'the short session\'s own sshd never ended');
    assert.doesNotMatch(r.err, /failed/);
    // One short session, without forwards or a master; then the master again: two in all.
    const short = s.shortSessions();
    assert.equal(short.length, 1);
    assert.ok(!short[0].some(a => a === '-R' || a === '-M' || /-R |=-M$/.test(a)), short[0].join(' '));
    assert.ok(short[0].some(a => /ClearAllForwardings=yes/.test(a)));
    assert.equal(s.masters(), 2);
    assert.deepEqual(s.w.sudoCalls(s.id), ['-n ss -Hltnp'], 'only the listing under sudo; the kill is the user\'s own');
  });

  test(`AC2, AC4 (${kind}): another user's sshd session and a process that is not sshd, on the forward ports, are never ended; the retry fails, and the connect fails as before with the original error, saying a clear was tried`, async () => {
    const s = setup(kind);
    const notSshd = stale();
    s.w.listen(s.id, [
      line('127.0.0.1:7787', 'sshd', 1),                      // root's (pid 1): another user's
      line('127.0.0.1:8888', 'node', notSshd.pid),
    ]);
    const r = await s.result('workstation:connect', 'p', s.id);
    assert.equal(r.code, 1);
    assert.match(r.err, /opening its SSH connection \((gcloud workstations ssh|ssh through IAP); it tried clearing a stale session: found no stale SSH session of its user holding its forwarded ports, then connecting again\) failed \(unknown\): Error: remote port forwarding failed for listen port 7787/);
    assert.doesNotMatch(r.err, /ended a stale SSH session/);
    assert.ok(alive(notSshd.pid));
    assert.equal(s.entry().connected, false);
    assert.match(s.entry()['last-error'].message, /^Error: remote port forwarding failed for listen port 7787.*tried clearing a stale session: found no stale SSH session/);
    assert.equal(s.shortSessions().length, 1);
    assert.equal(s.masters(), 2, 'retried once');
  });

  test(`AC3 (${kind}): with a live connection on the Mac — a master answering on its ControlPath, or a master for it still running — nothing is ended, and the connect fails as before`, async () => {
    const s = setup(kind);
    // A master answering on its ControlPath: workstation_clear_stale refuses (2), opening no session.
    assert.equal((await s.result('workstation:connect', 'p', s.id)).code, 0);
    const held = stale();
    s.w.listen(s.id, [line('127.0.0.1:7787', 'sshd', held.pid)]);
    const direct = await run('bash', ['-c', `source "${WORKSTATION_BASH}" && workstation_clear_stale p ${s.id} "$(workstation_settings test p ${s.id})" 7787 8888 5101`], { env: s.w.env })
      .then(() => ({ code: 0 }), e => ({ code: e.code, err: e.stderr }));
    assert.deepEqual(direct, { code: 2, err: 'the Mac has a live connection to it: nothing ended\n' });
    assert.equal(s.shortSessions().length, 0);
    assert.ok(alive(held.pid));
    await s.cli('workstation:disconnect', 'p', s.id);
    // A master process for it still running (its socket gone): connect ends nothing and fails as before.
    stale(['perl', '-e', 'sleep 600', '--', '-M', '-S', s.socket]);
    const r = await s.result('workstation:connect', 'p', s.id);
    assert.equal(r.code, 1);
    assert.match(r.err, /opening its SSH connection \((gcloud workstations ssh|ssh through IAP)\) failed \(unknown\): Error: remote port forwarding failed for listen port 7787/);
    assert.doesNotMatch(r.err, /stale/);
    assert.equal(s.shortSessions().length, 0, 'no short session opened');
    assert.ok(alive(held.pid));
    assert.equal(s.masters(), 2, 'the first connect\'s master and this one\'s, not retried');
  });
}
