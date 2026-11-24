// ASS-570: one ticket's expected use of the Mac, for a project whose tickets run there in Substrate sandboxes (ASS-535
// AC3, seat-budget.js macSandboxes) — the `per` the seat budget sizes the project's allotment by (grantSeats).
//
// Before, it was the average of the project's sandboxes measured `running` at the cluster's last check
// (substrate-config.js sandboxNeed). A sandbox is `running` whenever it is not hibernated, working or not, so one idle
// sandbox (0.36 GiB, a few % CPU, seen live 2026-11-23) made a ticket look ten times cheaper than a working one, and the
// allotment swung from 3 seats to 30 and back as that sandbox was hibernated and resumed, with no change in load.
//
// Now:
// - A sample is a working sandbox's: a reading of substrate.json's usage.sandbox-use (substrate:health, every
//   substrate-check-seconds) counts only when the sandbox's state is `running`, it has memory, and its variation was
//   working — an agent turn or an in-machine script of it running (sandboxes.js variationBusy) — without a break from
//   one check interval before the reading (its CPU figure is the average since the check before) until the reading.
//   Idle, starting (resuming), hibernated and hibernating (suspending) sandboxes are never sampled. Control keeps each
//   variation's last stretch of work (ctx.memory.ticketEstimate.busy), so a reading taken just before a turn ended still
//   counts when control sees it afterwards. Each reading is taken once (the cluster's checked-at, recorded).
// - The estimate's target is, per dimension, the larger of the floor — the Mac cluster entry's sandbox-memory-gib /
//   sandbox-cpu-percent (1.5 GiB and 100% by default: substrate-config.js DEFAULTS) — and the PERCENTILE of the last
//   SAMPLES_KEPT working samples: never below a realistic working sandbox. With no samples it is the floor: the
//   defaults, as before.
// - It moves towards its target by at most STEP (a factor) a tick, up or down, so one tick never jumps it; never below
//   the floor (a floor raised by hand applies at once).
// - Kept across ticks and restarts in data/projects/<p>/ticket-estimate.json (ESTIMATE_FILE), written whole when it
//   changes, by the project's own control: { samples [{ at, actor, memory-bytes, cpu-percent }], checked-at (the last
//   reading taken), estimate { memory-bytes, cpu-percent }, at }. Another project's control reads it, so all controls
//   size every project alike (seat-budget.js works out every project's allotment).
// - Where it came from (`source`, said in the budget log line and seat-budget.json's per-ticket): 'working-samples'
//   (with how many) or 'defaults' (no samples, or every sample under the floor: the floor itself).
//
// CPU (the ticket's question, 2026-11-23): no working sandbox had been measured on the Mac — substrate.json keeps only
// the last check, and the only figures in the notes are ASS-532's spike (agent turns waiting on the model: ~0 CPU; test
// runs: as much as the worker's 4-CPU limit allows) and ASS-542's whole app stacks (memory only: 9.0 and 9.3 GiB). So
// the 100% default stays; the samples this file now keeps are the evidence to change it with (change-notes, ASS-570).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxUse, MAC } from './substrate-config.js';
import { CHECK_EVERY } from './substrate.js';

export const ESTIMATE_FILE = 'ticket-estimate.json';
export const SAMPLES_KEPT = 50;
export const PERCENTILE = 0.8;
export const STEP = 1.1;
const GIB = 1024 ** 3;
const KEEP_BUSY_MS = 30 * 60e3;   // a finished stretch of work is forgotten after this (its readings long taken)

export const estimateFile = (projectsDir, id) => join(projectsDir, id, ESTIMATE_FILE);

// floorOf(entry) — the project's Mac cluster entry's sandbox figures, { memory (bytes), cpu (percent of one core) }.
export const floorOf = entry => ({ memory: entry['sandbox-memory-gib'] * GIB, cpu: entry['sandbox-cpu-percent'] });

// percentile(values, p) — the nearest-rank p-th percentile of `values` (null for none).
export function percentile(values, p = PERCENTILE) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

// target(samples, floor) — what the estimate moves towards: per dimension the larger of the floor and the samples'
// PERCENTILE; { memory, cpu, source, samples (how many) }.
export function target(samples, floor) {
  const mem = percentile(samples.map(s => s['memory-bytes'])), cpu = percentile(samples.map(s => s['cpu-percent']));
  const memory = Math.max(floor.memory, mem ?? 0), c = Math.max(floor.cpu, cpu ?? 0);
  const above = samples.length && (memory > floor.memory || c > floor.cpu);
  return { memory, cpu: c, source: above ? 'working-samples' : 'defaults', samples: samples.length };
}

// step(previous, goal, floor) — `previous` moved towards `goal` by at most STEP, never below `floor` (each { memory, cpu });
// the goal itself with no previous.
export function step(previous, goal, floor) {
  const one = d => {
    const was = previous?.[d];
    const moved = Number.isFinite(was) && was > 0 ? Math.min(was * STEP, Math.max(was / STEP, goal[d])) : goal[d];
    return Math.max(floor[d], moved);
  };
  return { memory: one('memory'), cpu: one('cpu') };
}

// readEstimate(projectsDir, id) — its ticket-estimate.json, or an empty one (absent or unreadable).
export function readEstimate(projectsDir, id) {
  const file = estimateFile(projectsDir, id);
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return { samples: Array.isArray(j.samples) ? j.samples.filter(s => s['memory-bytes'] > 0) : [], 'checked-at': j['checked-at'] ?? null, estimate: j.estimate ?? null, at: j.at ?? null };
    }
  } catch { /* half-written or gone: as if none */ }
  return { samples: [], 'checked-at': null, estimate: null, at: null };
}

// trackBusy(ctx, project, isBusy) — each tick: the stretch of work of each of the project's variations (from when it
// started to the last tick it was still working), for sampleable's test.
export function trackBusy(ctx, project, isBusy) {
  const m = memoryOf(ctx), now = ctx.now().getTime();
  for (const t of project.tickets ?? []) for (const v of t.variations ?? []) {
    const k = `${project.id}/${String(t.key).toUpperCase()}/${v.name}`, was = m.busy.get(k);
    if (isBusy(t.key, v.name)) m.busy.set(k, was && was.open ? { from: was.from, to: now, open: true } : { from: now, to: now, open: true });
    else if (was?.open) m.busy.set(k, { ...was, open: false });
    else if (was && now - was.to > KEEP_BUSY_MS) m.busy.delete(k);
  }
}

const memoryOf = ctx => (ctx.memory.ticketEstimate ??= { busy: new Map(), files: new Map(), said: new Map() });

// workingSamples(ctx, project, live, actorOf, lead) — the new readings of `live` (the project's Mac cluster's last check)
// that are working samples: [{ at, actor, memory-bytes, cpu-percent }]; [] for a reading already taken.
export function workingSamples(ctx, project, live, actorOf, lead, since) {
  const at = Date.parse(live?.['checked-at'] ?? '');
  if (!Number.isFinite(at) || (since && at <= Date.parse(since))) return [];
  const m = memoryOf(ctx), out = [];
  for (const u of sandboxUse(live)) {
    if (u.state !== 'running' || !(u.memory > 0)) continue;   // idle-or-not is the variation's; starting, hibernated, hibernating never
    const who = actorOf.get(u.actor);
    const b = who && m.busy.get(`${project.id}/${String(who.key).toUpperCase()}/${who.variation}`);
    if (!b || b.from > at - lead || b.to < at) continue;   // not working through the reading's whole interval
    out.push({ at: new Date(at).toISOString(), actor: u.actor, 'memory-bytes': u.memory, 'cpu-percent': u.cpu });
  }
  return out;
}

// estimateFor(ctx, state, project, entry, { own, isBusy }) — one ticket's expected use, { memory, cpu, source, samples,
// target, floor }. For the control's own projects (`own`) it takes the new working samples, moves the estimate a step and
// keeps it (ESTIMATE_FILE); for another control's it reads what that one kept.
export function estimateFor(ctx, state, project, entry, { own = false, isBusy = () => false } = {}) {
  const m = memoryOf(ctx), floor = floorOf(entry), dir = ctx.paths.projects;
  const file = own ? (m.files.get(project.id) ?? readEstimate(dir, project.id)) : readEstimate(dir, project.id);
  let kept = file;
  if (own) {
    trackBusy(ctx, project, isBusy);
    const live = project.substrate?.[MAC];
    const actorOf = new Map();
    for (const t of project.tickets ?? []) for (const v of t.variations ?? []) actorOf.set(v.sandbox?.name ?? `${t.key}-${v.name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'), { key: t.key, variation: v.name });
    const lead = (state.harness?.['substrate-check-seconds'] ?? CHECK_EVERY / 1000) * 1000;
    const fresh = workingSamples(ctx, project, live, actorOf, lead, file['checked-at']);
    const checkedAt = Number.isFinite(Date.parse(live?.['checked-at'] ?? '')) && (!file['checked-at'] || Date.parse(live['checked-at']) > Date.parse(file['checked-at'])) ? live['checked-at'] : file['checked-at'];
    const samples = [...file.samples, ...fresh].slice(-SAMPLES_KEPT);
    const goal = target(samples, floor);
    const next = step(file.estimate && { memory: file.estimate['memory-bytes'], cpu: file.estimate['cpu-percent'] }, goal, floor);
    const estimate = { 'memory-bytes': Math.round(next.memory), 'cpu-percent': Math.round(next.cpu * 10) / 10 };
    kept = { samples, 'checked-at': checkedAt, estimate, at: file.at };
    const changed = fresh.length || checkedAt !== file['checked-at'] || JSON.stringify(estimate) !== JSON.stringify(file.estimate);
    if (changed) kept = write(ctx, project.id, { ...kept, at: ctx.now().toISOString() });
    m.files.set(project.id, kept);
  }
  const goal = target(kept.samples, floor);
  const now = kept.estimate ? { memory: Math.max(floor.memory, kept.estimate['memory-bytes']), cpu: Math.max(floor.cpu, kept.estimate['cpu-percent']) } : { memory: goal.memory, cpu: goal.cpu };
  return { ...now, source: goal.source, samples: kept.samples.length, target: { memory: goal.memory, cpu: goal.cpu }, floor };
}

// write(ctx, id, body) — ESTIMATE_FILE written whole (a temp file renamed over it); a failure logged, the body kept in
// memory either way.
function write(ctx, id, body) {
  const file = estimateFile(ctx.paths.projects, id);
  try {
    writeFileSync(`${file}.tmp`, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  } catch (error) { ctx.log('error', `budget: ${file}: ${error.message}`); }
  return body;
}
