// The machine layer (ASS-432): every operation control, the agents and the
// TUI run against a ticket variation's machine — a command or an agent run in
// it, files copied in or out, its status, its stop — goes through here, so a
// second kind of machine (a GCP workstation over SSH, ASS-435) is added in
// one place, not at every call site. agent-cli/machine.bash is the same layer
// for the bash commands (and starts a machine: vm:start's machine_start, as a
// Lima VM starts only inside the sandbox vm:start sets up).
//
// A machine is named as the variation records it: its `vm` { name, kind }
// (ticket:set-vm, vm:create). Without a kind, or kind lima, it is the VM's
// Lima instance name, as ever (ass-74-a); any other kind is "<kind>:<name>"
// (machineOf), so the backend is chosen per ticket variation from what it
// records, and vm.js vmOf returns the machine so. Two backends: Lima
// (machine-lima.js) and, since ASS-435, a GCP workstation
// (machine-workstation.js), whose machine is
// workstation:<project>:<id>:<folder> from the variation's vm { kind:
// workstation, name: <id>, project, folder } — or, while one of its steps
// holds a workstation (ASS-468), its `workstation` { name, project, folder }
// — the folder the workstation's shared root, <home>/harness, standing in
// for a VM's root (machinePaths). ASS-481: a third, a cloud VM
// (machine-cloud-vm.js), named cloud-vm:<project>:<id>:<folder> alike. A new one is
// a module exporting what `lima` does (command, stopMarked, copyIn, copyOut,
// statuses, status, stop), added to BACKENDS under its kind. ASS-535: a
// fourth, a Substrate sandbox (machine-substrate.js, which says the design
// and the interface the later Substrate tickets build on), named
// substrate:<project>:<machine>:<actor> from the variation's `sandbox` while
// its run target is a substrate one.
//
// Lima-specific, outside the layer: building the golden image and creating,
// cloning and deleting a VM (the bash vm:* commands), and limaHome, the
// folder the VMs and their disks are in (disk and memory readings, the TUI).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lima } from './machine-lima.js';
import { workstation, parts as workstationParts, wsPath } from './machine-workstation.js';
import { cloudVm } from './machine-cloud-vm.js';
import { substrate, parts as sandboxParts, sandboxMachine } from './machine-substrate.js';

const BACKENDS = { lima, workstation, 'cloud-vm': cloudVm, substrate };
// ASS-535: the substrate run targets — a step on one runs in the variation's sandbox.
export const SUBSTRATE_RUN_TARGETS = new Set(['local-substrate', 'workstation-substrate', 'cloud-vm-substrate']);
// ASS-481: the remote kinds — a project's pool, its workstations and its cloud VMs — whose machine is
// <kind>:<project>:<id>:<folder>, a folder on the remote reached over its one connection.
export const REMOTE_KINDS = ['workstation', 'cloud-vm'];

// ASS-565: the run target a variation was handed over to this tick (run-target-places.js readyTarget). The variation
// control loaded is a deep-frozen parse (read.js deepFreeze, ASS-548's read cache), so readyTarget cannot write its
// `run-target` onto it (that threw "Cannot add property run-target, object is not extensible" and held every step
// moving onto or off a Mac or Substrate target). code:hand-over records it on disk, and the next load reads it; until
// then it is kept here, by the loaded variation object itself: a WeakMap, so the note goes with that parse — a later
// load of the rewritten sprint file is a new object, read from disk alone.
const handedOver = new WeakMap();
// noteRunTarget(variation, record) — `record` ({ target, at }) taken as the variation's run-target for as long as this
// loaded object is in use.
export const noteRunTarget = (variation, record) => { if (variation && typeof variation === 'object') handedOver.set(variation, record); };
// runTargetOf(variation) — the variation's run-target ({ target, at }): the one noted this tick, else its loaded
// `run-target`; null with neither. Every reader of a loaded variation's run-target in control goes through it.
export const runTargetOf = variation => (variation && typeof variation === 'object' ? handedOver.get(variation) ?? variation['run-target'] ?? null : null);

// machineOf(variation) — the variation's machine, as named above; undefined
// when it has none (its Create VM step has not run). ASS-468: while one of
// its steps holds a workstation, the variation's `workstation` { name,
// project, folder } (workstation:claim) is its machine, whatever its vm
// records — in vm+workstation mode a variation with a VM runs a step on the
// workstation when one is free.
// ASS-481: a cloud VM's claim records kind cloud-vm on the variation's `workstation` (its vm, kind cloud-vm), and its
// machine is cloud-vm:<project>:<id>:<folder> alike.
// ASS-535: while its run target is a substrate one — `target` when given (control's, from this tick's seats), else the
// one it last ran on (its `run-target`, code:hand-over's) — its sandbox (machine-substrate.js sandboxMachine), when it
// records one; a substrate target with none yet gives undefined (its sandbox is made first: sandboxes.js).
export function machineOf(variation, target) {
  const on = target ?? runTargetOf(variation)?.target;
  if (SUBSTRATE_RUN_TARGETS.has(on)) return sandboxMachine(variation);
  const held = variation?.workstation?.name && variation.workstation.project && variation.workstation.folder ? { ...variation.workstation, kind: variation.workstation.kind ?? 'workstation' } : null;
  const { name, kind = 'lima', project, folder } = held ?? variation?.vm ?? {};
  if (!name) return undefined;
  if (REMOTE_KINDS.includes(kind) && project && folder) return `${kind}:${project}:${name}:${folder}`;
  return kind === 'lima' ? name : `${kind}:${name}`;
}

// onWorkstation(machine) — { project, id, folder, kind } when `machine` is a
// workstation's (ASS-435) or, ASS-481, a cloud VM's (kind 'cloud-vm'): a
// remote machine of the project's pool; else null.
export function onWorkstation(machine) {
  const kind = REMOTE_KINDS.find(k => machine?.startsWith(`${k}:`));
  if (!kind) return null;
  try { return { ...workstationParts(machine.slice(kind.length + 1)), kind }; } catch { return null; }
}

// onSandbox(machine) — ASS-535: { project, machine, actor } when `machine` is a Substrate sandbox's
// (substrate:<project>:<machine>:<actor>); else null.
export function onSandbox(machine) {
  if (!machine?.startsWith?.('substrate:')) return null;
  try { return sandboxParts(machine.slice('substrate:'.length)); } catch { return null; }
}

// remoteName(machine) — a remote machine's name without its kind (<project>:<id>:<folder>), as its backend and
// syncTicketCopy take it; null for any other.
export const remoteName = machine => (onWorkstation(machine) ? machine.slice(machine.indexOf(':') + 1) : null);

// machinePaths(machine) — where things are in the machine (ASS-435): {
// repos, the folder holding each repository's checkout (a step's cwd and
// {folder}); ticket, the ticket folder's read-only view; where, how an agent
// is told where it is }. A VM's: /repos/ and /mnt/ticket (vm.js REPOS,
// TICKET_FOLDER); a workstation's: its shared root's repos/ and ticket (ASS-468).
export function machinePaths(machine) {
  if (onSandbox(machine)) {
    const { machine: host, actor } = onSandbox(machine);
    return { repos: '/repos/', ticket: '/mnt/ticket', kind: 'sandbox', where: `in this ticket variation's own Substrate sandbox, ${actor}, on ${host === 'mac' ? 'the Mac' : host}: its repositories under /repos, checked out on this ticket variation's branches; commit your work on its branch before you finish (a sandbox has no Docker: steps that need it run on a full machine)` };
  }
  const ws = onWorkstation(machine);
  if (!ws) return { repos: '/repos/', ticket: '/mnt/ticket', kind: 'VM', where: `in this ticket variation's own VM, ${machine}` };
  return { repos: `${wsPath(ws.folder, '/repos')}/`, ticket: wsPath(ws.folder, '/mnt/ticket'), kind: 'workstation', where: `on the ${ws.kind === 'cloud-vm' ? 'GCP cloud VM' : 'GCP workstation'} ${ws.id}, in its shared repositories under ${ws.folder}, checked out on this ticket variation's branches for this step: commit and push your work on its branch before you finish (what a step that does not finish leaves uncommitted is discarded; a commit on master is refused)` };
}

// parseMachine(machine) — { kind, name }.
export function parseMachine(machine) {
  const i = machine.indexOf(':');
  return i < 0 ? { kind: 'lima', name: machine } : { kind: machine.slice(0, i), name: machine.slice(i + 1) };
}

// backendOf(machine) — [its backend, its name there]; throws, naming it, for
// a kind there is no backend of.
function backendOf(machine) {
  const { kind, name } = parseMachine(machine), backend = BACKENDS[kind];
  if (!backend) throw new Error(`${name}: no machine backend for its kind '${kind}' (there is: ${Object.keys(BACKENDS).join(', ')})`);
  return [backend, name];
}

// newMarker() — a marker of its own for a process that may be stopped (machineCommand, stopMarked).
export const newMarker = () => `harness-step-${randomUUID()}`;

// machineCommand(machine, argv, { cwd, marker, env }) — { argv, env }: what
// to spawn on the Mac to run argv in the machine, in `cwd` (the backend's
// default without one), under `marker` when given; stdin, stdout, stderr
// and the exit code are the process's own. A local signal to it may never
// reach the process in the machine (a VM's does not, ASS-69): stopMarked
// ends one run under a marker.
export function machineCommand(machine, argv, options = {}) {
  const [backend, name] = backendOf(machine);
  return backend.command(name, argv, options);
}

// runInMachine(machine, argv, { cwd, env, timeout }) — argv run in the
// machine, waited for: resolves to { stdout, stderr }, rejects with the
// error (its code; stdout and stderr on it) when it fails or times out.
export function runInMachine(machine, argv, { cwd, env = process.env, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const { argv: [file, ...args], env: runEnv } = machineCommand(machine, argv, { cwd, env });
    execFile(file, args, { ...options, env: runEnv }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
  });
}

// stopMarked(machine, marker, env) — SIGTERM, in the machine, to the process
// running under `marker`; not waited for.
export function stopMarked(machine, marker, env) {
  const [backend, name] = backendOf(machine);
  backend.stopMarked(name, marker, env);
}

// copyIn(machine, local, remote, { env }) / copyOut(machine, remote, local,
// { env }) — a file or folder copied into or out of the machine; settle as
// runInMachine does.
export function copyIn(machine, local, remote, options) {
  const [backend, name] = backendOf(machine);
  return backend.copyIn(name, local, remote, options);
}
export function copyOut(machine, remote, local, options) {
  const [backend, name] = backendOf(machine);
  return backend.copyOut(name, remote, local, options);
}

// machineStatus(machine, { env }) — its status (Running, Stopped, …); null
// when there is no such machine.
export function machineStatus(machine, options) {
  const [backend, name] = backendOf(machine);
  return backend.status(name, options);
}

// machineStatuses({ env, timeout, killSignal }) — every machine's status, by
// machine; rejects with the first backend's error that cannot list its own.
export async function machineStatuses(options) {
  const all = new Map();
  for (const [kind, backend] of Object.entries(BACKENDS)) {
    for (const [name, status] of await backend.statuses(options)) all.set(kind === 'lima' ? name : `${kind}:${name}`, status);
  }
  return all;
}

// stopMachine(machine, { force, env, timeout, signal, killSignal }) — the
// machine stopped (force: at once); rejects with the error when it was not.
export function stopMachine(machine, options) {
  const [backend, name] = backendOf(machine);
  return backend.stop(name, options);
}
