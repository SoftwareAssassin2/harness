// The machine layer's Substrate sandbox backend (ASS-535; machine.js): a ticket variation's own sandbox — a Substrate
// actor on the kind cluster of the machine its seat is on (the Mac's, a workstation's or a cloud VM's; ASS-533) — as a
// fourth kind of machine beside Lima VMs, workstations and cloud VMs. agent-cli/machine-substrate.bash is the same
// backend for the bash commands; agent-cli/substrate/sandbox.bash and the substrate:sandbox-* commands make, start,
// stop and delete the sandboxes; src/control/sandboxes.js is control's side (when a sandbox is made, waited for,
// hibernated, moved and deleted).
//
// The interface the later tickets build on (ASS-536 forwarder, ASS-537 hibernation, ASS-538 credentials, ASS-542 app
// stack):
//
// - Name. A sandbox machine is substrate:<project>:<machine>:<actor> (machine.js machineOf, from the variation's
//   `sandbox` record while its run target is a substrate one; parts(name) splits it). <machine> is the cluster's —
//   mac, or one of the project's workstation or cloud VM ids — and <actor> is <KEY>-<variation> in lower case
//   (sandboxActor): one sandbox per ticket variation, never shared between tickets or variations. Its atespace and
//   namespace are the project's, harness-<project> (substrate-config.js namespaceOf).
// - The variation's record (its sprint file, written only by the substrate:sandbox-* commands): `sandbox` { name
//   (the actor), project, machine, template (the ActorTemplate it was made from: sandbox-<digest's first 12>), image
//   (that digest), state ('running' | 'stopped'), created-at, at }.
// - Lifecycle commands (agent.sh), each printing one JSON line:
//     substrate:sandbox-up <project> <KEY> <variation> <machine>   made (from the project's image, delivered to the
//         cluster's own registry: substrate:deliver-image) or resumed, its endpoint up, /mnt/ticket brought up to
//         date; a new one gets the variation's branches from origin (relay.bash relay_in); exit 4 for a crashed one
//         (ASS-568: never resumed, nothing changed — control replaces it, sandboxes.js)
//     substrate:sandbox-stop <project> <KEY> <variation>            suspended (hibernated: files and processes kept)
//     substrate:sandbox-delete <project> <KEY> <variation> [--keep-work|--salvage]   deleted (--keep-work: its branches
//         pushed to origin through the Mac first: relay.bash relay_out; --salvage, ASS-568: the same for a crashed one,
//         only while its command server still answers, never stopping the delete — salvaged, salvage)
//     substrate:sandbox-state|sandbox-endpoint|sandbox-suspend <project> <machine> <actor>   one actor's, for the
//         machine layer: its state; its endpoint made reachable (resumed, proxied, forwarded); suspended
//     substrate:sandbox-sync-ticket <project> <KEY> <variation>     /mnt/ticket brought up to date (read-only)
// - Running a command: command() spawns src/substrate/sandbox-exec.js, which talks to the sandbox image's command
//   server (ASS-534; no exec API in Substrate: ASS-532) on the Mac's loopback — the endpoint file
//   <HARNESS_SUBSTRATE_DIR|~/.harness/substrate>/sandboxes/<project>/<actor>.json { port } — through `kubectl ate
//   proxy actor` on the cluster's machine (forwarded over a remote machine's one SSH connection). stdin, stdout,
//   stderr and the exit code are the process's own, as through `limactl shell`; it runs as the image's user `agent`
//   (passwordless sudo) in a login shell, in `cwd` (a sandbox path: /repos/<repo>, /mnt/ticket; its home without
//   one), under `marker` (stopMarked pkills it there). A command whose sandbox does not answer gets its endpoint
//   set up again once (resuming a hibernated sandbox: a proxy resumes its actor), then fails 255 as ssh would.
// - Paths are a VM's (machinePaths): /repos/<repo> each repository (baked into the image), /mnt/ticket the ticket
//   folder's read-only copy (synced, not mounted: sandbox-up, and control before each agent and in-machine script).
// - copyIn/copyOut: a tar stream through the command server, as root. status: Running (running or resuming),
//   Stopped (suspended), null (none, or its machine not connected). stop: suspended (hibernated). statuses: none —
//   a sandbox's state is its variation's record and its cluster's (substrate.json's sandbox-use), never a listing.
// - The Mac from a sandbox (ASS-536): the forwarder (agent.sh) and its project's Hindsight only, at macHost(name) —
//   host.docker.internal on the Mac's cluster, harness-mac.<namespace>.svc.cluster.local on a workstation's or cloud
//   VM's (the machine's relay over its SSH connection) — each port through an egress rule of the sandbox's rule set
//   "mac" (sandbox.bash). substrate:sandbox-up issues it a forwarder token (bound in vm-tokens.json under its machine
//   name, the token and URL in its /run/harness, as a VM's) and substrate:sandbox-delete revokes it.
// - Credentials and egress (ASS-538, src/substrate/egress.js): no token in it — Substrate's egress gateway injects
//   them from the cluster's Secrets (substrate:credentials) into requests to its allowlist's hosts, the sandbox's rule
//   set "credentials" beside "mac"; sandbox-up gives it those rules and placeholders. Its branches still move through
//   the Mac (relay.bash), which a later ticket may change now that it can reach its forges.
// - Hibernation (ASS-537; sandboxes.js says when): substrate:sandbox-stop suspends it — files, processes and memory
//   kept in its snapshot, its forwarder binding, its egress rule sets ("mac", "credentials") and the namespace's
//   credential Secrets untouched (only sandbox-delete revokes or removes its own) — and substrate:sandbox-up resumes it
//   as it was (created false, nothing brought in; a fresh forwarder token written to /run/harness, its binding
//   replaced, as at every sandbox-up). A command run in a hibernated sandbox still resumes it (above); control
//   hibernates such a one again. substrate:health measures each sandbox's snapshot disk (sandbox-use's
//   snapshot-bytes), the project's in all, the node's disk and the WorkerPool's requests.
// - What a sandbox has not got yet: Docker (never: run targets keep Docker steps off it, ASS-540).
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { namespaceOf } from './substrate-config.js';

const ROOT = join(import.meta.dirname, '..', '..');
const EXEC = join(ROOT, 'src', 'substrate', 'sandbox-exec.js');
const AGENT = join(ROOT, 'agent.sh');
const MACHINE_BASH = join(ROOT, 'src', 'agent-cli', 'machine.bash');

// parts(name) — { project, machine, actor } of a sandbox machine's name (without its kind); throws, naming it, for any other.
export function parts(name) {
  const [project, machine, actor, ...rest] = String(name).split(':');
  if (rest.length || !/^[A-Za-z0-9_-]+$/.test(project ?? '') || !/^[A-Za-z0-9_-]+$/.test(machine ?? '') || !/^[a-z0-9-]+$/.test(actor ?? '')) {
    throw new Error(`substrate:${name}: not a sandbox machine (substrate:<project>:<machine>:<actor>)`);
  }
  return { project, machine, actor };
}

// sandboxActor(key, variation) — a variation's sandbox's actor name: <key>-<variation>, lower case (sandbox.bash's).
export const sandboxActor = (key, variation) => `${key}-${variation}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

// sandboxMachine(variation) — the variation's sandbox as a machine name (substrate:<project>:<machine>:<actor>), or
// undefined when it records none.
export const sandboxMachine = variation => {
  const s = variation?.sandbox;
  return s?.name && s.project && s.machine ? `substrate:${s.project}:${s.machine}:${s.name}` : undefined;
};

// macHost(name) — the name a sandbox machine reaches the Mac's forwarder and Hindsight at (ASS-536; sandbox.bash
// sandbox_mac_host): host.docker.internal on the Mac's cluster (Docker Desktop's name for the Mac's loopback), else its
// cluster's Service for the machine's relay.
export function macHost(name) {
  const { project, machine } = parts(name);
  return machine === 'mac' ? 'host.docker.internal' : `harness-mac.${namespaceOf(project)}.svc.cluster.local`;
}

// run(file, args, env, options) — settled with { stdout, stderr }, or rejected with the error (stdout and stderr on it).
const run = (file, args, env, options = {}) => new Promise((resolve, reject) =>
  execFile(file, args, { ...options, env }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));

export const substrate = {
  // command(name, argv, { cwd, marker, env }) — { argv, env }: sandbox-exec.js running argv in the sandbox.
  command: (name, argv, { cwd, marker, env = process.env } = {}) => {
    const { project, machine, actor } = parts(name);
    return { argv: [process.execPath, EXEC, '--sandbox', `${project}:${machine}:${actor}`, ...(cwd ? ['--workdir', cwd] : []), ...(marker ? ['--marker', marker] : []), '--', ...argv], env };
  },
  // stopMarked(name, marker, env) — not waited for; the first letter bracketed so the pkill never matches its own command line.
  stopMarked: (name, marker, env = process.env) => {
    const { project, machine, actor } = parts(name);
    const child = spawn(process.execPath, [EXEC, '--sandbox', `${project}:${machine}:${actor}`, '--root', '--', 'pkill', '-TERM', '-f', `[${marker[0]}]${marker.slice(1)}`], { env, stdio: 'ignore' });
    child.on('error', () => {});
  },
  copyIn: (name, local, remote, { env = process.env, ...options } = {}) => { parts(name); return run('bash', ['-c', `source "${MACHINE_BASH}"; machine_copy_in "$@"`, 'copy-in', `substrate:${name}`, local, remote], env, options); },
  copyOut: (name, remote, local, { env = process.env, ...options } = {}) => { parts(name); return run('bash', ['-c', `source "${MACHINE_BASH}"; machine_copy_out "$@"`, 'copy-out', `substrate:${name}`, remote, local], env, options); },
  // statuses() — none listed (see the module comment).
  statuses: async () => new Map(),
  // status(name, { env }) — Running, Stopped, or null when there is none (or its machine is not connected).
  status: async (name, { env = process.env } = {}) => {
    const { project, machine, actor } = parts(name);
    try {
      const out = JSON.parse((await run(AGENT, ['substrate:sandbox-state', project, machine, actor], env, { timeout: 60_000 })).stdout.trim().split('\n').pop());
      return ['running', 'resuming'].includes(out.state) ? 'Running' : out.state ? 'Stopped' : null;
    } catch { return null; }
  },
  // stop(name, options) — suspended (hibernated), its proxy ended.
  stop: (name, { env = process.env, ...options } = {}) => { const { project, machine, actor } = parts(name); return run(AGENT, ['substrate:sandbox-suspend', project, machine, actor], env, options); },
};
