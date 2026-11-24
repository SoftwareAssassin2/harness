// ASS-529: a workstation or cloud VM takes several of its project's tickets
// at once — as many as its own memory and CPU allow — instead of exactly one
// seat (ASS-469 AC9). Operator decision, 2026-11-22, one of the seat
// redesign's main goals: a big remote machine is used fully. Machines are
// never shared between projects (ASS-528), and remote machines are outside
// the Mac's seat budget (seat-budget.js): each has limits of its own,
// measured on it.
//
// - The reading: control's workstation job (workstations.js measure) runs
//   workstation:usage over the machine's one SSH connection once a minute
//   while the machine is connected and needed (USAGE_EVERY, harness.json's
//   remote-usage-interval-seconds), never every tick: /proc/meminfo
//   (MemTotal, MemAvailable) and two /proc/stat samples a second apart (its
//   busy share of every core), recorded on its live data as `usage` { at,
//   memory: { total-bytes, available-bytes }, cpu: { cores, samples: [{ at,
//   percent }] } (the last few, percent of one core), error: null | { at,
//   message } }. Its CPU is the average of the samples within CPU_WINDOW (5
//   minutes), so one busy second does not shut the machine.
// - The limits: the machine entry's max-memory-percent and max-cpu-percent
//   in project.json's dev-environments (dev-environments.js), else
//   harness.json's (90 and 90, seat-budget.js DEFAULT_BUDGET) — of its
//   memory and of its cores × 100%.
// - One ticket's expected use: its tickets' measured use shared out (the
//   machine's used memory, or its averaged CPU, over the tickets it holds),
//   at least the floor — harness.json's memory-need-floor-gib (4, as a Lima
//   VM's) and cpu-need-floor-percent (100: one core); the floor with none on
//   it.
// - Admission (machineSeats, pure): the machine may hold the tickets it holds
//   (seats.json's records on it: nothing running is cut off) and one more
//   while its measured memory and CPU, plus the expected use of each of its
//   seats whose step has not claimed it yet (`pending`: seated but not
//   running there, so not in the reading), plus one more ticket, stay within
//   both limits (at the limit admits). One more at a time: the next is
//   admitted once that one shows in a reading, or still fits. A machine with
//   none of the project's tickets on it always takes one — it is the
//   project's own, and so it was before ASS-529.
// - ASS-533 AC5: the project's Substrate cluster on the machine (its kind cluster there, substrate-config.js
//   remoteLoad: its fixed memory and CPU plus its active sandboxes') counts against the machine's limits: while it is
//   up its use is in the reading already, and is taken out of the part shared over the tickets (one ticket's expected
//   use is not the cluster's); while it is not up yet it is added to the measured use, as a seat whose step has not
//   claimed the machine yet is.
// - ASS-535 AC3: on a machine whose tickets run in Substrate sandboxes (the project lists its kind's substrate target —
//   workstation-substrate, cloud-vm-substrate — before the plain one, and has a cluster there: remoteSandboxes), a
//   ticket's use is its sandbox's, inside the cluster: the cluster's fixed part alone is taken out of the use shared over
//   the tickets (its sandboxes' measured use, rootfs writes included, is theirs), the floor is a sandbox's expected use
//   (substrate-config.js sandboxNeed), and a seat holder whose sandbox runs is in the reading (it never claims the
//   machine's folder). A hibernated sandbox holds no seat (ASS-527).
// - ASS-537 AC3: a hibernated sandbox uses no memory or CPU (neither in the reading nor a seat); what it keeps counts
//   where it lives: the project's WorkerPool's warm workers' memory requests are part of the cluster's reserve
//   (substrate-config.js warmPool, in remoteLoad), and its snapshots' disk against the cluster's (snapshotDisk): a
//   machine of sandboxes whose cluster's disk would fall below disk-free-hold-gb with one more ticket's snapshot takes no
//   new ticket (`disk` in its `over`; those it holds keep running); remote-seats.json's substrate says both.
// - ASS-553 AC2: a ticket's worktree on the machine (workstation-worktree, cloud-vm-worktree: a folder of its own there,
//   workstation:claim --worktree) holds one of its seats like any ticket and claims the machine as a holder, so it is
//   in the reading and counted against the same limits, beside the machine's Substrate sandboxes and plain slots: a
//   machine running sandboxed stacks still takes worktree tickets while its memory and CPU allow.
// - ASS-557 AC1: the disk its tickets' work lives on (~/harness: a Cloud Workstation's /home, a cloud VM's root or
//   data disk) is read in the same workstation:usage call, as usage.disk { folder, total-bytes, used-bytes,
//   available-bytes }. Below its hold — the machine entry's disk-free-hold-gb, else harness.json's (15 GB, as the
//   Mac's disk hold, disk.js) — it takes no new ticket, not even a first (`work-disk` in its `over`); those it holds
//   keep running. As the Mac's, the hold lasts until the disk is back above the warn level (disk-free-warn-gb, 50),
//   but never asks for more than half of what the hold leaves of the disk (min(warn, (hold + total) / 2)), so a disk
//   smaller than the warn level can still come out of it. Judged on a fresh reading; a machine not measured since
//   keeps a hold its last reading set for DISK_RECHECK (30 minutes) — the reading is not gone, the disk not freed —
//   and after it the one-seat rule again, so a ticket starts it and it is measured. A disk df cannot read holds
//   nothing. Its start and end are logged once each; remote-seats.json's `disk` says the figures, the levels and
//   whether it is held, the compute network screen (n) draws them.
// - No reading: a machine not measured (stopped, not connected, its reading
//   older than READING_STALE) keeps the one-seat rule — at least one, its
//   held ones — so a ticket taking it has it started at once (seat-kinds.js);
//   one whose last reading failed while connected takes no new ticket (those
//   it holds keep running), the same conservative rule as the Mac's
//   (ASS-528), logged once per outage.
//
// The phase (budgetRemote, each tick before the Mac's budget, which counts
// free remote seats as taking demand off the Mac) works this out for each of
// its projects' remote machines, sets it on the project as remoteBudget —
// seat-kinds.js seatCapacity's seats per machine — and writes it to
// data/projects/<p>/remote-seats.json (remoteSeatsFile; atomically, when it
// changes), which state.js and the dashboard load the same way. Each change
// of a machine's seats or reading state is logged once ("remote …").
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { remoteSeatsFile } from './seat-budget-file.js';
import { DEFAULT_BUDGET, DEFAULT_CPU_FLOOR } from './seat-budget.js';
import { DEFAULT_FLOOR_GIB, gib } from './host-memory.js';
import { holdersOf } from './workstation-connection.js';
import { MODES_WITH_WORKSTATIONS, isRemoteSeat } from './seat-kinds.js';
import { remoteLoad, clusterEntry, sandboxNeed, sandboxUse, snapshotDisk } from './substrate-config.js';
import { sandboxActor } from './machine-substrate.js';

const PHASE = 'remote';
const GIB = 1024 ** 3;
export const USAGE_EVERY = 60e3;
export const CPU_WINDOW = 5 * 60e3;
export const READING_STALE = 5 * 60e3;
export const DISK_RECHECK = 30 * 60e3;   // ASS-557
export const DEFAULT_DISK = Object.freeze({ 'disk-free-hold-gb': 15, 'disk-free-warn-gb': 50 });   // check-disk-space.sh's
export { REMOTE_SEATS_FILE, remoteSeatsFile } from './seat-budget-file.js';

const time = at => (at ? Date.parse(at) : NaN);

// readingOf(entry, now) — the machine's usage as admission reads it: { state: 'measured', memory { total, used },
// cpu { capacity, used (averaged over CPU_WINDOW) } }; { state: 'unread', why } when its latest reading failed while
// it is connected; { state: 'unmeasured', why } with none fresh (never measured, older than READING_STALE, or the
// machine not connected).
export function readingOf(entry, now) {
  const u = entry?.usage;
  if (entry?.connected !== true) return { state: 'unmeasured', why: 'not connected (stopped, or not started yet)' };
  const errorAt = time(u?.error?.at), at = time(u?.at);
  if (u?.error && now - errorAt <= READING_STALE && !(at > errorAt)) return { state: 'unread', why: u.error.message || 'its reading failed' };
  if (!u || !Number.isFinite(at) || now - at > READING_STALE) return { state: 'unmeasured', why: 'no fresh reading yet' };
  const total = u.memory?.['total-bytes'], available = u.memory?.['available-bytes'], cores = u.cpu?.cores;
  const samples = (u.cpu?.samples ?? []).filter(s => Number.isFinite(s?.percent) && now - time(s.at) <= CPU_WINDOW);
  if (!(total > 0) || !(available >= 0) || !(cores > 0)) return { state: 'unread', why: 'its reading named no memory or cores' };
  const cpu = samples.length ? samples.reduce((a, s) => a + s.percent, 0) / samples.length : null;
  return { state: 'measured', memory: { total, used: Math.max(0, total - available) }, cpu: { capacity: cores * 100, used: cpu } };
}

// limitsOf(remote, harness) — the machine's { memory, cpu } percentages: its own entry's, else harness.json's, else 90.
export const limitsOf = (remote, harness) => ({
  memory: remote?.['max-memory-percent'] ?? harness?.['max-memory-percent'] ?? DEFAULT_BUDGET['max-memory-percent'],
  cpu: remote?.['max-cpu-percent'] ?? harness?.['max-cpu-percent'] ?? DEFAULT_BUDGET['max-cpu-percent'],
});

// diskLevelsOf(remote, harness) — ASS-557: the machine's { hold, warn } in bytes: its own entry's GB, else
// harness.json's, else 15 and 50 (GB are 10^9 bytes, as the Mac's).
export const diskLevelsOf = (remote, harness) => {
  const gb = f => remote?.[f] ?? harness?.[f] ?? DEFAULT_DISK[f];
  return { hold: gb('disk-free-hold-gb') * 1e9, warn: Math.max(gb('disk-free-hold-gb'), gb('disk-free-warn-gb')) * 1e9 };
};

// diskOf(entry) — ASS-557: the machine's last disk reading, whatever its age: { folder, total, used, free, at } in
// bytes, or null with none (never read, or df could not read it).
export function diskOf(entry) {
  const d = entry?.usage?.disk;
  if (!d || !(d['total-bytes'] > 0) || !(d['available-bytes'] >= 0)) return null;
  return { folder: d.folder ?? null, total: d['total-bytes'], used: d['used-bytes'] ?? Math.max(0, d['total-bytes'] - d['available-bytes']), free: d['available-bytes'], at: entry.usage.at ?? null };
}

// diskHold({ disk, levels, was, measured, now }) — ASS-557 AC1, pure: whether the machine's disk holds new work now
// (see the module comment), and the free space that releases it.
export function diskHold({ disk, levels, was = false, measured = true, now = Date.now() }) {
  if (!disk) return { held: false, release: levels.warn };
  const release = Math.max(levels.hold, Math.min(levels.warn, (levels.hold + disk.total) / 2));
  if (!measured) return { held: was && now - time(disk.at) <= DISK_RECHECK, release };
  return { held: disk.free < levels.hold || (was && disk.free < release), release };
}

// machineSeats({ entry, limits, held, pending, harness, now }) — AC1: the seats the machine may hold now, pure (see
// the module comment). `limits` limitsOf's; `held` how many of its seats are held (seats.json); `pending` how many of
// those have not claimed it yet. Returns { seats, state (readingOf's), why, admit, used { memory, cpu }, budget {
// memory, cpu }, per { memory, cpu } }.
// ASS-533 AC5: `reserved` { memory, cpu, running } — the machine's Substrate cluster (remoteLoad), or null.
// ASS-537 AC3: `diskFull` — its sandboxes' snapshots have no room for one more ticket's on the cluster's disk.
// ASS-557 AC1: `diskHeld` — the disk its work lives on is below its hold (diskHold): no new ticket, not even a first.
export function machineSeats({ entry, limits, held = 0, pending = 0, harness = {}, now = Date.now(), reserved = null, floor: own = null, diskFull = false, diskHeld = false }) {
  const r = readingOf(entry, now);
  const low = 'its disk is below its hold';
  if (r.state === 'unread') return { seats: held, state: r.state, why: r.why, admit: false };
  if (r.state === 'unmeasured' && diskHeld) return { seats: held, state: r.state, why: `${r.why}; ${low} at its last reading`, admit: false, over: ['work-disk'] };
  if (r.state === 'unmeasured') return { seats: Math.max(held, 1), state: r.state, why: r.why, admit: held === 0 };
  // ASS-535: `own` { memory, cpu } — a sandbox's expected use, the floor on a machine of sandboxes.
  const floor = own ?? { memory: (harness['memory-need-floor-gib'] ?? DEFAULT_FLOOR_GIB) * GIB, cpu: harness['cpu-need-floor-percent'] ?? DEFAULT_CPU_FLOOR };
  const running = Math.max(0, held - pending);
  const cluster = { memory: Math.max(0, reserved?.memory ?? 0), cpu: Math.max(0, reserved?.cpu ?? 0) };
  const inReading = reserved?.running === true;   // up: its use is in the reading already
  const per = {
    memory: Math.max(floor.memory, running ? Math.max(0, r.memory.used - (inReading ? cluster.memory : 0)) / running : 0),
    cpu: Math.max(floor.cpu, running && r.cpu.used != null ? Math.max(0, r.cpu.used - (inReading ? cluster.cpu : 0)) / running : 0),
  };
  const budget = { memory: r.memory.total * limits.memory / 100, cpu: r.cpu.capacity * limits.cpu / 100 };
  const used = { memory: r.memory.used + (inReading ? 0 : cluster.memory), cpu: (r.cpu.used ?? 0) + (inReading ? 0 : cluster.cpu) };
  const fits = d => used[d] + (pending + 1) * per[d] <= budget[d] + 1e-6;
  const over = ['memory', 'cpu'].filter(d => !fits(d));
  // ASS-537: no room for one more snapshot takes no ticket, even a first (its sandbox could not hibernate).
  const admit = !diskFull && !diskHeld && (held === 0 || !over.length);
  const why = [over.length && `one more ticket would pass its ${over.join(' and ')} limit`, diskFull && "its Substrate cluster's disk has no room for one more sandbox's snapshot", diskHeld && low].filter(Boolean).join('; ');
  return { seats: held + (admit ? 1 : 0), state: r.state, why: why || 'one more ticket fits', admit, used, budget, per, over: [...over, ...(diskFull ? ['disk'] : []), ...(diskHeld ? ['work-disk'] : [])] };
}

// remoteSandboxes(project, w) — ASS-535: the project's tickets run in Substrate sandboxes on remote machine `w` (its
// kind's substrate target listed before the plain one, and a cluster on it).
export function remoteSandboxes(project, w) {
  const kind = w?.kind === 'cloud-vm' ? 'cloud-vm' : 'workstation', targets = project?.runTargets?.targets ?? [];
  // ASS-553: its worktree target is a plain one here (the machine's own toolchain, no sandbox).
  const sub = targets.indexOf(`${kind}-substrate`), plain = [kind, `${kind}-worktree`].map(t => targets.indexOf(t)).filter(i => i >= 0);
  return sub >= 0 && (!plain.length || sub < Math.min(...plain)) && Boolean(clusterEntry(project, w.id));
}

// budgetRemote(ctx, state) — the tick's phase (see the module comment).
export async function budgetRemote(ctx, state) {
  const m = (ctx.memory.remoteSeats ??= { logged: new Map(), written: new Map() });
  m.diskHeld ??= new Map();   // ASS-557: each machine's disk hold, by "<project> <id>"
  const now = ctx.now().getTime();
  for (const project of state.projects) {
    const settings = project.devEnvironments;
    if (!project.engine || !MODES_WITH_WORKSTATIONS.has(settings?.mode) || !settings.workstations?.length) {
      if (project.remoteBudget !== undefined) project.remoteBudget = null;
      continue;
    }
    const records = project.seats ?? [], body = {};
    for (const w of settings.workstations) {
      const entry = project.workstations?.[w.id], on = records.filter(s => isRemoteSeat(s) && s.workstation === w.id);
      const claimed = new Set(holdersOf(entry).map(h => `${String(h.ticket).toUpperCase()} ${h.variation}`));
      // ASS-535: a holder whose sandbox runs there is in the reading too.
      const live = project.substrate?.[w.id], sandboxed = remoteSandboxes(project, w);
      for (const u of sandboxUse(live)) if (u.state === 'running') for (const r2 of on) if (sandboxActor(r2.key, r2.variation) === u.actor) claimed.add(`${String(r2.key).toUpperCase()} ${r2.variation}`);
      const pending = on.filter(s => !claimed.has(`${String(s.key).toUpperCase()} ${s.variation}`)).length;
      const limits = limitsOf(w, state.harness);
      const reserved = remoteLoad(project, w.id, { sandboxes: !sandboxed });   // ASS-533 AC5; ASS-535: its sandboxes are its tickets' use
      const disk = clusterEntry(project, w.id) ? snapshotDisk(clusterEntry(project, w.id), live, state.harness ?? {}) : null;   // ASS-537 AC3
      // ASS-557 AC1: the disk its work lives on, against its hold.
      const work = diskOf(entry), levels = diskLevelsOf(w, state.harness), k = `${project.id} ${w.id}`;
      const measured = readingOf(entry, now).state === 'measured';
      // Its last hold: this control's, else remote-seats.json's (state.js), so a restart neither forgets nor re-logs it.
      const was = m.diskHeld.get(k) ?? project.remoteBudget?.[w.id]?.disk?.held === true;
      const hold = diskHold({ disk: work, levels, was, measured, now });
      logDiskHold(ctx, m, k, work, levels, hold, on.length, measured, was);
      const r = machineSeats({ entry, limits, held: on.length, pending, harness: state.harness ?? {}, now, reserved, floor: sandboxed ? sandboxNeed(clusterEntry(project, w.id), live) : null, diskFull: Boolean(sandboxed && disk?.full), diskHeld: hold.held });
      body[w.id] = {
        seats: r.seats, held: on.length, pending, state: r.state, why: r.why, admit: r.admit, limits,
        ...(r.state === 'measured' ? {
          'memory-used-bytes': Math.round(r.used.memory), 'memory-budget-bytes': Math.round(r.budget.memory),
          'cpu-percent': round(r.used.cpu), 'cpu-budget-percent': round(r.budget.cpu),
          'per-ticket': { 'memory-bytes': Math.round(r.per.memory), 'cpu-percent': round(r.per.cpu) },
        } : {}),
        ...(reserved ? { substrate: { 'memory-bytes': Math.round(reserved.memory), 'cpu-percent': round(reserved.cpu), running: reserved.running,
          'pool-memory-bytes': Math.round(reserved.pool ?? 0),   // ASS-537 AC3
          ...(disk ? { 'snapshot-bytes': Math.round(disk.bytes), 'disk-free-bytes': disk.free == null ? null : Math.round(disk.free), 'disk-full': Boolean(sandboxed && disk.full) } : {}) } } : {}),
        // ASS-557 AC1: the disk its work lives on (its last reading, whatever its age: `at` says when), its levels, its hold.
        disk: { ...(work ? { folder: work.folder, 'total-bytes': work.total, 'used-bytes': work.used, 'free-bytes': work.free, at: work.at } : {}),
          'hold-bytes': levels.hold, 'warn-bytes': levels.warn, 'release-bytes': Math.round(hold.release), held: hold.held },
      };
      logChange(ctx, m, project.id, w, body[w.id]);
    }
    project.remoteBudget = body;
    record(ctx, m, project.id, body, now);
  }
}

const round = n => Math.round(n * 10) / 10;

// logChange(ctx, m, project, w, b) — a machine's seats, reading state or whether it takes one more, logged once each
// time one changes; a failed reading so once per outage.
function logChange(ctx, m, project, w, b) {
  const k = `${project} ${w.id}`, key = JSON.stringify([b.seats, b.state, b.admit]);
  if (m.logged.get(k) === key) return;
  const was = m.logged.get(k);
  m.logged.set(k, key);
  const what = `${project} ${w.id}`;
  if (b.state === 'unread') { ctx.log(PHASE, `${what}: can't read its memory or CPU (${b.why}) — no new tickets on it until it can; the ${b.held} it holds keep running`); return; }
  if (b.state === 'unmeasured') { if (was) ctx.log(PHASE, `${what}: not measured (${b.why}): ${b.seats} seat${b.seats === 1 ? '' : 's'} (those it holds, at least one) until it is`); return; }
  ctx.log(PHASE, `${what}: ${b.seats} seat${b.seats === 1 ? '' : 's'} — holds ${b.held}; memory ${gib(b['memory-used-bytes'])} of ${gib(b['memory-budget-bytes'])} GiB, CPU ${b['cpu-percent']}% of ${b['cpu-budget-percent']}% (its limits ${b.limits.memory}% and ${b.limits.cpu}%); one ticket ${gib(b['per-ticket']['memory-bytes'])} GiB, ${b['per-ticket']['cpu-percent']}% CPU: ${b.why}`);
}

// logDiskHold(ctx, m, k, disk, levels, hold, held, measured, was) — ASS-557 AC1: a machine's disk hold, logged once when it starts and
// once when it ends (as disk.js logs the Mac's).
function logDiskHold(ctx, m, k, disk, levels, hold, held, measured, was) {
  m.diskHeld.set(k, hold.held);
  if (hold.held === was) return;
  const gb = b => String(Math.round(b / 1e8) / 10);
  if (hold.held) ctx.log('hold', `${k}: its disk (${disk.folder ?? 'its work folder'}) has ${gib(disk.free)} GiB free of ${gib(disk.total)}, below its ${gb(levels.hold)} GB hold — no new tickets on it until ${gb(hold.release)} GB is free; the ${held} it holds keep running`);
  else if (!measured) ctx.log('hold', `${k}: not measured for ${DISK_RECHECK / 60e3} minutes since its disk was below its hold: it may take a ticket again, which starts it and has its disk read again`);
  else ctx.log('hold', `${k}: ${disk ? `its disk has ${gib(disk.free)} GiB free again, back above ${gb(hold.release)} GB` : 'its disk is no longer read'}: it takes tickets again`);
}

// record(ctx, m, id, body, now) — its remote-seats.json, written whole when the seats or states change, and otherwise
// at most once a minute for the figures.
function record(ctx, m, id, body, now) {
  const file = remoteSeatsFile(ctx.paths.projects, id);
  const key = JSON.stringify(Object.entries(body).map(([w, b]) => [w, b.seats, b.held, b.state, b.disk?.held]));
  const was = m.written.get(id);
  if (was && was.key === key && now - was.at < 60e3 && existsSync(file)) return;
  try {
    if (!Object.keys(body).length) { rmSync(file, { force: true }); return; }
    writeFileSync(`${file}.tmp`, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    m.written.set(id, { key, at: now });
  } catch (error) { ctx.log('error', `${PHASE}: ${file}: ${error.message}`); }
}
