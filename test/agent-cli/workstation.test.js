// The workstation connection's commands (ASS-433 AC1, AC2, AC4, AC5):
// workstation:connect starts a stopped workstation and opens its one master
// SSH connection, the forwarder, Hindsight and zot reverse-forwarded to its
// loopback; workstation:status, workstation:ssh and workstation:disconnect go
// with it; the live data in the project's workstations.json. Against
// test/support/fake-gcloud.js and fake-ssh.js (fake-workstation.js) on PATH.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, AGENT } from './harness-fixture.js';
import { fakeWorkstation } from '../support/fake-workstation.js';
import { controlPath, sshArgv } from '../../src/control/workstation-connection.js';

const run = promisify(execFile);
const ID = 'ada-dev';
const opened = [];
afterEach(async () => { for (const w of opened.splice(0)) await w.cli('workstation:disconnect', 'p', ID).catch(() => {}); });

// Project p using workstation ada-dev (its gcloud login under ~/.config/example/gcloud), its Hindsight on 8888 and
// zot on 5101; harness.json's forwarder on 7787. cli(...) runs agent.sh; entry() reads the live data's entry.
function setup({ state = 'STATE_STOPPED', forwarder = 7787 } = {}) {
  const f = fixture(), w = fakeWorkstation(f.env);
  const pj = join(f.dir, 'projects', 'p', 'project.json'), hj = join(f.dir, 'harness.json');
  const p = JSON.parse(readFileSync(pj, 'utf8'));
  p['dev-environments'] = { mode: 'workstation', workstations: [{ id: ID, 'gcp-project': 'example-gcp-project', region: 'us-central1', cluster: 'example-workstations', config: 'example-config', 'gcloud-config': '~/.config/example/gcloud' }] };
  p.hindsight = { port: 8888 };
  p.registry = { port: 5101 };
  writeFileSync(pj, JSON.stringify(p));
  const h = JSON.parse(readFileSync(hj, 'utf8'));
  if (forwarder) h['forwarder-port'] = forwarder;
  writeFileSync(hj, JSON.stringify(h));
  w.workstation(ID, state);
  const cli = (...args) => run(AGENT, args, { env: w.env });
  const result = (...args) => cli(...args).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));
  const file = join(f.dir, 'projects', 'p', 'workstations.json');
  const entry = () => JSON.parse(readFileSync(file, 'utf8'))[ID];
  const self = { f, w, cli, result, entry, file, socket: controlPath(w.env, 'p', ID) };
  opened.push(self);
  return self;
}

test('AC1, AC2: workstation:connect starts a stopped workstation, under its gcloud-config, and opens one master with the forwarder, Hindsight and zot forwarded to the same port on its loopback only', async () => {
  const s = setup();
  const out = JSON.parse((await s.cli('workstation:connect', 'p', ID)).stdout);
  assert.equal(out.id, ID);
  assert.equal(out.started, true);
  assert.equal(out.connected, true);
  assert.equal(s.w.state(ID), 'STATE_RUNNING');
  const calls = s.w.gcloudCalls();
  assert.deepEqual(calls.map(c => c.argv[1]), ['describe', 'start', 'describe', 'ssh']);
  const home = s.w.env.HOME;
  for (const c of calls) {
    assert.equal(c.config, join(home, '.config', 'example', 'gcloud'));
    assert.deepEqual(c.argv.slice(2, 7), [ID, '--project=example-gcp-project', '--region=us-central1', '--cluster=example-workstations', '--config=example-config']);
  }
  assert.deepEqual(s.w.flags(ID), ['-M', '-S', s.socket, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes',
    '-R', '127.0.0.1:7787:127.0.0.1:7787', '-R', '127.0.0.1:8888:127.0.0.1:8888', '-R', '127.0.0.1:5101:127.0.0.1:5101']);
  assert.ok(existsSync(s.socket), 'the master listens on its socket');
  // AC5: live data in the project's folder, not project.json.
  const e = s.entry();
  assert.equal(e.state, 'running');
  assert.equal(e.connected, true);
  assert.equal(e['last-error'], null);
  assert.deepEqual(e.forwards, [7787, 8888, 5101]);
  assert.match(e['started-at'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(JSON.parse(readFileSync(join(s.f.dir, 'projects', 'p', 'project.json'), 'utf8'))['dev-environments'].workstations[0].state, undefined);
});

test('AC1: an open connection is taken as it is — asking Google nothing — and two connects at once open one master between them (the lock)', async () => {
  const s = setup({ state: 'STATE_RUNNING' });
  const both = await Promise.all([s.cli('workstation:connect', 'p', ID), s.cli('workstation:connect', 'p', ID)]);
  assert.deepEqual(both.map(r => JSON.parse(r.stdout).connected), [true, true]);
  assert.equal(s.w.gcloudCalls().filter(c => c.argv[1] === 'ssh').length, 1);
  assert.deepEqual(both.map(r => JSON.parse(r.stdout).started), [false, false]);
  const before = s.w.gcloudCalls().length;
  assert.equal(JSON.parse((await s.cli('workstation:connect', 'p', ID)).stdout).connected, true);
  assert.equal(s.w.gcloudCalls().length, before);
});

test('AC1: a workstation starting is waited for; one stopping is waited for, then started', async () => {
  const s = setup({ state: 'STATE_STARTING' });
  s.w.mark(ID, 'settle', '3');
  assert.equal(JSON.parse((await s.cli('workstation:connect', 'p', ID)).stdout).started, false);
  assert.deepEqual(s.w.gcloudCalls().map(c => c.argv[1]), ['describe', 'describe', 'describe', 'describe', 'ssh']);
  await s.cli('workstation:disconnect', 'p', ID);
  const t = setup({ state: 'STATE_STOPPING' });
  assert.equal(JSON.parse((await t.cli('workstation:connect', 'p', ID)).stdout).started, true);
  assert.deepEqual(t.w.gcloudCalls().map(c => c.argv[1]), ['describe', 'describe', 'start', 'describe', 'ssh']);
});

test('AC1: workstation:status says whether the connection is open and the state; --connection asks Google nothing; a dropped one is recorded so', async () => {
  const s = setup();
  const before = JSON.parse((await s.cli('workstation:status', 'p', ID)).stdout);
  assert.equal(before.connected, false);
  assert.equal(before.state, 'stopped');
  await s.cli('workstation:connect', 'p', ID);
  const calls = s.w.gcloudCalls().length;
  assert.equal(JSON.parse((await s.cli('workstation:status', 'p', ID, '--connection')).stdout).connected, true);
  assert.equal(s.w.gcloudCalls().length, calls);
  s.w.mark(ID, 'drop');
  for (let i = 0; i < 50 && existsSync(s.socket); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(JSON.parse((await s.cli('workstation:status', 'p', ID, '--connection')).stdout).connected, false);
  assert.equal(s.entry().connected, false);
});

test('workstation:status reports a connection that has gone silent (a session over it never returns) as not connected', async () => {
  const s = setup({ state: 'STATE_RUNNING' });
  await s.cli('workstation:connect', 'p', ID);
  s.w.mark(ID, 'hang');
  const r = await run(AGENT, ['workstation:status', 'p', ID, '--connection'], { env: { ...s.w.env, WORKSTATION_PROBE_SECONDS: '1' } });
  assert.equal(JSON.parse(r.stdout).connected, false);
});

test('workstation:ssh and workstation_ssh run a command over the connection — argv quoted, stdin, output and exit code passed through; 255 with none open', async () => {
  const s = setup({ state: 'STATE_RUNNING' });
  const none = await s.result('workstation:ssh', 'p', ID, 'true');
  assert.equal(none.code, 255);
  assert.match(none.err, /has no open connection: workstation:connect p ada-dev first/);
  await s.cli('workstation:connect', 'p', ID);
  assert.deepEqual(await s.result('workstation:ssh', 'p', ID, '--', 'bash', '-c', 'echo "$1 $2"; exit 3', '_', "it's", '$HOME'), { code: 3, out: "it's $HOME\n", err: '' });
  const echoed = await new Promise(resolve => {
    const child = spawn(AGENT, ['workstation:ssh', 'p', ID, 'cat'], { env: s.w.env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
    child.stdin.end('through stdin\n');
  });
  assert.deepEqual(echoed, { code: 0, out: 'through stdin\n' });
  const last = s.w.sshCalls().at(-1).argv;
  assert.deepEqual(last.slice(0, 9), ['-S', s.socket, '-o', 'ControlMaster=no', '-o', 'BatchMode=yes', '-o', 'ProxyCommand=false', `workstation-${ID}`]);
  // workstation_rsh: the same ssh as one command line, for rsync -e.
  const rsh = (await run('bash', ['-c', `source "${join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'workstation.bash')}" && workstation_rsh p ${ID}`], { env: s.w.env })).stdout.trim();
  assert.equal(rsh, `ssh -S ${s.socket} -o ControlMaster=no -o BatchMode=yes -o ProxyCommand=false`);
});

test('control-side sshArgv (workstation-connection.js) runs over the connection the commands opened: the same socket and options', async () => {
  const s = setup({ state: 'STATE_RUNNING' });
  await s.cli('workstation:connect', 'p', ID);
  const [file, ...args] = sshArgv(s.w.env, 'p', ID, ['printf', '%s|', 'a b', "c'd"]);
  const r = await run(file, args, { env: s.w.env });
  assert.equal(r.stdout, "a b|c'd|");
  const options = (await run('bash', ['-c', `source "${join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'workstation.bash')}" && ws_ssh_options p ${ID}`], { env: s.w.env })).stdout.trim().split('\n');
  assert.deepEqual(s.w.sshCalls().at(-1).argv, [...options, `workstation-${ID}`, '--', `'printf' '%s|' 'a b' 'c'\\''d'`]);
});

test('AC1, AC3: workstation:disconnect ends the master and records it; with none open it does nothing and succeeds; the workstation is left running', async () => {
  const s = setup({ state: 'STATE_RUNNING' });
  await s.cli('workstation:connect', 'p', ID);
  const out = JSON.parse((await s.cli('workstation:disconnect', 'p', ID)).stdout);
  assert.equal(out.connected, false);
  assert.ok(!existsSync(s.socket));
  assert.equal(s.w.state(ID), 'STATE_RUNNING');
  assert.equal((await s.result('workstation:ssh', 'p', ID, 'true')).code, 255);
  assert.equal((await s.result('workstation:disconnect', 'p', ID)).code, 0);
});

test('AC4: a connect failing on an expired gcloud login records last-error kind expired and says the login to run, with its CLOUDSDK_CONFIG; offline is recorded as offline, never expired', async () => {
  const s = setup();
  s.w.mark(null, 'expired');
  const r = await s.result('workstation:connect', 'p', ID);
  assert.equal(r.code, 1);
  assert.match(r.err, /failed \(expired\); the gcloud login needs reauthentication: run CLOUDSDK_CONFIG=\S+\/\.config\/example\/gcloud gcloud auth login: .*Reauthentication failed/);
  assert.equal(s.entry()['last-error'].kind, 'expired');
  assert.equal(s.entry().connected, false);
  s.w.unmark(null, 'expired');
  s.w.mark(null, 'offline');
  assert.equal((await s.result('workstation:connect', 'p', ID)).code, 1);
  assert.equal(s.entry()['last-error'].kind, 'offline');
  s.w.unmark(null, 'offline');
  await s.cli('workstation:connect', 'p', ID);
  assert.equal(s.entry()['last-error'], null);
});

test('AC2: a forward the workstation refuses fails the connect (ExitOnForwardFailure), no master left half forwarded', async () => {
  const s = setup({ state: 'STATE_RUNNING' });
  s.w.mark(ID, 'refuse-forward');
  const r = await s.result('workstation:connect', 'p', ID);
  assert.equal(r.code, 1);
  // ASS-501: a stale session cleared first (none here), then tried again, and the original error kept.
  assert.match(r.err, /opening its SSH connection \(gcloud workstations ssh; it tried clearing a stale session: .*\) failed \(unknown\): .*remote port forwarding failed/);
  assert.ok(!existsSync(s.socket));
  assert.equal(s.entry().connected, false);
});

test('a token in what gcloud prints never reaches the live data or the error', async () => {
  const s = setup();
  s.w.workstation(ID, 'STATE_RUNNING');
  rmSync(join(s.w.bin, 'gcloud'));   // the fake's symlink: written through, it would overwrite fake-gcloud.js
  writeFileSync(join(s.w.bin, 'gcloud'), '#!/usr/bin/env bash\necho "ERROR: unexpected answer for Bearer ya29.a0AfB_byCSECRETSECRETSECRET123456789" >&2; exit 1\n', { mode: 0o755 });
  const r = await s.result('workstation:connect', 'p', ID);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /SECRET/);
  assert.doesNotMatch(readFileSync(s.file, 'utf8'), /SECRET/);
  assert.match(s.entry()['last-error'].message, /\[token\]/);
});

test('workstation:connect fails, naming why, without harness.json\'s forwarder-port, for a workstation the project does not list, and on bad usage', async () => {
  const s = setup({ forwarder: null });
  assert.match((await s.result('workstation:connect', 'p', ID)).err, /harness\.json has no forwarder-port/);
  assert.match((await s.result('workstation:connect', 'p', 'other')).err, /project p has no workstation 'other'/);
  assert.match((await s.result('workstation:connect', 'p')).err, /usage: workstation:connect <project> <id>/);
  assert.match((await s.result('workstation:status', 'nope', ID)).err, /no project 'nope'/);
  assert.deepEqual(s.w.gcloudCalls(), []);
});
