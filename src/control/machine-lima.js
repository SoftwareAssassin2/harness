// The machine layer's Lima backend (ASS-432; machine.js): a ticket
// variation's VM, a Lima instance under limaHome, reached through limactl,
// which keeps stdio and exit codes — so Claude's stream-json and a script's
// output and exit code work as on the host. The only file of src/control,
// src/agents and src/tui that runs limactl (shell, copy, list, stop):
// test/agent-cli/machine-guard.test.js fails on a limactl shell, copy or list
// anywhere else. agent-cli/machine-lima.bash is the same backend for the bash
// commands.
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { dataDir } from '../data-folder.js';

// limaHome(env) — the harness-wide Lima folder (ASS-273): env's
// HARNESS_LIMA_HOME (agent-cli/lima-home.bash exports it beside a project's
// own LIMA_HOME), else its LIMA_HOME, else the untracked harness.local.json's
// lima-home (ASS-281: a machine's own settings; HARNESS_LOCAL_FILE, else
// beside the harness.json in use), else harness.json's lima-home
// (HARNESS_FILE, else the data folder's, as state.js paths), else ~/.lima,
// Lima's own default. agent-cli/lima-home.bash resolves it the same way for
// the bash commands (lima_home_default).
export function limaHome(env = process.env) {
  if (env.HARNESS_LIMA_HOME) return env.HARNESS_LIMA_HOME;
  if (env.LIMA_HOME) return env.LIMA_HOME;
  const file = env.HARNESS_FILE ?? join(dataDir(join(import.meta.dirname, '..', '..')), 'harness.json');
  const setIn = path => { try { return JSON.parse(readFileSync(path, 'utf8'))['lima-home']; } catch { return undefined; /* none: the next */ } };
  return setIn(env.HARNESS_LOCAL_FILE ?? join(dirname(file), 'harness.local.json')) || setIn(file) || join(env.HOME || homedir(), '.lima');
}

// ASS-578: a project may keep its Lima VMs and golden image in a folder of its own, project.json's lima-home (an
// absolute path, say on a disk of its own); unset, it uses the harness-wide one. Its golden image and ticket VMs are
// always in the same folder (a ticket VM is an APFS clone of the golden disk; clones can't cross volumes). Every Lima
// call runs with the folder holding its instance as LIMA_HOME, per call (limaFor), and the harness-wide views — the
// memory and CPU readings, the dashboard's shutdown, every instance's status — cover every folder in use (limaHomes).
// lima-home.bash is the same for the bash commands.
const projectsDir = env => env.PROJECTS_DIR ?? join(dataDir(join(import.meta.dirname, '..', '..')), 'projects');
const projectJson = (dir, id) => { try { return JSON.parse(readFileSync(join(dir, id, 'project.json'), 'utf8')); } catch { return null; } };
const trimmed = path => (path.length > 1 ? path.replace(/\/+$/, '') : path);

// limaHomeProblem(home) — why a project.json lima-home can't be used (null when it can, or is unset): not an absolute
// path, or not writable — its nearest existing folder, as Lima makes the folder on first use (an unmounted disk's
// /Volumes/<name> is not writable, so its VMs never land on the boot volume). Control logs it (lima-home-check.js).
export function limaHomeProblem(home) {
  if (home == null) return null;
  if (typeof home !== 'string' || !isAbsolute(home)) return `lima-home ${JSON.stringify(home)} is not an absolute path`;
  let dir = home;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try { accessSync(dir, constants.W_OK); } catch { return `lima-home ${JSON.stringify(home)} is not writable (${dir})`; }
  return null;
}

// projectLimaHome(project, env) — the project's Lima folder: its project.json lima-home when usable, else the
// harness-wide one (a lima-home that can't be used is control's to log, and the bash commands refuse it).
export function projectLimaHome(project, env = process.env) {
  const home = projectJson(projectsDir(env), project)?.['lima-home'];
  return home != null && !limaHomeProblem(home) ? trimmed(home) : limaHome(env);
}

// limaHomes(env) — every Lima folder in use: the harness-wide one first, then each project's own (absolute), once each.
export function limaHomes(env = process.env) {
  const homes = [limaHome(env)];
  let ids = [];
  try { ids = readdirSync(projectsDir(env)); } catch { /* no projects folder: the harness-wide one alone */ }
  for (const id of ids.sort()) {
    const home = projectJson(projectsDir(env), id)?.['lima-home'];
    if (typeof home === 'string' && isAbsolute(home) && !homes.includes(trimmed(home))) homes.push(trimmed(home));
  }
  return homes;
}

// vmLimaHome(vm, env) — the folder holding the instance: the first of limaHomes that has it, else the harness-wide one.
export function vmLimaHome(vm, env = process.env) {
  const homes = limaHomes(env);
  return homes.find(home => existsSync(join(home, vm))) ?? homes[0];
}

// limaEnv(env) — env with LIMA_HOME, the harness-wide folder (limaHome), unless it has one.
export const limaEnv = env => (env.LIMA_HOME ? env : { ...env, LIMA_HOME: limaHome(env) });
// limaFor(vm, env) — env with LIMA_HOME the folder holding that instance (vmLimaHome), per call.
export const limaFor = (vm, env = process.env) => ({ ...env, LIMA_HOME: vmLimaHome(vm, env) });

// A SIGTERM to the local `limactl shell` never reaches the VM (no tty, so
// sshd sends no signal: ASS-69), so a process that may be stopped runs under
// a bash whose own command line carries a marker unique to it, and which
// passes a TERM on to the process; stopMarked pkills the marker in the VM.
// stdin is passed on explicitly (a background job's is /dev/null otherwise);
// the exit code is the process's own. machine-lima.bash has the same.
const WRAP = 'trap \'kill -TERM "$c" 2>/dev/null\' TERM; "$@" <&0 & c=$!; while :; do wait "$c"; s=$?; kill -0 "$c" 2>/dev/null || exit "$s"; done';

// limactl(args, options) — its run, settled with { stdout, stderr }, or
// rejected with execFile's error (its code, killed and signal; stdout and
// stderr on it too); LIMA_HOME the folder holding options.vm (limaFor, ASS-578), else options.home, else env's (limaEnv).
const limactl = (args, { env = process.env, vm, home, ...options } = {}) => new Promise((resolve, reject) =>
  execFile('limactl', args, { ...options, env: vm ? limaFor(vm, env) : home ? { ...env, LIMA_HOME: home } : limaEnv(env) }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));

export const lima = {
  // command(vm, argv, { cwd, marker, env }) — { argv, env } that runs argv in
  // the VM, in cwd (no --workdir without it), under marker when given.
  command: (vm, argv, { cwd, marker, env = process.env } = {}) => ({
    argv: ['limactl', 'shell', ...(cwd ? ['--workdir', cwd] : []), vm, '--', ...(marker ? ['bash', '-c', WRAP, marker] : []), ...argv],
    env: limaFor(vm, env),
  }),
  // stopMarked(vm, marker, env) — not waited for. The pattern's first letter
  // is bracketed so it never matches the pkill's own command line.
  stopMarked: (vm, marker, env = process.env) => { limactl(['shell', vm, '--', 'pkill', '-TERM', '-f', `[${marker[0]}]${marker.slice(1)}`], { env, vm }).catch(() => {}); },
  copyIn: (vm, local, remote, options) => limactl(['copy', '-r', local, `${vm}:${remote}`], { ...options, vm }),
  copyOut: (vm, remote, local, options) => limactl(['copy', '-r', `${vm}:${remote}`, local], { ...options, vm }),
  // statuses(options) — every Lima instance's status, by name, in every Lima folder in use (ASS-578: limaHomes; a
  // project's folder not there yet has none). The first folder holding a name gives its status, as vmLimaHome finds it.
  statuses: async (options = {}) => {
    const all = new Map();
    for (const [i, home] of limaHomes(options.env ?? process.env).entries()) {
      if (i > 0 && !existsSync(home)) continue;
      const { stdout } = await limactl(['list', '--format', '{{.Name}}\t{{.Status}}'], { ...options, home });
      for (const [name, status] of stdout.split('\n').filter(Boolean).map(line => line.split('\t'))) if (!all.has(name)) all.set(name, status);
    }
    return all;
  },
  // status(vm, options) — its status; null when there is no such instance.
  status: (vm, options) => limactl(['list', vm, '--format', '{{.Status}}'], { ...options, vm }).then(({ stdout }) => stdout.trim(), () => null),
  // stop(vm, { force, ...options }) — limactl stop [-f].
  stop: (vm, { force, ...options } = {}) => limactl(['stop', ...(force ? ['-f'] : []), vm], { ...options, vm }),
};
