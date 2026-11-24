// The machine layer's workstation backend (ASS-435; machine.js): a folder on
// one of a project's GCP Cloud Workstations — since ASS-468 its shared root,
// <home>/harness, which every ticket variation's steps use in turn —
// reached over that workstation's one SSH connection (ASS-433,
// workstation-connection.js sshArgv: a session of its own over the master,
// never a connection of its own; 255 at once when none is open).
// agent-cli/machine-workstation.bash is the same backend for the bash
// commands, and says how the folder stands in for a VM's root: its machine is
// workstation:<project>:<id>:<folder>, here the name <project>:<id>:<folder>;
// <folder>/repos is /repos, <folder>/ticket the ticket's read-only copy (a
// VM's /mnt/ticket), <folder>/run/harness the setup's runtime folder (a VM's
// /run/harness); every session runs in its workdir as wsPath maps it, with
// HARNESS_VM_ROOT the folder and ~/harness/env sourced (ASS-434: the
// harness's PATH and the credentials), under a marker when given, as in a VM.
import { execFile, spawn } from 'node:child_process';
import { controlPath, sshArgv } from './workstation-connection.js';

// What a session runs first (machine-workstation.bash's wsm_enter): into the
// workdir, HARNESS_VM_ROOT the folder, the harness's env sourced, then argv.
// ASS-529: then the folder's slot.env when it has one (workstation:claim's: a slot n's own forwarder token file; with
// ticket-isolation separate, the ticket's own COMPOSE_PROJECT_NAME and port offset too). Slot 0 of a project that has
// not opted in has none, so its sessions are exactly as before.
const ENTER = 'd="$1" f="$2"; shift 2; cd "$d" || exit 1; export HARNESS_VM_ROOT="$f"; [ -r "$HOME/harness/env" ] && . "$HOME/harness/env"; [ -r "$f/slot.env" ] && { set -a; . "$f/slot.env"; set +a; }; exec "$@"';
// The marker's wrapper, machine-lima.js's: a TERM passed on, stdin passed on, the exit code the process's own.
const WRAP = 'trap \'kill -TERM "$c" 2>/dev/null\' TERM; "$@" <&0 & c=$!; while :; do wait "$c"; s=$?; kill -0 "$c" 2>/dev/null || exit "$s"; done';

// parts(name) — { project, id, folder } of a workstation machine's name; throws, naming it, for any other.
export function parts(name) {
  const [project, id, folder, ...rest] = String(name).split(':');
  if (rest.length || !/^[A-Za-z0-9_-]+$/.test(project ?? '') || !/^[A-Za-z0-9_-]+$/.test(id ?? '') || !/^\/.*\/harness(\/|$)/.test(folder ?? '')) {
    throw new Error(`workstation:${name}: not a workstation machine (workstation:<project>:<id>:<folder under ~/harness>)`);
  }
  return { project, id, folder };
}

// wsPath(folder, path) — a VM path as the machine's folder has it: / (or
// none) the folder, /repos…, /run/harness… under it, /mnt/ticket… its ticket
// copy; any other as it is.
export function wsPath(folder, path) {
  if (!path || path === '/') return folder;
  if (/^\/(repos|run\/harness)(\/|$)/.test(path)) return `${folder}${path}`;
  if (/^\/mnt\/ticket(\/|$)/.test(path)) return `${folder}/ticket${path.slice('/mnt/ticket'.length)}`;
  return path;
}

// run(argv, env, options) — argv run on the Mac, settled with { stdout, stderr } or rejected with its error (stdout and stderr on it).
const run = ([file, ...args], env, options = {}) => new Promise((resolve, reject) =>
  execFile(file, args, { ...options, env }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));

// rsh(env, project, id) — the ssh rsync runs (-e) over the connection, workstation.bash workstation_rsh's.
const rsh = (env, project, id) => `ssh -S '${controlPath(env, project, id).replaceAll("'", `'\\''`)}' -o ControlMaster=no -o BatchMode=yes -o ProxyCommand=false`;
const shq = s => `'${String(s).replaceAll("'", `'\\''`)}'`;

// syncTicketCopy(name, ticketFolder, { env }) — AC4: the ticket folder on the
// Mac copied (rsync -a --delete over the connection) to the variation's
// <folder>/ticket, its write bit given back for the copy and then taken off
// everything (chmod -R a-w), as machine-workstation.bash wsm_sync_ticket
// does; resolves once both are done, rejects with the error that stopped it.
export async function syncTicketCopy(name, ticketFolder, { env = process.env, timeout = 120_000 } = {}) {
  const { project, id, folder } = parts(name), copy = `${folder}/ticket`;
  await run(['rsync', '-a', '--delete', `--rsync-path=mkdir -p ${shq(copy)} && chmod -R u+w ${shq(copy)} && rsync`, '-e', rsh(env, project, id), `${ticketFolder.replace(/\/$/, '')}/`, `workstation-${id}:${copy}/`], env, { timeout });
  await run(sshArgv(env, project, id, ['chmod', '-R', 'a-w', copy]), env, { timeout });
}

export const workstation = {
  // command(name, argv, { cwd, marker, env }) — { argv, env } that runs argv
  // in the machine's folder, in cwd (wsPath; the folder without one), under
  // marker when given.
  command: (name, argv, { cwd, marker, env = process.env } = {}) => {
    const { project, id, folder } = parts(name);
    return { argv: sshArgv(env, project, id, ['bash', '-c', ENTER, 'harness-ws', wsPath(folder, cwd), folder, ...(marker ? ['bash', '-c', WRAP, marker] : []), ...argv]), env };
  },
  // stopMarked(name, marker, env) — not waited for; the first letter bracketed so the pkill never matches its own command line.
  stopMarked: (name, marker, env = process.env) => {
    const { project, id } = parts(name);
    const [file, ...args] = sshArgv(env, project, id, ['pkill', '-TERM', '-f', `[${marker[0]}]${marker.slice(1)}`]);
    const child = spawn(file, args, { env, stdio: 'ignore' });
    child.on('error', () => {});
  },
  copyIn: (name, local, remote, { env = process.env, ...options } = {}) => {
    const { project, id, folder } = parts(name);
    return run(['rsync', '-a', '-e', rsh(env, project, id), local, `workstation-${id}:${wsPath(folder, remote)}`], env, options);
  },
  copyOut: (name, remote, local, { env = process.env, ...options } = {}) => {
    const { project, id, folder } = parts(name);
    return run(['rsync', '-a', '-e', rsh(env, project, id), `workstation-${id}:${wsPath(folder, remote)}`, local], env, options);
  },
  // statuses() — none listed: a workstation machine's state is its
  // connection's live data (workstations.json), read where it is needed
  // (workstation-machines.js), never a listing of every machine.
  statuses: async () => new Map(),
  // status(name, { env }) — Running when the connection is open and the
  // folder there, Stopped when no connection is open (ssh's 255), null when
  // the folder is missing.
  status: async (name, { env = process.env } = {}) => {
    const { project, id, folder } = parts(name);
    try { await run(sshArgv(env, project, id, ['test', '-d', `${folder}/repos`]), env, { timeout: 20_000 }); return 'Running'; } catch (error) { return error.code === 255 ? 'Stopped' : null; }
  },
  // stop() — nothing: the harness never stops a workstation (ASS-433: it stops itself once idle).
  stop: async name => { parts(name); },
};
