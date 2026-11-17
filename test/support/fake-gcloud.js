#!/usr/bin/env node
// A stand-in for `gcloud` in the tests (ASS-433), as Cloud Workstations look
// from the Mac: `gcloud workstations <describe|start|ssh> <id> --project=…
// --region=… --cluster=… --config=… …`. Every call is appended to
// $FAKE_GCLOUD_LOG as a JSON line { argv, config } (config: its
// CLOUDSDK_CONFIG, or null).
// - Each workstation is a folder $FAKE_WS_DIR/<id> holding `state` (STATE_
//   RUNNING, STATE_STOPPED, STATE_STARTING, STATE_STOPPING); none: NOT_FOUND.
//   One STATE_STARTING or STATE_STOPPING moves on (to RUNNING, STOPPED) once
//   `describe` has been asked as often as its `settle` file says (1 without).
// - $FAKE_WS_DIR/expired makes every call fail as a lapsed login does
//   (Google Cloud session control's "Reauthentication failed"), and
//   $FAKE_WS_DIR/offline as a Mac that cannot reach Google
//   (NameResolutionError for oauth2.googleapis.com).
// - `describe --format=value(state)` prints the state; `start` makes it
//   STATE_RUNNING (exit 1 when it is not stopped), with a new `boot-id` and
//   its `run` folder emptied (ASS-434: a restart resets all but /home).
// - `ssh` (only RUNNING; else "Workstation is not running.") reads its
//   --ssh-flag values, as the real one passes them to its ssh, writes them to
//   the workstation's `ssh-flags` (JSON) and, given -M -S <socket> -N,
//   becomes that master: a unix socket server at <socket> (fake-ssh.js's -O
//   check and -O exit, and its sessions, ask it) that stays up until -O exit,
//   a SIGTERM, the workstation leaving RUNNING or a `drop` file in its folder
//   (removed as it drops: a dropped connection), then exits, its socket gone.
//   A `refuse-forward` file in the folder fails it as ExitOnForwardFailure
//   does for a port the workstation refuses; ASS-501: so does a -R port its
//   `listening` file says a live process holds (fake-ssh-master.js heldPort).
//   Given --command=<command> and no -M, it is a session of its own (ASS-501's
//   short one): <command> run as fake-ssh.js runs a session's, its
//   FAKE_SSH_SESSION_PID this process (the session's sshd).
// ASS-481: `gcloud compute …` and `gcloud config get-value account`, a cloud
// VM's, are fake-gcloud-compute.js's.
// Under test/support/, which npm test's pattern leaves alone.
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { heldPort } from './fake-ssh-master.js';

const args = process.argv.slice(2);
if (process.env.FAKE_GCLOUD_LOG) appendFileSync(process.env.FAKE_GCLOUD_LOG, `${JSON.stringify({ argv: args, config: process.env.CLOUDSDK_CONFIG ?? null })}\n`);
const dir = process.env.FAKE_WS_DIR ?? '/nonexistent';
const die = (text, code = 1) => { process.stderr.write(`${text}\n`); process.exit(code); };
// ASS-481: global flags (--quiet, --verbosity=…) may come first; a cloud VM's calls are compute's.
const words = args.filter(a => !a.startsWith('--'));
if (words[0] === 'config' || words[0] === 'compute') { await import('./fake-gcloud-compute.js'); await new Promise(() => {}); }
const [group, sub, id] = args;
if (group !== 'workstations') die(`fake gcloud: unknown command ${args.join(' ')}`);
if (existsSync(join(dir, 'expired'))) die(`ERROR: (gcloud.workstations.${sub}) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.\nPlease run:\n\n  $ gcloud auth login`);
if (existsSync(join(dir, 'offline'))) die(`ERROR: (gcloud.workstations.${sub}) There was a problem refreshing your current auth tokens: HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded with url: /token (Caused by NameResolutionError("<urllib3.connection.HTTPSConnection object>: Failed to resolve 'oauth2.googleapis.com'"))`);
const ws = join(dir, id ?? '');
if (!id || !existsSync(join(ws, 'state'))) die(`ERROR: (gcloud.workstations.${sub}) NOT_FOUND: Resource '${id}' was not found`);
const state = () => readFileSync(join(ws, 'state'), 'utf8').trim();
const setState = s => writeFileSync(join(ws, 'state'), s);

if (sub === 'describe') {
  const s = state();
  if (s === 'STATE_STARTING' || s === 'STATE_STOPPING') {
    const left = existsSync(join(ws, 'settle')) ? Number(readFileSync(join(ws, 'settle'), 'utf8')) : 1;
    if (left <= 1) { rmSync(join(ws, 'settle'), { force: true }); setState(s === 'STATE_STARTING' ? 'STATE_RUNNING' : 'STATE_STOPPED'); } else writeFileSync(join(ws, 'settle'), String(left - 1));
  }
  console.log(s);
} else if (sub === 'start') {
  if (state() !== 'STATE_STOPPED') die(`ERROR: (gcloud.workstations.start) FAILED_PRECONDITION: workstation is ${state()}`);
  setState('STATE_RUNNING');
  writeFileSync(join(ws, 'boot-id'), randomUUID());
  rmSync(join(ws, 'run'), { recursive: true, force: true });
  console.error(`Waiting for operation [start] to complete...done.\nStarted workstation [${id}].`);
} else if (sub === 'ssh') {
  if (state() !== 'STATE_RUNNING') die('ERROR: (gcloud.workstations.ssh) Workstation is not running. Use --start-workstation to start it.');
  const flags = args.filter(a => a.startsWith('--ssh-flag=')).flatMap(a => a.slice('--ssh-flag='.length).split(/\s+/).filter(Boolean));
  writeFileSync(join(ws, 'ssh-flags'), JSON.stringify(flags));
  const command = args.find(a => a.startsWith('--command='))?.slice('--command='.length);
  if (command !== undefined && !flags.includes('-M')) {
    mkdirSync(join(ws, 'home'), { recursive: true });
    const env = { ...process.env, HOME: join(ws, 'home'), PATH: `${join(ws, 'bin')}:${process.env.PATH}`, FAKE_SSH_SESSION_PID: String(process.pid) };
    const child = spawn('bash', ['-c', command], { cwd: join(ws, 'home'), stdio: 'inherit', env });
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + 15 : 1)));
    await new Promise(() => {});
  }
  if (existsSync(join(ws, 'refuse-forward'))) die('Error: remote port forwarding failed for listen port 7787', 255);
  const held = heldPort(ws, flags);
  if (held) die(`Error: remote port forwarding failed for listen port ${held}`, 255);
  const socket = flags[flags.indexOf('-S') + 1];
  if (!flags.includes('-M') || !socket) die('fake gcloud: only a master (-M -S <socket> -N) is faked', 2);
  mkdirSync(join(ws, 'home'), { recursive: true });
  let done = false;
  const server = createServer(conn => conn.setEncoding('utf8').on('data', line => {
    conn.end('ok\n');
    if (line.trim() === 'exit') end(0);
  }));
  const end = code => { if (done) return; done = true; server.close(); rmSync(socket, { force: true }); process.exit(code); };
  server.listen(socket);
  process.on('SIGTERM', () => end(143));
  setInterval(() => {
    if (existsSync(join(ws, 'drop'))) { rmSync(join(ws, 'drop')); end(255); }
    if (state() !== 'STATE_RUNNING') end(255);
  }, 100);
} else die(`fake gcloud: unknown command ${args.join(' ')}`);
