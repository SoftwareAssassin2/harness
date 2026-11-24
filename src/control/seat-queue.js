// ASS-525: the seat queue — each project's ticket variations waiting for a
// seat, in the order control will give them one when one frees, written to
// data/projects/<p>/seat-queue.json for the dashboard's footer "queue" box
// (src/tui/screens/frame.js queueBox), which runs apart from control and only
// reads files. A tick phase at the end of the tick, after the steps have moved
// and the agents gone out, so the file holds the line as the next tick finds
// it; written atomically (a temporary file renamed over it) only when the line
// changes, removed when nobody waits — as seats.js writes seats.json.
//
// The order is the planner's own (plan.js planFor, planDispatch's outputs),
// not worked out again here, so it stays right however the planner seats:
// 1. those in motion at a step that takes a seat but holding none — the
//    planner's `waiting` — with those refused one for want of memory for
//    their VMs (`memoryWaiting`, ASS-420; `memoryHeld`, ASS-404) in their rank
//    place among them, as planDispatch weighs them again each tick in rank
//    order. Each waits for a planning seat or a build seat by the kind of
//    seat its step takes (plan.js slotKind), or for memory. ASS-469: one still
//    holding a recorded seat (taken out of it when the seats shrank) is ahead
//    of the rest, as planDispatch keeps the seated first;
// 2. then the `ready` (ASS-362: plan finished), for a build seat, and the
//    `entering` (not yet started, at committed), for a planning seat — they
//    move through mayEnter only once those in motion are seated; ASS-528: the
//    two take the same pool's seats, so they are one list in rank order;
//    `full` on an entering one while max-tickets-ready-for-build is reached
//    (readyFull), when none may enter planning at all.
// Each list is in rank order (rankSprint), as control moves the sprint's
// variations highest-ranked first (steps.js) — ASS-531: plan.js sprintOrder's, so while the project's focus on
// planning is on, those at a planning step (committed among them) are ahead of the rest in each list.
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planFor, slotKind, sprintOrder } from './plan.js';
import { statusIn } from './engine.js';
import { seatedIn } from './seat-kinds.js';
import { readJson } from './read.js';

const PHASE = 'seats';
export const SEAT_QUEUE_FILE = 'seat-queue.json';
// What a queued variation waits for: a build (in-progress) seat, a planning seat, or memory for its VM.
export const WAITS = { build: 'build', planning: 'planning', memory: 'memory' };

// seatQueue(state, project, plan) — the project's queue (see the module comment): [{ key, variation, title, waits,
// full? }], first in line first. `plan`: planFor's for the project (computed when not given).
export function seatQueue(state, project, plan = planFor(state, project)) {
  if (!project?.engine) return [];
  const engines = project.engines ?? state.engines ?? {};
  const rank = new Map(), found = new Map();
  for (const { ticket: t, variation: v } of sprintOrder(state, project)) {
    const id = `${String(t.key).toUpperCase()} ${v.name}`;
    if (!rank.has(id)) { rank.set(id, rank.size); found.set(id, { t, v }); }
  }
  const idOf = s => `${String(s.key).toUpperCase()} ${s.variation}`;
  const entry = (s, waits, extra = {}) => ({ key: found.get(idOf(s))?.t.key ?? s.key, variation: s.variation, title: found.get(idOf(s))?.t.title ?? '', waits, ...extra });
  const seated = seatedIn(project);
  const isSeated = s => { const f = found.get(idOf(s)); return Boolean(f && seated(f.t, f.v)); };
  const kindOf = s => {
    const f = found.get(idOf(s));
    if (!f) return WAITS.build;
    const status = statusIn(project.engine, f.v, engines);
    return slotKind(status.step, status) === 'planning' ? WAITS.planning : WAITS.build;
  };
  const byRank = (a, b) => (rank.get(idOf(a)) ?? Infinity) - (rank.get(idOf(b)) ?? Infinity);
  const inMotion = [
    ...(plan.waiting ?? []).map(s => ({ s, waits: kindOf(s) })),
    ...[...(plan.memoryWaiting ?? []), ...(plan.memoryHeld ?? [])].map(s => ({ s, waits: WAITS.memory })),
  ].filter((x, i, all) => all.findIndex(y => idOf(y.s) === idOf(x.s)) === i)
    .toSorted((a, b) => Number(isSeated(b.s)) - Number(isSeated(a.s)) || byRank(a.s, b.s));
  // ASS-528: one pool — a finished plan going on to Build and a ticket entering planning take the same free seat, so
  // they queue together in rank order (steps.js moves the sprint highest-ranked first).
  const starting = [
    ...(plan.ready ?? []).map(s => ({ s, waits: WAITS.build })),
    ...(plan.entering ?? []).map(s => ({ s, waits: WAITS.planning, extra: plan.readyFull ? { full: true } : {} })),
  ].toSorted((a, b) => byRank(a.s, b.s));
  return [
    ...inMotion.map(({ s, waits }) => entry(s, waits)),
    ...starting.map(({ s, waits, extra }) => entry(s, waits, extra)),
  ];
}

// loadSeatQueue(projectDir) — its seat-queue.json's queue, [] without one or caught half-written (the dashboard's read).
export function loadSeatQueue(projectDir) {
  try {
    const file = join(projectDir, SEAT_QUEUE_FILE);
    return existsSync(file) ? readJson(file)?.queue ?? [] : [];
  } catch { return []; }
}

// recordSeatQueue(ctx, state) — the tick's phase: each project's queue written when it differs from the one last
// written (by a temporary file renamed over it; removed when nobody waits).
export function recordSeatQueue(ctx, state) {
  const last = (ctx.memory.seatQueue ??= new Map());
  for (const project of state.projects) {
    if (!project.engine) continue;
    const file = join(ctx.paths.projects, project.id, SEAT_QUEUE_FILE);
    const queue = seatQueue(state, project), text = `${JSON.stringify({ queue }, null, 2)}\n`;
    if (!queue.length) {
      if (existsSync(file)) rmSync(file, { force: true });
      last.set(project.id, text);
      continue;
    }
    if (last.get(project.id) === text && existsSync(file)) continue;
    const tmp = `${file}.tmp`;
    try { writeFileSync(tmp, text); renameSync(tmp, file); last.set(project.id, text); } catch (error) { ctx.log('error', `${PHASE}: ${file}: ${error.message}`); }
  }
}
