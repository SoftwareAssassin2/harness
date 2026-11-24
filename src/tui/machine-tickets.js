// What is on each machine (ASS-572): for the compute network screen's cards (n, network.js), the project on screen's
// tickets on one machine, one entry each, with its kind and what it is doing. It replaces the machine boxes the screen
// drew before (ASS-566's machine-boxes.js: gcp workstations, cloud virtual machines, local virtual machines, substrate
// sandboxes, local — the footer's until ASS-566), whose facts each card now carries for its own machine:
// - a workstation or cloud VM: the tickets holding a folder on it (workstations.json `holder` / `holders`, ASS-529):
//   a slot (📁), or the ticket's worktree there (🌿, ASS-553: a holder recorded `worktree`); then each other sprint
//   variation whose `remote-worktrees` names it, idle (kept there between its steps until the ticket is done);
// - the Mac: its seat holders' Lima VMs (💺, ASS-486/489/491: seats.json's VM seats, at most the seat budget's, then
//   the planning holders the planner seats on a Lima VM — seatPlan, the sprint screen's source — each "creating" in gray
//   until vms.json has its VM); the project's checkout (📂 workspace, ASS-541: its holder, or "free" while none holds
//   it) and its ticket worktrees (🌿: the local-worktree holders, then every sprint variation whose
//   build.worktree-folder is set, idle);
// - every machine: the project's Substrate sandboxes on its cluster (📦, ASS-539): each sprint variation's `sandbox`
//   record, a seat holder on a substrate target with no sandbox there yet ("starting"), then any actor the cluster's
//   check measured that no variation names; their state the cluster's check's when newer than the record
//   (places.js sandboxState — the sprint screen's rule): running, resuming, hibernating, hibernated, starting, and
//   ASS-568's crashed ("crashed (will be replaced)", red: control replaces it at its next step), with the sandbox's
//   memory and CPU while it runs and its snapshot's disk while hibernated.
// Each entry's activity is the dashboard's (variationActivity): 🤖 (×N with several) for the project's agents on the
// variation, 💻 while it runs a script step (the sprint screen's runsScript: none at a gate, held, or on a past day),
// then its step's name; a gold "unsandboxed" while one of its agents runs without Claude Code's sandbox (ASS-564).
// Counted only while the variation is on that place (a worktree whose ticket moved back to its VM shows idle).
import { holdersOf } from '../control/workstation-connection.js';
import { seatCapacity } from '../control/seat-kinds.js';
import { projectAssignments, sprintTickets, runsScript, GLYPHS, gray, green, red, gold, seatPlan, ellipsis } from './screens/shared.js';
import { sandboxState } from './places.js';
import { AMBER } from './gauge.js';

export const ICONS = { sandbox: '📦', worktree: '🌿', vm: '💺', slot: '📁', workspace: '📂' };
export const KIND_WORDS = { sandbox: 'sandbox', worktree: 'worktree', vm: 'Lima VM', slot: 'slot', workspace: 'workspace' };
const GIB = 2 ** 30;
const gib = bytes => (bytes / GIB).toFixed(1);
const KEY = 14, STEP = 22;

const sameKey = (a, b) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();
const actorOf = (key, variation) => `${key}-${variation}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');   // machine-substrate.js sandboxActor

// variationActivity(state)(ticket, variation) — what a variation is doing: { agents (the project's assignments on it,
// ASS-435: same ticket, case-insensitive, and variation), unsandboxed (ASS-564: how many of those run without Claude
// Code's sandbox, their session's sandbox.json, state.sandboxed), script (ASS-485: the ticket in the sprint on show
// runs a script step, the sprint screen's runsScript) }.
export const variationActivity = state => {
  const assignments = projectAssignments(state);
  const { tickets } = sprintTickets(state);
  return (ticket, variation) => ({
    agents: assignments.filter(a => sameKey(a['work-item'], ticket) && a.variation === variation).length,
    unsandboxed: assignments.filter(a => sameKey(a['work-item'], ticket) && a.variation === variation && state.sandboxed?.[a['agent-name']]?.sandboxed === false).length,
    script: tickets.some(t => sameKey(t.key, ticket) && t.variation?.name === variation && runsScript(state, t)),
  });
};

// STATE_WORDS — a sandbox's or VM's state as the card shows it.
const SANDBOX_WORDS = {
  running: green('running'), hibernated: gray('hibernated'), starting: gray('starting'), resuming: AMBER('resuming'),
  hibernating: AMBER('hibernating'), crashed: red('crashed (will be replaced)'),
};

// ticketsOn(state, project, machine, { cpuCapacity }) — the entries on `machine` ('mac', or a workstation's or cloud
// VM's id), in order: [{ kind (ICONS' keys), key, variation, text }] — `text` the whole line, colored. `cpuCapacity`
// the machine's CPU in percent of one core (cores × 100), so a sandbox's CPU is shown as a share of the machine.
export function ticketsOn(state, project, machine, { cpuCapacity = null } = {}) {
  const activity = variationActivity(state);
  const { tickets } = sprintTickets(state);
  const stepOf = (key, variation) => {
    const t = tickets.find(x => sameKey(x.key, key) && (x.variation?.name ?? 'A') === variation);
    const step = t?.status?.detailStep;
    return String(step?.name ?? step?.id ?? t?.status?.detail ?? '');
  };
  // doing(key, variation, on) — its activity words, [] when idle (or not on this place now).
  const doing = (key, variation, on = true) => {
    if (!on || key == null) return [];
    const a = activity(key, variation);
    const icons = [a.agents > 1 ? `${GLYPHS.agent}x${a.agents}` : a.agents ? GLYPHS.agent : '', a.script ? GLYPHS.script : ''].filter(Boolean).join(' ');
    if (!icons) return [];
    const step = stepOf(key, variation);
    return [[icons, step && ellipsis(step, STEP)].filter(Boolean).join(' '), ...(a.unsandboxed ? [gold('unsandboxed')] : [])];
  };
  const entry = (kind, key, variation, parts, name = null) => {
    const who = key != null ? `${ellipsis(String(key), KEY)}${variation && variation !== 'A' ? ` ${variation}` : ''}` : ellipsis(String(name ?? ''), KEY);
    return { kind, key, variation, text: `${ICONS[kind]} ${who} ${KIND_WORDS[kind]} · ${parts.filter(Boolean).join(' · ')}` };
  };
  const out = [];
  if (machine === 'mac') out.push(...limaVms(state, project, doing, entry));
  else out.push(...remotePlaces(project, machine, tickets, doing, entry));
  out.push(...sandboxesOn(project, machine, tickets, doing, entry, cpuCapacity));
  if (machine === 'mac') out.push(...localPlaces(project, tickets, doing, entry));
  return out;
}

// remotePlaces — a workstation's or cloud VM's holders (slots and worktrees), then the worktrees kept there idle.
function remotePlaces(project, id, tickets, doing, entry) {
  const holders = holdersOf(project.workstations?.[id]);
  const kept = tickets.filter(t => (t.variation?.['remote-worktrees'] ?? []).some(w => w?.name === id) && !holders.some(h => h.worktree && sameKey(h.ticket, t.key) && h.variation === (t.variation.name ?? 'A')));
  return [
    ...holders.map(h => { const kind = h.worktree ? 'worktree' : 'slot'; const d = doing(h.ticket, h.variation); return entry(kind, h.ticket, h.variation, d.length ? d : [gray('idle')]); }),
    ...kept.map(t => entry('worktree', t.key, t.variation.name ?? 'A', [gray('idle')])),
  ];
}

// limaVms — the Mac's seat holders' Lima VMs (seats.json VM seats not on local-substrate, at most the seat budget's,
// then the planning holders the planner seats on a Lima VM).
function limaVms(state, project, doing, entry) {
  const vms = Object.entries(project.vms ?? {});
  const line = (key, variation) => {
    const [, vm] = vms.find(([, v]) => sameKey(v?.ticket, key) && v?.variation === variation) ?? [];
    const word = vm ? String(vm.state ?? 'stopped').toLowerCase() : null;
    return entry('vm', key, variation, [...doing(key, variation), vm ? (word === 'running' ? green(word) : word) : gray('creating')]);
  };
  const seats = (project.seats ?? []).filter(s => s?.kind === 'vm' && s.target !== 'local-substrate');
  const { vm: limit } = seatCapacity({ seatBudget: project.seatBudget, devEnvironments: project.devEnvironments ?? { mode: 'vm' }, workstations: project.workstations });
  const plan = seatPlan(state);
  const planning = plan.planning.map(name => { const at = name.indexOf(' '); return { name, key: name.slice(0, at), variation: name.slice(at + 1) }; })
    .filter(p => { const t = plan.targets.get(p.name); return (!t || t === 'local-vm') && !seats.some(s => sameKey(s.key, p.key) && s.variation === p.variation); });
  return [
    ...(Number.isFinite(limit) ? seats.slice(0, limit) : seats).map(s => line(s.key, s.variation)),
    ...planning.map(p => line(p.key, p.variation)),
  ];
}

// localPlaces — the Mac's checkout (while local-workspace is a run target) and its ticket worktrees.
function localPlaces(project, tickets, doing, entry) {
  const targets = Array.isArray(project.runTargets) ? project.runTargets : [];
  const local = (Array.isArray(project.localSeats) ? project.localSeats : []).filter(s => s?.key != null);
  const out = [];
  const worktrees = local.filter(s => s.target === 'local-worktree');
  const made = targets.includes('local-worktree') || worktrees.length
    ? tickets.filter(t => t.variation?.build?.['worktree-folder'] && !worktrees.some(s => sameKey(s.key, t.key) && s.variation === (t.variation.name ?? 'A')))
    : [];
  out.push(...worktrees.map(s => { const d = doing(s.key, s.variation); return entry('worktree', s.key, s.variation, d.length ? d : [gray('idle')]); }));
  out.push(...made.map(t => entry('worktree', t.key, t.variation.name ?? 'A', [gray('idle')])));
  if (targets.includes('local-workspace')) {
    const holder = local.find(s => s.target === 'local-workspace');
    if (holder) { const d = doing(holder.key, holder.variation); out.push(entry('workspace', holder.key, holder.variation, d.length ? d : [gray('idle')])); }
    else out.push({ kind: 'workspace', key: null, variation: null, text: `${ICONS.workspace} ${gray('workspace free')}` });
  }
  return out;
}

// sandboxesOn — the project's sandboxes on the machine's cluster (see the module comment).
function sandboxesOn(project, machine, tickets, doing, entry, cpuCapacity) {
  const live = project.substrate?.[machine];
  const rows = [], seen = new Set();
  const add = row => { seen.add(row.actor); rows.push(row); };
  for (const t of tickets) {
    const r = t.variation?.sandbox;
    if (r?.name && r.machine === machine) add({ key: t.key, variation: t.variation.name ?? 'A', actor: r.name, record: r });
  }
  for (const seat of project.seats ?? []) {
    if (!/-substrate$/.test(seat?.target ?? '')) continue;
    const on = seat.target === 'local-substrate' ? 'mac' : seat.workstation;
    const actor = actorOf(seat.key, seat.variation);
    if (on === machine && !seen.has(actor)) add({ key: seat.key, variation: seat.variation, actor, record: null });
  }
  for (const actor of Object.keys(live?.usage?.['sandbox-use'] ?? {})) if (!seen.has(actor)) add({ key: null, variation: null, actor, record: null });
  return rows.map(row => {
    const use = live?.usage?.['sandbox-use']?.[row.actor];
    const word = sandboxState(row.record, { use, at: live?.['checked-at'] }) ?? 'starting';
    const shown = SANDBOX_WORDS[word] ?? word;
    const cpu = Number(use?.['cpu-percent']) || 0;
    const figures = ['running', 'resuming', 'hibernating'].includes(word)
      ? (use?.['memory-bytes'] > 0 ? `${gib(use['memory-bytes'])} GiB${cpuCapacity > 0 ? ` ${Math.round(cpu / cpuCapacity * 100)}% CPU` : ''}` : gray('not measured'))
      : word === 'hibernated' && use?.['snapshot-bytes'] > 0 ? gray(`(${gib(use['snapshot-bytes'])} GiB snapshot)`) : '';
    return entry('sandbox', row.key, row.variation, [...doing(row.key, row.variation, row.key != null), `${shown}${figures ? ` ${figures}` : ''}`], row.actor);
  });
}
