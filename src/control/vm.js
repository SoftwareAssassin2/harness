// Where a `run-location: vm` step runs (ASS-74): inside its ticket
// variation's Lima VM (vm:create records it on the variation, `vm.name`),
// through `limactl shell`, which keeps stdio and exit codes — so Claude's
// stream-json and a script's output and exit code work as on the host. A step
// without run-location runs on the host; a state-engine step always does
// (only its sub-engine's steps run in one place or the other).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { dataDir } from '../data-folder.js';

// Every repository of the project is checked out at /repos/<basename>: the
// parent is a vm step's cwd and {folder}. The ticket's folder is mounted, read-only (ASS-182), at
// /mnt/ticket, its {ticket-folder}. agent.sh is on the VM's PATH: the
// forwarder's client (src/agent-cli/vm/in-vm/agent.sh).
export const REPOS = '/repos/';
export const TICKET_FOLDER = '/mnt/ticket';

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

export const runsInVm = step => step?.['run-location'] === 'vm' && step.action?.type !== 'state-engine';

// vmOf(variation, who) — the name of the variation's VM; throws, naming
// `who`, when it has none (its Create VM step has not run), so the step is
// held and tried again as any failing dispatch or script is.
export function vmOf(variation, who) {
  const name = variation?.vm?.name;
  if (!name) throw new Error(`${who} runs in its VM, and the variation has none: its Create VM step (vm:create) has not run`);
  return name;
}

// A SIGTERM to the local `limactl shell` never reaches the VM (no tty, so
// sshd sends no signal: ASS-69), so a process that may be stopped runs under
// a bash whose own command line carries a marker unique to it, and which
// passes a TERM on to the process; stopInVm pkills the marker in the VM.
// stdin is passed on explicitly (a background job's is /dev/null otherwise);
// the exit code is the process's own.
const WRAP = 'trap \'kill -TERM "$c" 2>/dev/null\' TERM; "$@" <&0 & c=$!; while :; do wait "$c"; s=$?; kill -0 "$c" 2>/dev/null || exit "$s"; done';
export const newMarker = () => `harness-step-${randomUUID()}`;

// inVm(vm, argv, { cwd, marker }) — argv as run in the VM, in `cwd`
// (/repos/ by default), under `marker` when given.
export const inVm = (vm, argv, { cwd = REPOS, marker } = {}) =>
  ['limactl', 'shell', '--workdir', cwd, vm, '--', ...(marker ? ['bash', '-c', WRAP, marker] : []), ...argv];

// limaEnv(env) — env with LIMA_HOME, where every VM lives (limaHome), unless it has one.
export const limaEnv = env => (env.LIMA_HOME ? env : { ...env, LIMA_HOME: limaHome(env) });

// stopInVm(vm, marker, env) — SIGTERM, in the VM, to the process running
// under `marker`; not waited for. The pattern's first letter is bracketed so
// it never matches the pkill's own command line.
export function stopInVm(vm, marker, env) {
  execFile('limactl', ['shell', vm, '--', 'pkill', '-TERM', '-f', `[${marker[0]}]${marker.slice(1)}`], { env: limaEnv(env) }, () => {});
}
