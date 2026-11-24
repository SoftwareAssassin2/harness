// Machine health (ASS-566): what the footer's second line counts — for the project on screen, each machine group it
// has, `local` (the Mac: its budget, its Lima VMs, sandboxes and worktrees), `gcp workstations` and `cloud VMs`, and
// in each the machines that are unhealthy and why. Unhealthy is what the header's warnings (frame.js headerWarnings)
// or the compute network screen (network.js) mark red or unusable:
// - a remote machine: sign in needed, setup failed, its start timed out, unreachable (seat-kinds.js lostWhy: it could
//   not be reached or started), its reading failed (remote-seats.json state unread), over its memory or CPU limit
//   (measured), its disk held (remote-seats.json disk.held, ASS-557), or its Substrate cluster in trouble;
// - the Mac: its memory or CPU over the harness's budget, or not readable (seat-budget.json mac.over, ASS-528), the
//   harness's disk hold (disk-space.json level hold, ASS-288), a memory hold (any project's memory-hold.json, ASS-398:
//   no VM starts), or the project's Substrate cluster on it in trouble.
// Stopped and idle is not unhealthy: a stopped workstation or cloud VM is started for the next ticket given to it.
// A Substrate cluster is in trouble (clusterTrouble) for each header chip about it (ASS-533, ASS-539): broken, missing,
// Docker down or not checked, a template with no golden snapshot, Docker's memory low, its snapshot disk high — read
// alike from its substrate.json check, none for a check older than SUBSTRATE_STALE_MS.
import { usesWorkstations, cloudVmsOf, workstationsOf } from '../control/dev-environments.js';
import { workstationState, cloudVmState } from '../control/workstation-machines.js';
import { lostWhy } from '../control/seat-kinds.js';
import { SNAPSHOT_FLOOR } from '../control/substrate-config.js';

export const SUBSTRATE_STALE_MS = 60 * 60e3;
export const SUBSTRATE_TROUBLE = { broken: 'broken', missing: 'cluster missing', 'docker-down': 'Docker down', unchecked: 'not checked' };
export const MEMORY_PROBLEMS = new Set(['docker memory', 'host memory']);
export const noGolden = p => p.what === 'templates' && !p.repair;

// snapshotTrouble(live, disk) — ASS-539 AC2: a cluster's snapshot disk (its check's usage.disk and snapshot-bytes) below
// the warning level while the project has snapshots there, { bytes, free, warn, hold, full } — full as
// substrate-config.js snapshotDisk has it (one more sandbox's snapshot, the average, at least SNAPSHOT_FLOOR, would take
// it below the hold) — or null.
export function snapshotTrouble(live, disk) {
  const free = live?.usage?.disk?.['free-bytes'];
  if (!Number.isFinite(free)) return null;
  const each = Object.values(live.usage['sandbox-use'] ?? {}).map(u => Number(u?.['snapshot-bytes']) || 0).filter(b => b > 0);
  const bytes = Number(live.usage['snapshot-bytes']) || each.reduce((a, b) => a + b, 0);
  const warn = disk?.['warn-bytes'] ?? 50e9, hold = disk?.['hold-bytes'] ?? 15e9;
  if (!(bytes > 0) || free >= warn) return null;
  const per = Math.max(SNAPSHOT_FLOOR, each.length ? each.reduce((a, b) => a + b, 0) / each.length : 0);
  return { bytes, free, warn, hold, full: free - per < hold };
}

// clusterTrouble(live, now, disk) — the short words for a Substrate cluster's troubles (its substrate.json check `live`),
// one per header chip frame.js substrateWarnings would show for it, in its order; [] when it is fine or not checked lately.
export function clusterTrouble(live, now = Date.now(), disk = null) {
  if (!live || !(now - Date.parse(live['checked-at'] ?? 0) < SUBSTRATE_STALE_MS)) return [];
  const problems = Array.isArray(live.problems) ? live.problems : [];
  const rest = problems.filter(p => !noGolden(p) && !MEMORY_PROBLEMS.has(p.what));
  const out = [];
  if (SUBSTRATE_TROUBLE[live.state] && (live.state !== 'broken' || rest.length || !problems.length)) out.push(live.state === 'broken' ? 'cluster broken' : live.state === 'unchecked' ? 'cluster not checked' : SUBSTRATE_TROUBLE[live.state]);
  if (problems.some(noGolden)) out.push('no golden snapshot');
  if (problems.some(p => MEMORY_PROBLEMS.has(p.what))) out.push('Docker memory low');
  if (snapshotTrouble(live, disk)) out.push('snapshot disk high');
  return out;
}

// remoteTroubles(project, w, now, disk) — why workstation or cloud VM `w` ({ id, kind }) of `project` is unhealthy, as
// short words; [] when it is healthy (running, or stopped and to be started).
const RED_WORDS = new Set(['sign in needed', 'setup failed', 'start timed out']);
export function remoteTroubles(project, w, now = Date.now(), disk = null) {
  const entry = project?.workstations?.[w.id], b = project?.remoteBudget?.[w.id];
  const word = (w.kind === 'cloud-vm' ? cloudVmState : workstationState)(entry);
  const out = [];
  if (RED_WORDS.has(word)) out.push(word);
  else if (lostWhy(entry)) out.push('unreachable');
  if (b?.state === 'unread') out.push('not read');
  if (b?.state === 'measured') {
    if (b['memory-used-bytes'] > b['memory-budget-bytes']) out.push('over memory');
    if (b['cpu-percent'] > b['cpu-budget-percent']) out.push('over cpu');
  }
  if (b?.disk?.held === true) out.push('disk held');
  return [...out, ...clusterTrouble(project?.substrate?.[w.id], now, disk)];
}

// macTroubles(state, project, now) — why the Mac is unhealthy for `project`, as short words; [] when it is healthy.
export function macTroubles(state, project, now = Date.now()) {
  const mac = (project?.seatBudget?.mac ?? (state.projects ?? []).map(p => p.seatBudget?.mac).find(Boolean)) ?? {};
  const over = Array.isArray(mac.over) ? mac.over : [];
  return [
    over.includes('unread') && 'not read',
    over.includes('memory') && 'over memory',
    over.includes('cpu') && 'over cpu',
    state.disk?.level === 'hold' && 'disk held',
    (state.projects ?? []).some(p => p.memoryHold) && 'out of memory',
    ...clusterTrouble(project?.substrate?.mac, now, state.disk),
  ].filter(Boolean);
}

// machineGroups(state, project, now) — the project's machine groups, in the footer's order: [{ name, machines: [{ id,
// troubles }] }]. `local` (the Mac) always (ASS-573: it runs control, the forwarder and Hindsight for every project;
// before, only while the project used the Mac);
// `gcp workstations` and `cloud VMs` while it runs tickets on its remote pool (usesWorkstations) and lists one.
export function machineGroups(state, project, now = Date.now()) {
  if (!project) return [];
  const settings = project.devEnvironments;
  const remote = settings && usesWorkstations(settings.mode);
  const groups = [];
  // ASS-573: `local` always — the Mac runs control, its forwarder and Hindsight for every project, whether or not the
  // project's tickets run there.
  groups.push({ name: 'local', machines: [{ id: 'mac', troubles: macTroubles(state, project, now) }] });
  const of = (name, list) => { if (remote && list.length) groups.push({ name, machines: list.map(w => ({ id: w.id, troubles: remoteTroubles(project, w, now, state.disk) })) }); };
  of('gcp workstations', workstationsOf(settings));
  of('cloud VMs', cloudVmsOf(settings));
  return groups;
}
