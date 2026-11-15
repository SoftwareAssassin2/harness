// Where a `run-location: vm` step runs (ASS-74): inside its ticket
// variation's Lima VM (vm:create records it on the variation, `vm.name`),
// through the machine layer (machine.js; for a VM, `limactl shell`), which
// keeps stdio and exit codes — so Claude's stream-json and a script's output
// and exit code work as on the host. A step
// without run-location runs on the host; a state-engine step always does
// (only its sub-engine's steps run in one place or the other).
import { machineOf } from './machine.js';

// What runs in a VM, and what it is asked, goes through the machine layer
// (machine.js, ASS-432: machineCommand, stopMarked, machineStatuses, …);
// the Lima backend (machine-lima.js) holds limaHome and limaEnv, kept
// importable from here.
export { limaHome, limaEnv } from './machine-lima.js';
// ASS-435: where things are in a machine — a VM's /repos/ and /mnt/ticket
// below, or a GCP workstation folder's repos/ and ticket — is machine.js
// machinePaths'; REPOS and TICKET_FOLDER stay a VM's.
export { machinePaths } from './machine.js';

// Every repository of the project is checked out at /repos/<basename>: the
// parent is a vm step's cwd and {folder}. The ticket's folder is mounted, read-only (ASS-182), at
// /mnt/ticket, its {ticket-folder}. agent.sh is on the VM's PATH: the
// forwarder's client (src/agent-cli/vm/in-vm/agent.sh).
export const REPOS = '/repos/';
export const TICKET_FOLDER = '/mnt/ticket';

export const runsInVm = step => step?.['run-location'] === 'vm' && step.action?.type !== 'state-engine';

// vmOf(variation, who) — the variation's VM, as the machine layer names it
// (machine.js machineOf: its Lima name); throws, naming `who`, when it has
// none (its Create VM step has not run), so the step is held and tried again
// as any failing dispatch or script is.
export function vmOf(variation, who) {
  const name = machineOf(variation);
  if (!name) throw new Error(`${who} runs in its VM, and the variation has none: its Create VM step (vm:create) has not run`);
  return name;
}
