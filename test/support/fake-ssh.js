#!/usr/bin/env node
// A stand-in for `ssh` in the tests (ASS-433), as a workstation's sessions
// look over its master connection (fake-gcloud.js's ssh). Every call is
// appended to $FAKE_SSH_LOG as a JSON line { argv }.
// - `ssh -S <socket> -O check|exit <host>` asks the master at <socket>:
//   exit 0 when it answers (exit ends it), 255 "Control socket connect(…)"
//   when none does.
// - `ssh -S <socket> [-o …] workstation-<id> [-- <command>]` runs <command>
//   with bash -c in $FAKE_WS_DIR/<id>/home (the workstation user's home),
//   stdio and exit code passed through — when the master answers; else 255,
//   as ProxyCommand=false fails it. A `hang` file in the workstation's folder
//   makes a session never return (a connection gone silent).
// - ASS-434: a session's PATH is the workstation's own bin folder (its
//   config's image: fake-workstation.js puts docker and claude there) before
//   the folder's `path` file when it has one (a workstation without the Mac's
//   tools), else this PATH; HARNESS_WS_BOOT_ID its `boot-id` (fake-gcloud.js's
//   start makes a new one) and HARNESS_WS_RUNTIME_ROOT its `run` folder (the
//   container's /dev/shm, emptied by that start), as on-workstation/setup.sh
//   reads them.
// Under test/support/, which npm test's pattern leaves alone.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify({ argv: args })}\n`);
let socket = null, control = null, i = 0;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === '-S') socket = args[++i];
  else if (a === '-O') control = args[++i];
  else if (a === '-o') i++;
  else if (a.startsWith('-')) continue;
  else break;
}
const host = args[i], rest = args.slice(i + 1), command = rest[0] === '--' ? rest.slice(1).join(' ') : rest.join(' ');
const ask = line => new Promise(resolve => {
  if (!socket) return resolve(false);
  const c = connect(socket);
  c.setEncoding('utf8').on('data', () => { c.destroy(); resolve(true); }).on('error', () => resolve(false));
  c.write(`${line}\n`);
});
const answered = await ask(control === 'exit' ? 'exit' : 'check');
if (!answered) {
  process.stderr.write(control ? `Control socket connect(${socket}): No such file or directory\n` : 'kex_exchange_identification: Connection closed by remote host\n');
  process.exit(255);
}
if (control) process.exit(0);
const ws = join(process.env.FAKE_WS_DIR ?? '/nonexistent', String(host).replace(/^workstation-/, ''));
if (existsSync(join(ws, 'hang'))) setInterval(() => {}, 1e6);
else {
  mkdirSync(join(ws, 'home'), { recursive: true });
  mkdirSync(join(ws, 'run'), { recursive: true });
  const read = name => (existsSync(join(ws, name)) ? readFileSync(join(ws, name), 'utf8').trim() : null);
  const env = { ...process.env, HOME: join(ws, 'home'), PATH: `${join(ws, 'bin')}:${read('path') ?? process.env.PATH}`, HARNESS_WS_RUNTIME_ROOT: join(ws, 'run') };
  if (read('boot-id')) env.HARNESS_WS_BOOT_ID = read('boot-id');
  const child = spawn('bash', command ? ['-c', command] : ['-l'], { cwd: join(ws, 'home'), stdio: 'inherit', env });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + 15 : 1)));
}
