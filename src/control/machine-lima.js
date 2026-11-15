// The machine layer's Lima backend (ASS-432; machine.js): a ticket
// variation's VM, a Lima instance under limaHome, reached through limactl,
// which keeps stdio and exit codes — so Claude's stream-json and a script's
// output and exit code work as on the host. The only file of src/control,
// src/agents and src/tui that runs limactl (shell, copy, list, stop):
// test/agent-cli/machine-guard.test.js fails on a limactl shell, copy or list
// anywhere else. agent-cli/machine-lima.bash is the same backend for the bash
// commands.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { dataDir } from '../data-folder.js';

// limaHome(env) — the folder every VM lives in (ASS-273): env's LIMA_HOME,
// else the untracked harness.local.json's lima-home (ASS-281: a machine's own
// settings; HARNESS_LOCAL_FILE, else beside the harness.json in use), else
// harness.json's lima-home (HARNESS_FILE, else the data folder's, as state.js
// paths), else ~/.lima, Lima's own default. agent-cli/lima-home.bash resolves
// it the same way for the bash commands.
export function limaHome(env = process.env) {
  if (env.LIMA_HOME) return env.LIMA_HOME;
  const file = env.HARNESS_FILE ?? join(dataDir(join(import.meta.dirname, '..', '..')), 'harness.json');
  const setIn = path => { try { return JSON.parse(readFileSync(path, 'utf8'))['lima-home']; } catch { return undefined; /* none: the next */ } };
  return setIn(env.HARNESS_LOCAL_FILE ?? join(dirname(file), 'harness.local.json')) || setIn(file) || join(env.HOME || homedir(), '.lima');
}

// limaEnv(env) — env with LIMA_HOME, where every VM lives (limaHome), unless it has one.
export const limaEnv = env => (env.LIMA_HOME ? env : { ...env, LIMA_HOME: limaHome(env) });

// A SIGTERM to the local `limactl shell` never reaches the VM (no tty, so
// sshd sends no signal: ASS-69), so a process that may be stopped runs under
// a bash whose own command line carries a marker unique to it, and which
// passes a TERM on to the process; stopMarked pkills the marker in the VM.
// stdin is passed on explicitly (a background job's is /dev/null otherwise);
// the exit code is the process's own. machine-lima.bash has the same.
const WRAP = 'trap \'kill -TERM "$c" 2>/dev/null\' TERM; "$@" <&0 & c=$!; while :; do wait "$c"; s=$?; kill -0 "$c" 2>/dev/null || exit "$s"; done';

// limactl(args, options) — its run, settled with { stdout, stderr }, or
// rejected with execFile's error (its code, killed and signal; stdout and
// stderr on it too); LIMA_HOME set in options.env (limaEnv).
const limactl = (args, { env = process.env, ...options } = {}) => new Promise((resolve, reject) =>
  execFile('limactl', args, { ...options, env: limaEnv(env) }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));

export const lima = {
  // command(vm, argv, { cwd, marker, env }) — { argv, env } that runs argv in
  // the VM, in cwd (no --workdir without it), under marker when given.
  command: (vm, argv, { cwd, marker, env = process.env } = {}) => ({
    argv: ['limactl', 'shell', ...(cwd ? ['--workdir', cwd] : []), vm, '--', ...(marker ? ['bash', '-c', WRAP, marker] : []), ...argv],
    env: limaEnv(env),
  }),
  // stopMarked(vm, marker, env) — not waited for. The pattern's first letter
  // is bracketed so it never matches the pkill's own command line.
  stopMarked: (vm, marker, env = process.env) => { limactl(['shell', vm, '--', 'pkill', '-TERM', '-f', `[${marker[0]}]${marker.slice(1)}`], { env }).catch(() => {}); },
  copyIn: (vm, local, remote, options) => limactl(['copy', '-r', local, `${vm}:${remote}`], options),
  copyOut: (vm, remote, local, options) => limactl(['copy', '-r', `${vm}:${remote}`, local], options),
  // statuses(options) — every Lima instance's status, by name.
  statuses: async options => new Map((await limactl(['list', '--format', '{{.Name}}\t{{.Status}}'], options)).stdout.split('\n').filter(Boolean).map(line => line.split('\t'))),
  // status(vm, options) — its status; null when there is no such instance.
  status: (vm, options) => limactl(['list', vm, '--format', '{{.Status}}'], options).then(({ stdout }) => stdout.trim(), () => null),
  // stop(vm, { force, ...options }) — limactl stop [-f].
  stop: (vm, { force, ...options } = {}) => limactl(['stop', ...(force ? ['-f'] : []), vm], options),
};
