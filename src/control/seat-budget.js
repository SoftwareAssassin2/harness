// ASS-528: seats come from the Mac's memory and CPU budget, shared between
// projects by percentage, instead of seat counts (project.json's and
// harness.json's max-tickets-in-progress and max-tickets-in-planning are
// gone: harness:migrate-seat-budget removes them). Operator decisions,
// 2026-11-22:
//
// - The budget: harness.json's max-memory-percent and max-cpu-percent (90 and
//   90 by default, DEFAULT_BUDGET) — how much of the Mac's memory (hw.memsize)
//   and CPU (its cores × 100%) the harness may use.
// - Shares (resolveShares): a project's project.json `share` is a percentage
//   of that budget. Projects without one split what the set ones leave
//   equally; set ones adding to more than 100 are scaled down to 100, logged
//   (with nothing then left for the unset ones). A share that is not a number
//   from 0 to 100 is ignored, logged, as if unset.
// - One pool (plan.js): planning and building take the same seats, in
//   control's rank order. max-tickets-ready-for-build (ASS-362) still caps
//   finished plans.
// - Machines are never shared: each belongs to one project and runs only its
//   tickets. A project spends its share only on its own machines on the Mac —
//   its Lima VMs (seat-kinds.js: modes vm and vm+workstation). Its demand (its
//   `want`) is how many Mac seats its tickets would hold with no limit: those
//   in motion at a step that uses their machine (plan.js slotKind), after its
//   remote seats (workstations, cloud VMs: still one seat each, ASS-529
//   follows), and those queued to take one (plan.js `queued`: at Committed,
//   or a finished plan waiting for Build) that its free remote seats would
//   not take. A project with only remote work (workstation mode) wants none.
// - Allocation (allocate), each tick, apart for memory and for CPU: each
//   project is allotted its share of the budget, at most what its demand
//   needs (want × its expected use of one ticket); what is left — the shares
//   of projects that cannot use theirs, and any part of 100% no project's
//   share names — goes to the projects that still want more, in proportion to
//   their shares (equally when those are all 0), and on to the next when they
//   are satisfied; nothing is lost while any project could use it. Never to a
//   project that cannot use it on its own machines.
// - A project's allotment in seats (allotSeats) is the fewest its memory and
//   its CPU allotments carry — its own share at least, which is always its to
//   take — one ticket costing its expected use:
//   memory, the memory hold's need for one new VM of the project
//   (host-memory.js memoryNeed: the largest footprint of its running VMs plus
//   the margin, the floor with none running); CPU, the average CPU of its
//   running VMs over the CPU window (host-cpu.js), at least harness.json's
//   cpu-need-floor-percent (DEFAULT_CPU_FLOOR: one core).
// - Admission (grantSeats): a project holding fewer seats than its allotment
//   (and than it wants) is given another only while the Mac's measured use —
//   macOS's used memory (hw.memsize less its free percentage), the CPU
//   averaged over the window — plus the expected use of the seats given whose
//   VMs are not running yet (`starting`), plus one more ticket, stays within
//   both limits (at the limit admits; over it does not). The headroom is given
//   one seat at a time to the project furthest below its allotment — first to
//   those whose tickets want a seat now, then what is left to those under
//   their allotment, for work that starts during the tick — so a project
//   whose demand returns takes the next seats freed until it is back at its
//   share. A tick with the Mac over either limit admits nobody. CPU
//   has hysteresis: once its averaged use reaches the CPU limit, no seat is
//   given for CPU until it is back below the limit by cpu-hysteresis-percent
//   (DEFAULT_CPU_BAND) of the Mac.
// - ASS-533 AC5: a project's Substrate cluster on the Mac (dev-environments.substrate.clusters' mac entry; the one kind cluster
//   the Mac projects share) counts against its share like its VMs: its part (its fixed cost, about 2.5 GiB and 30% of a
//   core, split between the projects sharing it, plus its active sandboxes at their memory and CPU — substrate-config.js
//   macLoad) comes off its allotment before its seats are counted, and, while the cluster is not up (not in the Mac's
//   measured use yet), off the Mac's room as a starting VM's does (reserveOf, grantSeats' reserve).
// - ASS-535 AC3: a project whose tickets run on the Mac in Substrate sandboxes (local-substrate before local-vm in its
//   run targets, macSandboxes) spends its share on them instead: one ticket's expected use is a sandbox's, not a VM's —
//   ASS-570: ticket-estimate.js estimateFor, from working sandboxes' measured memory (their worker pods' cgroups,
//   rootfs writes included) and CPU only (an agent turn or in-machine script running through the reading; never an
//   idle, starting, hibernated or hibernating one, which made the allotment swing 30 ↔ 3 seats), the larger of their
//   recent 80th percentile and the cluster entry's sandbox-memory-gib / sandbox-cpu-percent (the floor, and all of it
//   with no samples), moved at most a factor 1.1 a tick and kept across restarts (ticket-estimate.json); where it came
//   from is in the budget log line and seat-budget.json's per-ticket (source, samples, floor, target); its part of the cluster then counts the fixed cost alone (its sandboxes are its seats' use); a seat
//   holder is `starting` while its sandbox is not measured running; a hibernated sandbox holds no seat (ASS-527).
// - ASS-537 AC3: a hibernated sandbox uses no memory or CPU (its worker pod's cgroup is empty: sandboxUse measures 0, and
//   it is neither active nor a seat holder); what it does keep is counted where it lives: its project's WorkerPool's
//   warm workers' memory requests (substrate-config.js warmPool: Kubernetes reserves them even empty) are part of the
//   project's cluster reserve, off its allotment; and its snapshots' disk (snapshotDisk: every sandbox's, its templates'
//   golden ones) against the cluster's disk — a project on sandboxes whose cluster's disk would fall below
//   disk-free-hold-gb with one more ticket's snapshot gets no new seat (`diskFull`; those held keep theirs), logged once
//   when it starts and ends; seat-budget.json's used.substrate says both (pool-memory-bytes, snapshot-bytes,
//   disk-free-bytes, disk-full).
// - Nothing running is cut off: a project may always hold the seats it holds
//   (`held`: its seat holders recorded in seats.json, plan.js seatedIn), even
//   over its allotment; it only gets no new one until it is back under, so
//   freed seats go to whoever is below its share.
//
// The phase (budgetSeats, before seats.js each tick) works this out for every
// project (each control sees them all: state.allProjects, so they agree) and
// writes each of its own projects' result to data/projects/<p>/seat-budget.json
// (seatBudgetFile; atomically, when the seats or the figures behind them
// change) — { seats (the Mac seats it may hold now, null for no limit), share,
// allotment, used (ASS-530: with its VMs' measured memory and CPU), lends,
// borrows (ASS-530), want, per-ticket, mac } — which state.js loads as the
// project's seatBudget: plan.js planFor's Mac seat count (seat-kinds.js
// seatCapacity), and the dashboard's. Each change of a project's share,
// allotment or seats used is logged once (AC6). Without a reading of the
// Mac's memory or CPU (a failed read) that limit is not applied, the other one
// is; with neither read no new seat is given — those held keep running — logged
// once per outage (conservative, orchestrator decision 2026-11-22). Only with no
// reader at all (HOST_MEMORY_DISABLED=1, the test fixtures' switch) are seats
// not limited.
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { seatBudgetFile } from './seat-budget-file.js';
import { reading as memoryReading, memoryNeed, projectVms, freeBytes, gib } from './host-memory.js';
import { cpuReading } from './host-cpu.js';
import { planFor } from './plan.js';
import { MODES_WITH_VMS } from './seat-kinds.js';
import { macLoad, clusterEntry, sandboxUse, snapshotDisk, MAC } from './substrate-config.js';
import { estimateFor } from './ticket-estimate.js';
import { variationBusy } from './sandboxes.js';
import { sandboxActor } from './machine-substrate.js';

const PHASE = 'budget';
export { SEAT_BUDGET_FILE, seatBudgetFile } from './seat-budget-file.js';
export const DEFAULT_BUDGET = Object.freeze({ 'max-memory-percent': 90, 'max-cpu-percent': 90 });
export const DEFAULT_CPU_FLOOR = 100;   // harness.json cpu-need-floor-percent: one core
export const DEFAULT_CPU_BAND = 5;      // harness.json cpu-hysteresis-percent: points of the Mac's CPU
const EPS = 1e-9;

// validShare(value) — a share is a number from 0 to 100.
const validShare = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

// resolveShares(projects) — AC3: [{ id, share (project.json's, or undefined) }] → { shares (id → percent), source (id
// → 'set' | 'split'), scaled (null, or { sum }: the set shares added to more than 100 and were scaled down to 100),
// invalid ([{ id, share }] ignored) }.
export function resolveShares(projects) {
  const invalid = projects.filter(p => p.share != null && !validShare(p.share)).map(p => ({ id: p.id, share: p.share }));
  const set = projects.filter(p => validShare(p.share)), unset = projects.filter(p => !validShare(p.share));
  const sum = set.reduce((a, p) => a + p.share, 0);
  const scale = sum > 100 ? 100 / sum : 1;
  const shares = new Map(), source = new Map();
  for (const p of set) { shares.set(p.id, p.share * scale); source.set(p.id, 'set'); }
  const rest = Math.max(0, 100 - Math.min(sum, 100));
  for (const p of unset) { shares.set(p.id, unset.length ? rest / unset.length : 0); source.set(p.id, 'split'); }
  return { shares, source, scaled: sum > 100 ? { sum } : null, invalid };
}

// allocate(total, projects) — AC4: [{ id, share (percent), want (in the dimension's units: what its demand needs; 0
// for a project that cannot use the Mac) }] → Map id → its allotment: its share of `total`, at most its want; what is
// left given to those still wanting more, in proportion to their shares (equally when all of those are 0), round by
// round, so none is lost while any project could use it.
export function allocate(total, projects) {
  const out = new Map(projects.map(p => [p.id, Math.min(Math.max(0, p.want), (p.share / 100) * total)]));
  let left = total - [...out.values()].reduce((a, b) => a + b, 0);
  for (let round = 0; round <= projects.length && left > EPS; round++) {
    const hungry = projects.filter(p => p.want - out.get(p.id) > EPS);
    if (!hungry.length) break;
    const weights = hungry.map(p => p.share), sum = weights.reduce((a, b) => a + b, 0);
    let given = 0;
    hungry.forEach((p, i) => {
      const part = left * (sum > EPS ? weights[i] / sum : 1 / hungry.length), give = Math.min(part, p.want - out.get(p.id));
      out.set(p.id, out.get(p.id) + give);
      given += give;
    });
    left -= given;
  }
  return out;
}

// grantSeats({ budget, mac, projects }) — AC4, AC5: the Mac seats each project may hold now, pure.
// `budget` { memory (bytes), cpu (percent of one core) }, either null when not measured (not applied);
// `mac` { memory (its measured use, bytes), cpu (averaged, percent of one core), cpuFull (hysteresis: no seat for CPU) };
// `projects` [{ id, share (resolved percent), canUse (it has machines of its own on the Mac), want (the Mac seats its
// tickets would hold with no limit), held (those it holds now), starting (of those, the ones whose VMs are not running
// yet: not in the measured use), per { memory, cpu } (one ticket's expected use), diskFull (ASS-537 AC3: its sandboxes'
// snapshots have no room for one more ticket's on its cluster's disk: no seat granted), reserve (ASS-533 AC5: its part of the
// Mac's Substrate cluster, { memory, cpu, pending } — substrate-config.js macLoad — or null: it comes off its allotment
// before its seats, and while the cluster is not up (pending: not in the measured use yet) off the Mac's room too) }].
// Returns Map id → { share, allotment { memory, cpu } (null where not applied), allotSeats, want, held, granted,
// seats (held + granted; with neither memory nor CPU read, `unread` — a reader there whose reading failed — held alone
// and over ['unread']; with no reader at all, HOST_MEMORY_DISABLED, Infinity), over ([dimensions the Mac is over]),
// lends, borrows ({ memory, cpu } where applied, ASS-530: of its share, what other projects use; above it, what it uses
// of theirs) }.
export function grantSeats({ budget, mac, projects, unread = false }) {
  const dims = ['memory', 'cpu'].filter(d => budget?.[d] != null);
  const out = new Map();
  if (!dims.length) {
    // Neither read: with `unread` (readers there, their readings failing) no new seat — those held keep theirs; without
    // (HOST_MEMORY_DISABLED: no reader at all, the tests' switch) not limited.
    for (const p of projects) out.set(p.id, unread
      ? { share: p.share, allotment: { memory: null, cpu: null }, allotSeats: p.held, want: p.want, held: p.held, granted: 0, seats: p.held, over: ['unread'] }
      : { share: p.share, allotment: { memory: null, cpu: null }, allotSeats: Infinity, want: p.want, held: p.held, granted: 0, seats: p.canUse ? Infinity : 0, over: [] });
    return out;
  }
  const per = (p, d) => Math.max(EPS, p.per?.[d] ?? 0);
  const res = (p, d) => Math.max(0, p.reserve?.[d] ?? 0);   // ASS-533 AC5: its Substrate cluster's part
  const allot = Object.fromEntries(dims.map(d => [d, allocate(budget[d], projects.map(p => ({ id: p.id, share: p.share, want: p.canUse ? p.want * per(p, d) + res(p, d) : 0 })))]));
  const room = Object.fromEntries(dims.map(d => [d, budget[d] - (mac?.[d] ?? 0) - projects.reduce((a, p) => a + (p.starting ?? 0) * per(p, d) + (p.reserve?.pending ? res(p, d) : 0), 0)]));
  const over = dims.filter(d => (mac?.[d] ?? 0) > budget[d] || (d === 'cpu' && mac?.cpuFull));
  for (const p of projects) {
    // Its own share is always its to take (it may start work this tick); what it borrows comes on top (allocate).
    const mine = d => (p.canUse ? Math.max(allot[d].get(p.id), (p.share / 100) * budget[d]) : 0);
    const allotSeats = p.canUse ? Math.min(...dims.map(d => Math.floor(Math.max(0, mine(d) - res(p, d)) / per(p, d) + 1e-6))) : 0;
    out.set(p.id, { share: p.share, allotment: { memory: allot.memory ? mine('memory') : null, cpu: allot.cpu ? mine('cpu') : null }, allotSeats, want: p.want, held: p.held, granted: 0, seats: p.held, over });
  }
  // ASS-530: what each project lends and borrows, per dimension, for the dashboard's footer. A project borrows what its
  // allotment takes above its own share; the shares the borrowers draw on are the spare ones — what a project's
  // demand leaves of its share (all of it, for one that cannot use the Mac) and the part of 100% no share names. Each
  // spare share is lent in proportion: the borrowed total over the spare total, at most all of it.
  for (const d of dims) {
    const own = p => (p.share / 100) * budget[d];
    const borrowed = new Map(projects.map(p => [p.id, p.canUse ? Math.max(0, Math.max(allot[d].get(p.id), own(p)) - own(p)) : 0]));
    const spare = new Map(projects.map(p => [p.id, Math.max(0, own(p) - (p.canUse ? allot[d].get(p.id) : 0))]));
    const named = projects.reduce((a, p) => a + own(p), 0);
    const spareTotal = [...spare.values()].reduce((a, b) => a + b, 0) + Math.max(0, budget[d] - named);
    const borrowedTotal = [...borrowed.values()].reduce((a, b) => a + b, 0);
    const lentPart = spareTotal > EPS ? Math.min(1, borrowedTotal / spareTotal) : 0;
    for (const p of projects) {
      const r = out.get(p.id);
      (r.lends ??= {})[d] = spare.get(p.id) * lentPart;
      (r.borrows ??= {})[d] = borrowed.get(p.id);
    }
  }
  if (over.length) return out;   // AC5: a tick over either limit admits nobody
  // The Mac's headroom handed out one seat at a time: first to the projects whose tickets want one now, up to their
  // allotment; then what is left to those under their allotment, for work that starts during the tick (a ticket
  // entering planning from Committed).
  const hand = cap => {
    const open = new Set(projects.filter(p => p.canUse).map(p => p.id));
    for (;;) {
      const candidates = projects.filter(p => open.has(p.id)).map(p => ({ p, r: out.get(p.id) })).filter(({ r }) => r.seats < cap(r));
      if (!candidates.length) return;
      // The furthest below its allotment first (a project whose demand returned takes the next seats), then the larger share.
      candidates.sort((a, b) => a.r.seats / Math.max(a.r.allotSeats, EPS) - b.r.seats / Math.max(b.r.allotSeats, EPS) || b.p.share - a.p.share || String(a.p.id).localeCompare(String(b.p.id)));
      const { p, r } = candidates[0];
      if (p.diskFull || dims.some(d => per(p, d) > room[d] + 1e-6)) { open.delete(p.id); continue; }   // one more of its tickets does not fit the Mac (ASS-537: or its snapshots' disk)
      for (const d of dims) room[d] -= per(p, d);
      r.granted++;
      r.seats++;
    }
  };
  hand(r => Math.min(r.allotSeats, r.want));
  hand(r => r.allotSeats);
  return out;
}

// reserveOf(project, all) — ASS-533 AC5: the project's part of the Mac's Substrate cluster (substrate-config.js macLoad:
// its fixed cost split between the projects declaring it, plus its own active sandboxes), { memory, cpu, pending (the
// cluster not up at its last check, so not in the Mac's measured use) }; null when it declares none.
export function reserveOf(project, all) {
  const l = macLoad(project, all, { sandboxes: !macSandboxes(project) });   // ASS-535: its sandboxes are its seats' use
  return l ? { memory: l.memory, cpu: l.cpu, pending: !l.running, pool: l.pool } : null;
}

// macSandboxes(project) — ASS-535 AC3: the project's tickets run on the Mac in Substrate sandboxes: local-substrate comes
// before local-vm in its run targets, and it has a cluster on the Mac.
export function macSandboxes(project) {
  const targets = project?.runTargets?.targets ?? [];
  const sub = targets.indexOf('local-substrate'), vm = targets.indexOf('local-vm');
  return sub >= 0 && (vm < 0 || sub < vm) && Boolean(clusterEntry(project, MAC));
}

// cpuNeed(ctx, state, project, cpu) — one ticket's expected CPU (percent of one core): the average of its running
// VMs' averaged CPU (host-cpu.js), at least harness.json's cpu-need-floor-percent; the floor with none running.
export function cpuNeed(ctx, state, project, cpu) {
  const floor = state.harness?.['cpu-need-floor-percent'] ?? DEFAULT_CPU_FLOOR;
  if (!cpu?.vms?.size) return floor;
  const names = projectVms(ctx, project), used = [...cpu.vms].filter(([name]) => names.has(name)).map(([, pct]) => pct);
  return used.length ? Math.max(floor, used.reduce((a, b) => a + b, 0) / used.length) : floor;
}

// budgetOf(harness) — harness.json's budget, DEFAULT_BUDGET where it says none.
export const budgetOf = harness => ({
  memory: harness?.['max-memory-percent'] ?? DEFAULT_BUDGET['max-memory-percent'],
  cpu: harness?.['max-cpu-percent'] ?? DEFAULT_BUDGET['max-cpu-percent'],
});

// budgetSeats(ctx, state) — the tick's phase (see the module comment).
export async function budgetSeats(ctx, state) {
  const m = (ctx.memory.seatBudget ??= { logged: new Map(), written: new Map(), warned: '', cpuFull: false, over: '', unread: false });
  const all = (state.allProjects ?? state.projects).filter(p => p.engine);
  const h = state.harness ?? {}, percent = budgetOf(h);
  const mem = ctx.hostMemory ? await memoryReading(ctx) : null;
  const cpu = await cpuReading(ctx);
  const resolved = resolveShares(all.map(p => ({ id: p.id, share: p.json?.share })));
  const warn = JSON.stringify([resolved.scaled, resolved.invalid]);
  if (warn !== m.warned) {
    m.warned = warn;
    for (const i of resolved.invalid) ctx.log(PHASE, `${i.id}: share ${JSON.stringify(i.share)} is not a percentage from 0 to 100; ignored, as if unset`);
    if (resolved.scaled) ctx.log(PHASE, `the projects' shares add to ${round(resolved.scaled.sum)}%, over 100: scaled down to 100 (${all.filter(p => resolved.source.get(p.id) === 'set').map(p => `${p.id} ${round(resolved.shares.get(p.id))}%`).join(', ')})`);
  }
  const budget = {
    memory: mem ? mem.totalBytes * percent.memory / 100 : null,
    cpu: cpu ? cpu.capacity * percent.cpu / 100 : null,
  };
  const macCpu = cpu ? cpu.percent : 0;
  if (budget.cpu != null) {
    const band = (h['cpu-hysteresis-percent'] ?? DEFAULT_CPU_BAND) * cpu.capacity / 100;
    if (macCpu >= budget.cpu) m.cpuFull = true;
    else if (m.cpuFull && macCpu <= budget.cpu - band) m.cpuFull = false;
  } else m.cpuFull = false;
  const mac = { memory: mem ? mem.totalBytes - freeBytes(mem) : 0, cpu: macCpu, cpuFull: m.cpuFull };
  const own = new Set(state.projects.map(p => p.id));
  const inputs = all.map(p => {
    const demand = planFor(state, p, {}, Infinity);
    const onMac = demand.onMac, held = onMac.filter(s => s.seated), freeRemote = Math.max(0, demand.seats.remote - demand.seats.used.remote);
    const vmOf = s => p.tickets.find(t => t.key === s.key)?.variations?.find(v => v.name === s.variation)?.vm?.name;
    // ASS-535: a project on sandboxes — one ticket a sandbox's measured use; a holder starting while its sandbox is not measured running.
    const sandboxes = macSandboxes(p), live = p.substrate?.[MAC];
    const running = new Set(sandboxUse(live).filter(u => u.state === 'running' && u.memory > 0).map(u => u.actor));
    const starting = sandboxes ? held.filter(s => !running.has(sandboxActor(s.key, s.variation))).length : mem?.vms ? held.filter(s => !mem.vms.has(vmOf(s))).length : 0;
    // ASS-570: one ticket's expected use from working sandboxes alone, steadied (ticket-estimate.js); this control's own
    // projects sample and keep it, another control's are read from what that one kept.
    const need = sandboxes ? estimateFor(ctx, state, p, clusterEntry(p, MAC), { own: own.has(p.id), isBusy: (key, variation) => variationBusy(ctx, state, p.id, key, variation) }) : null;
    const disk = clusterEntry(p, MAC) ? snapshotDisk(clusterEntry(p, MAC), live, h) : null;   // ASS-537 AC3
    // ASS-530: its VMs' measured use (the memory reading's footprints, the CPU window's averages), for the footer.
    const names = (mem?.vms || cpu?.vms) ? projectVms(ctx, p) : new Set();
    const sum = map => (map ? [...map].filter(([name]) => names.has(name)).reduce((a, [, v]) => a + v, 0) : null);
    return {
      id: p.id, share: resolved.shares.get(p.id), canUse: MODES_WITH_VMS.has(p.devEnvironments?.mode ?? 'vm'),
      measured: { memory: sum(mem?.vms), cpu: sum(cpu?.vms) },
      want: onMac.length + Math.max(0, demand.queued - freeRemote), held: held.length, starting,
      per: { memory: mem ? (need ? need.memory : memoryNeed(ctx, state, p, mem).bytes) : 0, cpu: cpu ? (need ? need.cpu : cpuNeed(ctx, state, p, cpu)) : 0 },
      need,   // ASS-570: a sandbox ticket's estimate, with where it came from (null for a project on VMs)
      reserve: reserveOf(p, all),   // ASS-533 AC5
      disk, diskFull: Boolean(sandboxes && disk?.full),   // ASS-537 AC3: its snapshots' disk
    };
  });
  // Neither the Mac's memory nor its CPU read while a reader is there (a failing read): conservative — no new seat.
  const unread = budget.memory == null && budget.cpu == null && Boolean(ctx.hostMemory || ctx.hostCpu);
  if (unread !== m.unread) {
    if (unread) ctx.log(PHASE, "can't read the Mac's memory or CPU — no new seats until it can; seats held keep running");
    else if (m.unread) ctx.log(PHASE, "the Mac's memory or CPU reads again: seats are given by the budget again");
    m.unread = unread;
  }
  const granted = grantSeats({ budget, mac, projects: inputs, unread });
  const over = granted.values().next().value?.over ?? [];
  const overNow = over.filter(d => d !== 'unread').join(',');
  if (overNow !== m.over) {
    if (overNow) ctx.log(PHASE, `the Mac is over its ${over.map(d => (d === 'memory' ? `memory limit (${gib(mac.memory)} of ${gib(budget.memory)} GiB used)` : `CPU limit (${round(mac.cpu)}% of ${round(budget.cpu)}% used, averaged)`)).join(' and ')}: no new seats until it is back under; nothing running is stopped`);
    else if (m.over) ctx.log(PHASE, 'the Mac is back under its memory and CPU limits: seats are given again');
    m.over = overNow;
  }
  for (const project of state.projects) {
    const r = granted.get(project.id), input = inputs.find(i => i.id === project.id);
    if (!r) continue;
    const body = {
      seats: Number.isFinite(r.seats) ? r.seats : null,
      share: round(r.share), 'share-source': resolved.source.get(project.id),
      allotment: { seats: Number.isFinite(r.allotSeats) ? r.allotSeats : null, 'memory-bytes': r.allotment.memory == null ? null : Math.round(r.allotment.memory), 'cpu-percent': r.allotment.cpu == null ? null : round(r.allotment.cpu) },
      // ASS-530: its VMs' measured memory and CPU too (null where not read), and what it lends and borrows.
      used: { seats: r.held, starting: input.starting, 'memory-bytes': input.measured.memory == null ? null : Math.round(input.measured.memory), 'cpu-percent': input.measured.cpu == null ? null : round(input.measured.cpu),
        // ASS-533 AC5: its part of the Mac's Substrate cluster, counted against its allotment before its seats.
        ...(input.reserve ? { substrate: { 'memory-bytes': Math.round(input.reserve.memory), 'cpu-percent': round(input.reserve.cpu), running: !input.reserve.pending,
          // ASS-537 AC3: of that, its warm workers' memory requests; and its snapshots' disk on the cluster's.
          'pool-memory-bytes': Math.round(input.reserve.pool ?? 0),
          ...(input.disk ? { 'snapshot-bytes': Math.round(input.disk.bytes), 'disk-free-bytes': input.disk.free == null ? null : Math.round(input.disk.free), 'disk-full': input.diskFull } : {}) } } : {}) },
      lends: { 'memory-bytes': r.lends?.memory == null ? null : Math.round(r.lends.memory), 'cpu-percent': r.lends?.cpu == null ? null : round(r.lends.cpu) },
      borrows: { 'memory-bytes': r.borrows?.memory == null ? null : Math.round(r.borrows.memory), 'cpu-percent': r.borrows?.cpu == null ? null : round(r.borrows.cpu) },
      want: r.want,
      'per-ticket': { 'memory-bytes': budget.memory == null ? null : Math.round(input.per.memory), 'cpu-percent': budget.cpu == null ? null : round(input.per.cpu),
        // ASS-570: where it came from — a sandbox ticket's 'working-samples' (how many) or 'defaults' (the floor), its
        // floor and the target it moves towards; a VM ticket's 'vm' (its VMs' footprints and CPU, or the VM floor).
        ...(input.need ? { source: input.need.source, samples: input.need.samples,
          floor: { 'memory-bytes': Math.round(input.need.floor.memory), 'cpu-percent': round(input.need.floor.cpu) },
          target: { 'memory-bytes': Math.round(input.need.target.memory), 'cpu-percent': round(input.need.target.cpu) } } : { source: 'vm' }) },
      mac: { 'memory-used-bytes': mem ? Math.round(mac.memory) : null, 'memory-budget-bytes': budget.memory == null ? null : Math.round(budget.memory), 'cpu-percent': cpu ? round(mac.cpu) : null, 'cpu-budget-percent': budget.cpu == null ? null : round(budget.cpu), over,
        // ASS-557: its whole memory and CPU (cores × 100%), for the compute network screen's Mac row.
        'memory-total-bytes': mem ? Math.round(mem.totalBytes) : null, 'cpu-capacity-percent': cpu ? cpu.capacity : null },
    };
    project.seatBudget = body;
    logDisk(ctx, m, project.id, input);
    logChange(ctx, m, project.id, body);
    record(ctx, m, project.id, body);
  }
}

const round = n => Math.round(n * 10) / 10;

// logDisk(ctx, m, id, input) — ASS-537 AC3: a project's sandboxes held for their snapshots' disk, logged once when it
// starts and once when it ends.
function logDisk(ctx, m, id, input) {
  const full = input.diskFull, was = (m.diskFull ??= new Map()).get(id) ?? false;
  if (full === was) return;
  m.diskFull.set(id, full);
  const d = input.disk;
  if (full) ctx.log(PHASE, `${id}: its Substrate cluster's disk has ${gib(d.free)} GiB free, and one more sandbox's snapshot (${gib(d.per)} GiB) would take it below the ${round(d.hold / 1e9)} GB hold (its snapshots take ${gib(d.bytes)} GiB): no new seat for its sandboxes until there is room; those held keep running`);
  else ctx.log(PHASE, `${id}: its Substrate cluster's disk has room for its sandboxes' snapshots again: seats are given again`);
}

// logChange(ctx, m, id, body) — AC6: a project's share, allotment and seats used, logged once each time one changes.
function logChange(ctx, m, id, body) {
  // Not limited (the Mac not read): only its share is worth saying again; its seats move with its tickets and limit nothing.
  const key = JSON.stringify(body.allotment.seats == null ? [body.share, body['share-source']] : [body.share, body['share-source'], body.allotment.seats, body.used.seats, body.seats, body.mac.over, body['per-ticket'].source, body['per-ticket'].samples ?? null]);
  if (m.logged.get(id) === key) return;
  m.logged.set(id, key);
  const share = `share ${body.share}%${body['share-source'] === 'split' ? ' (unset: an equal split of what the set shares leave)' : ''}`;
  if (body.allotment.seats == null) { ctx.log(PHASE, `${id}: ${share}; the Mac's memory and CPU not read, so its seats are not limited`); return; }
  if (body.mac.over.includes('unread')) { ctx.log(PHASE, `${id}: ${share}; the Mac not read, so no new seats; keeps the ${body.used.seats} it holds`); return; }
  const figures = [body.allotment['memory-bytes'] != null && `${gib(body.allotment['memory-bytes'])} GiB`, body.allotment['cpu-percent'] != null && `${body.allotment['cpu-percent']}% CPU`].filter(Boolean).join(', ');
  ctx.log(PHASE, `${id}: ${share}, allotment ${body.allotment.seats} seat${body.allotment.seats === 1 ? '' : 's'}${figures ? ` (${figures})` : ''}, uses ${body.used.seats}, wants ${body.want}; may hold ${body.seats} now; ${perTicket(body['per-ticket'])}`);
}

// perTicket(per) — ASS-570: one ticket's expected use and where it came from, for the log line.
function perTicket(per) {
  const figures = [per['memory-bytes'] != null && `${gib(per['memory-bytes'])} GiB`, per['cpu-percent'] != null && `${per['cpu-percent']}% CPU`].filter(Boolean).join(', ');
  const from = per.source === 'working-samples' ? `from ${per.samples} working sample${per.samples === 1 ? '' : 's'}`
    : per.source === 'defaults' ? `defaults${per.samples ? ` (its ${per.samples} working sample${per.samples === 1 ? '' : 's'} under them)` : ''}`
    : "a VM's";
  return `per ticket ${figures} (${from})`;
}


// record(ctx, m, id, body) — its seat-budget.json, written whole (a temp file renamed over it) when its seats, share,
// allotment, use or demand change, and otherwise at most every REWRITE_EVERY for the Mac's figures (which move with
// every reading), so the file does not churn tick by tick.
const REWRITE_EVERY = 60e3;
function record(ctx, m, id, body) {
  const file = seatBudgetFile(ctx.paths.projects, id), now = ctx.now().getTime();
  const key = JSON.stringify([body.seats, body.share, body['share-source'], body.allotment.seats, body.used.seats, body.used.starting, body.want, body.mac.over, body.used.substrate?.['disk-full'] ?? null, body['per-ticket'].source, body['per-ticket'].samples ?? null]);   // ASS-530: not the measured figures (rewritten at most every REWRITE_EVERY)
  const was = m.written.get(id);
  if (was && was.key === key && now - was.at < REWRITE_EVERY && existsSync(file)) return;
  try {
    writeFileSync(`${file}.tmp`, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    m.written.set(id, { key, at: now });
  } catch (error) { ctx.log('error', `${PHASE}: ${file}: ${error.message}`); }
}
