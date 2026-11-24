// Where a sprint ticket variation runs (ASS-559): the sprint screen's Machine and Runs in columns, one way of showing
// it in place of the older per-row marks (💺 a VM seat, ⛅ a workstation seat, 🌐 a cloud VM seat — ASS-357, ASS-469,
// ASS-481 — and ASS-535's 📦 with "· sandbox on <machine>" after the title). Read from the files control writes,
// never by asking a machine:
// - a variation the planner seats now (shared.js seatPlan: its current step uses its machine — ASS-527 — and it got a
//   seat or a Mac target) runs where its seats.json record says: the record's `target` (ASS-540; ASS-553's
//   workstation-worktree / cloud-vm-worktree too) and, on a remote machine, its `workstation` (the machine's id) —
//   the `seats` and `planning` lists, and the `local` list for the Mac targets (local-worktree, local-workspace). One
//   the planner seats before control has recorded it runs on the planner's target, its machine's id not known yet;
// - a variation seated nowhere (at a gate, a wait, a human step, a host-only script, waiting for a seat) runs on no
//   machine: both cells blank — unless its Substrate sandbox (the variation's `sandbox` record, ASS-535) is
//   hibernated or hibernating (ASS-537): then the sandbox's machine and "Substrate sandbox" / "hibernated", in gray —
//   where its work is parked;
// - a seated variation whose sandbox is still hibernated (resumed before its step, ASS-537) says "hibernated" too.
// The sandbox's state is sandboxState's: the cluster's check (substrate.json's sandbox-use) when newer than the
// record, else the record's — the n screen's rule for a machine card's sandboxes too (machine-tickets.js, ASS-572; ASS-539's substrate sandboxes box before).
import { visible, clip } from './text.js';

// RUNS_IN — how each run target runs the step (ASS-540's ten targets with ASS-553's): in its Lima VM, its Substrate
// sandbox, a git worktree of its own (on the Mac or a remote machine), the project's checkout on the Mac (workspace),
// or a slot — a working folder on a workstation or cloud VM (ASS-529).
export const RUNS_IN = {
  'local-vm': 'vm', 'local-substrate': 'sandbox', 'workstation-substrate': 'sandbox', 'cloud-vm-substrate': 'sandbox',
  'local-worktree': 'worktree', 'workstation-worktree': 'worktree', 'cloud-vm-worktree': 'worktree',
  'local-workspace': 'workspace', workstation: 'slot', 'cloud-vm': 'slot',
};
// HOSTS — the kind of machine each target is on (run-targets.js HOST_OF's, with ASS-553's two).
const HOSTS = {
  'local-vm': 'mac', 'local-substrate': 'mac', 'local-worktree': 'mac', 'local-workspace': 'mac',
  workstation: 'workstation', 'workstation-substrate': 'workstation', 'workstation-worktree': 'workstation',
  'cloud-vm': 'cloud-vm', 'cloud-vm-substrate': 'cloud-vm', 'cloud-vm-worktree': 'cloud-vm',
};
// A record written before run targets (ASS-540) has a seat kind alone: a VM seat ran in the Lima VM, a remote one in a slot.
const KIND_TARGET = { vm: 'local-vm', workstation: 'workstation', 'cloud-vm': 'cloud-vm' };

// The words drawn: each machine kind's label (long, and short for a narrow column) and each way of running's.
export const MACHINE_LABELS = { mac: ['Mac', 'Mac'], workstation: ['GCP workstation', 'Workstation'], 'cloud-vm': ['Cloud VM', 'Cloud VM'] };
export const RUNS_LABELS = { vm: ['Lima VM', 'Lima VM'], sandbox: ['Substrate sandbox', 'sandbox'], worktree: ['worktree', 'worktree'], workspace: ['workspace', 'workspace'], slot: ['slot', 'slot'] };
export const HIBERNATED = 'hibernated';
export const HIBERNATING = 'hibernating';

// sandboxState(record, check) — a sandbox's state word: running, resuming, hibernating, hibernated (or the check's
// own word for another state), from the cluster's check `check` (its sandbox-use entry with its machine's checked-at:
// { use, at }) when newer than the record, else the record's (running, or stopped: hibernated).
const STATES = { running: 'running', resuming: 'resuming', suspending: HIBERNATING, suspended: HIBERNATED, stopped: HIBERNATED };
export function sandboxState(record, { use, at } = {}) {
  const fresh = use && (!record || Date.parse(at ?? '') > Date.parse(record.at ?? ''));
  if (fresh) return STATES[use.state] ?? String(use.state ?? 'unknown');
  return record ? STATES[record.state] ?? String(record.state ?? 'running') : null;
}

const actorOf = (key, variation) => `${key}-${variation}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');   // machine-substrate.js sandboxActor
// sandboxOf(variation, live, key) — the variation's sandbox: { machine, state } from its record and its cluster's
// last check (`live`, the project's substrate.json entries by machine), or null when it records none.
function sandboxOf(v, live = {}, key) {
  const r = v?.sandbox;
  if (!r?.machine) return null;
  const check = live?.[r.machine];
  const use = check?.usage?.['sandbox-use']?.[r.name ?? actorOf(key, v.name)];
  return { machine: r.machine, state: sandboxState(r, { use, at: check?.['checked-at'] }) };
}

// placeOf(t, { held, records, planned, live, cloudVms }) — where ticket row `t`'s variation runs, or null for nowhere:
// { kind: mac | workstation | cloud-vm, id (the remote machine's; null on the Mac or not known yet), runs: vm |
// sandbox | worktree | workspace | slot, state: null, hibernated or hibernating, parked (true: seated nowhere, its
// hibernated sandbox shown) }. `held` whether the planner seats it now; `records` its seats.json records (seats,
// planning and local, in that order: the first naming it wins); `planned` the planner's target for it; `live` the
// project's substrate.json checks; `cloudVms` the ids of its cloud VMs (a sandbox record names its machine alone).
export function placeOf(t, { held = false, records = [], planned = null, live = {}, cloudVms = new Set() } = {}) {
  const v = t?.variation;
  if (!v) return null;
  const same = r => String(r?.key ?? '').toUpperCase() === String(t.key).toUpperCase() && r.variation === v.name;
  const sandbox = sandboxOf(v, live, t.key);
  const sleeping = sandbox && [HIBERNATED, HIBERNATING].includes(sandbox.state) ? sandbox.state : null;
  if (held) {
    const record = records.find(same);
    const target = (RUNS_IN[record?.target] && record.target) || KIND_TARGET[record?.kind] || planned || null;
    if (!target || !RUNS_IN[target]) return null;
    const kind = HOSTS[target];
    const id = kind === 'mac' ? null : record?.workstation ?? null;
    const runs = RUNS_IN[target];
    return { kind, id, runs, state: runs === 'sandbox' ? sleeping : null, parked: false };
  }
  if (!sleeping) return null;
  const kind = sandbox.machine === 'mac' ? 'mac' : cloudVms.has(sandbox.machine) ? 'cloud-vm' : 'workstation';
  return { kind, id: kind === 'mac' ? null : sandbox.machine, runs: 'sandbox', state: sleeping, parked: true };
}

const fits = (text, width) => visible(text) <= width;
const cut = (text, width) => (fits(text, width) ? text : `${clip(text, Math.max(0, width - 1))}…`);
const gray = text => `\x1b[90m${text}\x1b[0m`;

// machineCell(place) — the Machine column's cell (tableLayout's function cell: its lines at a width): blank for none;
// "Mac", "GCP workstation <id>" or "Cloud VM <id>" on one line while it fits, else the label (its short form when the
// long one does not fit) over the id, the id cut with an ellipsis. Gray for a parked (hibernated) sandbox.
export const machineCell = place => width => {
  if (!place) return '';
  const paint = place.parked ? gray : String;
  const [long, short] = MACHINE_LABELS[place.kind] ?? [place.kind, place.kind];
  const one = place.id ? `${long} ${place.id}` : long;
  if (fits(one, width)) return paint(one);
  const label = fits(long, width) ? long : short;
  return (place.id ? [label, cut(place.id, width)] : [label]).map(line => paint(line));
};

// runsCell(place) — the Runs in column's cell: blank for none; "Lima VM", "Substrate sandbox" (or "sandbox" in a
// narrow column), "worktree", "workspace" or "slot", and beneath a hibernated (or hibernating) sandbox's state, gray.
export const runsCell = place => width => {
  if (!place) return '';
  const [long, short] = RUNS_LABELS[place.runs] ?? [place.runs, place.runs];
  const label = fits(long, width) ? long : short;
  const lines = [place.parked ? gray(label) : label, ...(place.state ? [gray(place.state)] : [])];
  return lines.length === 1 ? lines[0] : lines;
};
