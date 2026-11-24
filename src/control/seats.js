// ASS-469: each ticket variation in progress sits in one seat, a VM seat or a
// workstation seat (seat-kinds.js says what each project has: ASS-528 its seat
// budget's VM seats, seat-budget.js, one seat per workstation: AC9), recorded in
// data/projects/<p>/seats.json — control's live data, written here each tick
// (atomically, when it changes; removed when nobody holds one). A tick phase,
// before ASS-420's memory check and the VMs, so both, and the workstation job
// and the steps after them, follow this tick's seats:
//
// - A workstation that can't be used (its gcloud login lapsed, its setup
//   failed, it could not be reached or started: seat-kinds.js lostWhy) has its
//   seats lost — no bound seats (operator decision, 2026-11-15). Its holders
//   are taken out of them, logged, their Health saying so (SEAT_HEALTH,
//   cleared once seated again); one whose step is mid-run there finishes or
//   fails as any step does, with ASS-468's release. Taken out, they hold no
//   recorded seat, and the planner (plan.js planFor) keeps everyone still
//   seated ahead of them, so they are the ones who wait when the seats are
//   short — and, being in progress already, they take the next free seat of
//   either kind ahead of a ticket not yet in progress (which needs a free
//   seat to move in at all: plan.js mayEnter).
// - The planner's in-progress holders (planFor's reserved, its in-progress
//   capacity the seats of both kinds) are then placed (seat-kinds.js
//   placeSeats): those no longer in progress leave their seats; each free
//   workstation seat goes to the highest-ranked variation in a VM seat whose
//   step is not running on its machine (workstation-steps.js stepOnMachine:
//   its step's lease holding a machine, its agent or script there) — a move
//   between steps, never during one, logged — and the VM seat it leaves is
//   free for the next; then each newly in progress takes a free workstation
//   seat, else a free VM seat (logged in a project with workstations).
//
// ASS-527: a variation holds a seat only while its current step uses its
// machine (plan.js slotKind, machine-steps.js), so the planner's holders
// change as variations move: one entering a gate, a human step, a wait or a
// host-only script gives its seat up in that tick — the planner reads the live
// data, so the next in rank order may take it at once — and leaves its
// seats.json record here at the next pass. noteReleases logs each such
// release once (here, and again at the end of the tick's steps, steps.js
// runSteps, so a release made by a move there is logged in the same tick).
//
// ASS-528: planning and building are one pool, so the planning seat holders
// (planFor's inPlanning) are recorded too, as seats.json's `planning` list —
// the planner keeps them seated ahead of the rest as it does the in-progress
// ones — and they take VM seats (outside workstation mode), so the in-progress
// placement here has the VM seats less those.
//
// ASS-540: run targets (run-targets.js). The planner says on which target each holder runs (planFor's `targets`):
// placeSeats puts it in a seat of that kind (a Mac seat for local-vm, a workstation's or a cloud VM's), moving it
// between its steps when its next step wants another kind; each record keeps its `target`. The holders on a Mac target
// (local-worktree, local-workspace) take no seat: they are seats.json's `local` list ({ key, variation, target, since }),
// which dispatch.js and steps.js read to run their steps on the Mac, and vm-lifecycle.js to keep their VMs stopped.
//
// Machines follow seats (workstation-steps.js): a workstation-seat holder's
// steps claim its seat's workstation, a VM-seat holder's run on its VM; the
// workstation is kept started while its seats are used (workstations.js,
// seatNeeds here).
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planFor } from './plan.js';
import { statusIn } from './engine.js';
import { idleAt } from './vm-lifecycle.js';
import { seatCapacity, keepSeats, placeSeats, seatWords, isRemoteSeat, lostWhy, SEATS_FILE } from './seat-kinds.js';
import { workstationUsable } from './workstation-connection.js';
import { BOOT_WAIT_SECONDS } from './run-targets.js';
import { stepOnMachine } from './workstation-steps.js';
import { removeDoneWorktrees } from './run-target-places.js';
import { roomWords } from './pool-choice.js';

const PHASE = 'seats';
// SEAT_HEALTH — what the long Health of a variation taken out of a lost workstation's seat begins with.
export const SEAT_HEALTH = 'Lost its workstation seat:';

const keyOf = (project, key, variation) => `${project} ${String(key).toUpperCase()} ${variation}`;

// assignSeats(ctx, state) — the tick's phase (see the module comment), project by project.
export async function assignSeats(ctx, state) {
  noteReleases(ctx, state);   // ASS-527
  const m = (ctx.memory.seatKinds ??= { lost: new Map() });   // (memory.seats is fast-track.js's)
  const lostNow = new Map();
  for (const project of state.projects) {
    if (!project.engine) continue;
    bootWaits(ctx, state, project);   // ASS-553 AC7: a remote machine not up within remote-boot-wait-seconds counts as lost
    const all = seatCapacity(project), dir = join(ctx.paths.projects, project.id), withWs = all.workstations.length > 0;
    // ASS-528: the VM seats the planning holders leave for those in progress (none taken in workstation mode).
    const less = n => ({ ...all, vm: all.mode === 'workstation' ? all.vm : Math.max(0, all.vm - n) });
    const before = project.seats ?? [], planningBefore = project.planningSeats ?? [];
    const { kept, lost, unseated } = keepSeats(before, less(planningBefore.length));
    for (const l of lost) {
      ctx.log(PHASE, `${l.key} ${l.variation}: taken out of its ${l.workstation ? `${l.kind === 'cloud-vm' ? 'cloud VM' : 'workstation'} seat on ${l.workstation}` : 'VM seat'}: ${l.workstation ? `${l.workstation} can't be used (${l.why})` : l.why}; it takes the next free seat of either kind`);
      if (l.workstation) m.lost.set(keyOf(project.id, l.key, l.variation), l);
    }
    for (const s of unseated) ctx.log(PHASE, `${s.key} ${s.variation}: gives up ${seatWords(s)}: that kind's seats were lowered; it takes the next free seat`);
    project.seats = kept;
    const { reserved, waiting, inPlanning, targets, local } = planFor(state, project);
    const planned = new Map((targets ?? []).map(t => [`${String(t.key).toUpperCase()} ${t.variation}`, t]));
    const targetFor = (key, variation) => planned.get(`${String(key).toUpperCase()} ${variation}`) ?? null;
    const localBefore = project.localSeats ?? [];
    const now = ctx.now().toISOString();
    const planningNow = inPlanning.map(s => ({ key: s.key, variation: s.variation, ...(targetFor(s.key, s.variation)?.target ? { target: targetFor(s.key, s.variation).target } : {}), since: planningBefore.find(p => p.key === s.key && p.variation === s.variation)?.since ?? now }));
    const localNow = (local ?? []).map(s => ({ key: s.key, variation: s.variation, target: s.target, since: localBefore.find(p => p.key === s.key && p.variation === s.variation && p.target === s.target)?.since ?? now }));
    for (const l of localNow) if (!localBefore.some(p => p.key === l.key && p.variation === l.variation && p.target === l.target)) ctx.log(PHASE, `${l.key} ${l.variation}: runs on ${l.target} (on the Mac, no seat)`);
    const placed = placeSeats({ records: kept, reserved, capacity: less(planningNow.length), midStep: (key, variation) => stepOnMachine(ctx, state, project.id, key, variation), now, targetFor });
    for (const s of placed.left) if (withWs) ctx.log(PHASE, `${s.key} ${s.variation}: leaves ${seatWords(s)} (no longer in progress)`);
    for (const s of placed.moved) ctx.log(PHASE, s.workstation == null ? `${s.key} ${s.variation}: moves to a VM seat, between its steps, as its step's run targets ask` : `${s.key} ${s.variation}: moves from a VM seat to ${seatWords({ kind: s.kind ?? 'workstation', workstation: s.workstation })}, between its steps; its VM seat is free for the next ticket`);
    for (const s of placed.seated) if (withWs || m.lost.has(keyOf(project.id, s.key, s.variation))) ctx.log(PHASE, `${s.key} ${s.variation}: takes ${seatWords(s)}`);
    // ASS-553 AC3, AC7: a placement the pool choice made (most-room, remote-first), logged once — when the seat is given or moved, or the
    // Mac target taken: where it went and every candidate's room then (pool-choice.js).
    const decided = [...placed.seated.map(s => [s, s.workstation]), ...placed.moved.map(s => [s, s.workstation]), ...localNow.filter(l => !localBefore.some(p => p.key === l.key && p.variation === l.variation && p.target === l.target)).map(l => [l, null])];
    for (const [s, machine] of decided) {
      const plan = targetFor(s.key, s.variation);
      if (!plan?.choice || plan.choice === 'first' || ((plan.rooms ?? []).length < 2 && !machine)) continue;   // a choice of one on the Mac: nothing decided
      const target = s.target ?? plan.target;
      ctx.log(PHASE, `${s.key} ${s.variation}: placed on ${target}${machine ? ` (${machine})` : ''} by pool choice ${plan.choice} — headroom now, in tickets: ${roomWords(plan.rooms ?? [])}`);
    }
    bootPlaced(ctx, project, [...placed.seated, ...placed.moved], ctx.now().getTime());   // ASS-553 AC7
    project.seats = placed.records;
    project.planningSeats = planningNow;
    project.localSeats = localNow;
    record(ctx, dir, { seats: before, planning: planningBefore, local: localBefore }, { seats: placed.records, planning: planningNow, local: localNow });
    // Those taken out of a lost workstation's seat, still in progress and seated nowhere yet, keep their Health.
    const seatedNow = new Set(placed.records.map(s => keyOf(project.id, s.key, s.variation)));
    const inProgress = new Set([...reserved, ...waiting].map(s => keyOf(project.id, s.key, s.variation)));
    for (const [k, l] of m.lost) if (k.startsWith(`${project.id} `) && !seatedNow.has(k) && inProgress.has(k)) lostNow.set(k, { ...l, project: project.id });
  }
  m.lost = lostNow;
  await health(ctx, state, lostNow);
  await removeDoneWorktrees(ctx, state);   // ASS-540: a done ticket's local-worktree worktree removed
}

// bootWaits(ctx, state, project) — ASS-553 AC7: a remote machine holding seats while it is not up (stopped, starting, or
// connected but not set up yet: workstation-connection.js workstationUsable) is waited for — control starts it
// (seatNeeds) and the steps placed on it wait for it there, its seats those given to them (ASS-529's unmeasured rule:
// no more until a reading shows room, so it is never over-filled while it boots) — for up to harness.json's
// remote-boot-wait-seconds (run-targets.js BOOT_WAIT_SECONDS by default), from when a step was placed on it while it
// was not up (bootPlaced, as seats.js places it), else from when this control first saw it so. Past
// that it counts as lost (project.bootWaitOver, read by seat-kinds.js seatCapacity) until it is up: its holders are
// taken out of its seats (keepSeats, logged) and placed again — the next remote machine with room, else the Mac — and
// no new one goes to it; control goes on starting it (seatNeeds: lost with tickets in progress), and once it is up its
// seats are back. A machine that cannot be used for another reason (lostWhy: its login, its setup, unreachable) is
// lost at once, as before. Logged once each way.
export function bootWaits(ctx, state, project) {
  const m = (ctx.memory.bootWaits ??= new Map()), now = ctx.now().getTime();
  const wait = Number(state.harness?.['remote-boot-wait-seconds'] ?? BOOT_WAIT_SECONDS) * 1000;
  const over = {};
  for (const w of project.devEnvironments?.workstations ?? []) {
    const k = `${project.id} ${w.id}`, entry = project.workstations?.[w.id];
    const held = (project.seats ?? []).some(s => isRemoteSeat(s) && s.workstation === w.id);
    if (workstationUsable(entry) || lostWhy(entry)) {
      if (m.get(k)?.over && workstationUsable(entry)) ctx.log(PHASE, `${w.id} is up: its seats are back`);
      m.delete(k);
      continue;
    }
    const was = m.get(k);
    if (!was && !held) continue;   // stopped, and nothing placed on it: nothing waits for it
    // From when a step was placed on it while it was not up (placed below), else from when this control first saw it
    // so — never from an older seat's since: a machine that stops under a seat held for long gets its full wait.
    const since = was?.since ?? now;
    const late = was?.over || now - since > wait;
    if (late && !was?.over) ctx.log(PHASE, `${w.id} did not come up within ${Math.round(wait / 1000)} s (remote-boot-wait-seconds) of a step being placed on it: its steps go to the next remote machine with room, else the Mac, until it is up; control goes on starting it`);
    m.set(k, { since, over: late });
    if (late) over[w.id] = `it did not come up within ${Math.round(wait / 1000)} s (remote-boot-wait-seconds)`;
  }
  project.bootWaitOver = over;
}

// bootPlaced(ctx, project, records, now) — ASS-553 AC7: the boot wait of each remote machine not up that a seat was just
// given on (seated or moved here) starts now, unless it already waits.
function bootPlaced(ctx, project, records, now) {
  const m = (ctx.memory.bootWaits ??= new Map());
  for (const s of records) {
    if (!s.workstation || workstationUsable(project.workstations?.[s.workstation])) continue;
    const k = `${project.id} ${s.workstation}`;
    if (!m.has(k)) m.set(k, { since: now, over: false });
  }
}

// noteReleases(ctx, state) — ASS-527 AC1: each variation that held a planning or an in-progress seat when last
// looked at (memory.seatHolders: project id → Map "<KEY> <variation>" → its kind; none at control's first look) and
// holds none now because its current step does not use its machine (vm-lifecycle.js idleAt: a gate, a human step,
// a wait, a host-only script) is logged once: "<KEY> <variation>: releases its <kind> seat at <where>: …". Those that
// left their seat otherwise (done, Blocked, paused, held) are not — as before.
export function noteReleases(ctx, state) {
  const was = (ctx.memory.seatHolders ??= new Map());
  for (const project of state.projects) {
    if (!project.engine || !project.sprint) continue;
    const plan = planFor(state, project), now = new Map([...plan.reserved.map(s => [s, 'progress']), ...plan.inPlanning.map(s => [s, 'planning'])].map(([s, kind]) => [`${String(s.key).toUpperCase()} ${s.variation}`, kind]));
    const before = was.get(project.id);
    was.set(project.id, now);
    if (!before) continue;
    for (const [k, kind] of before) {
      if (now.has(k)) continue;
      const [key, name] = k.split(' '), t = project.tickets.find(x => String(x.key).toUpperCase() === key), v = t?.variations?.find(x => x.name === name && !x['is-deleted']);
      if (!v || !idleAt(project.engines ?? state.engines, project.engineName, v)) continue;
      const where = statusIn(project.engine, v, project.engines ?? state.engines).chain.map(l => l.state).join('/');
      ctx.log(PHASE, `${t.key} ${name}: releases its ${kind === 'planning' ? 'planning' : 'in-progress'} seat at ${where}: its step does not use its machine; its VM stops once nothing runs in it`);
    }
  }
}

// record(ctx, dir, before, after) — seats.json ({ seats, planning }, ASS-528: the planning holders too) written when it
// differs (by a temporary file renamed over it), removed when nobody holds a seat.
function record(ctx, dir, before, after) {
  const file = join(dir, SEATS_FILE), strip = ({ seats, planning, local = [] }) => JSON.stringify([seats.map(({ key, variation, kind, workstation, target }) => [key, variation, kind, workstation ?? null, target ?? null]), planning.map(({ key, variation, target }) => [key, variation, target ?? null]), local.map(({ key, variation, target }) => [key, variation, target])]);
  if (!after.seats.length && !after.planning.length && !after.local?.length) { if (existsSync(file)) rmSync(file, { force: true }); return; }
  if (strip(before) === strip(after) && existsSync(file)) return;
  const tmp = `${file}.tmp`;
  try { writeFileSync(tmp, `${JSON.stringify({ seats: after.seats, planning: after.planning, ...(after.local?.length ? { local: after.local } : {}) }, null, 2)}\n`); renameSync(tmp, file); } catch (error) { ctx.log('error', `${PHASE}: ${file}: ${error.message}`); }
}

// health(ctx, state, lost) — each variation taken out of a lost workstation's seat and seated nowhere yet shows so
// on its Health; cleared from every other variation showing it (unless something else was written since).
async function health(ctx, state, lost) {
  for (const project of state.projects) for (const t of project.tickets ?? []) for (const v of t.variations ?? []) {
    const l = lost.get(keyOf(project.id, t.key, v.name));
    if (l) {
      const short = `Lost its workstation seat: ${l.workstation} can't be used; waits for the next free seat`.slice(0, 120);
      const long = `${SEAT_HEALTH} ${l.workstation} can't be used (${l.why}), so its seats are lost while that lasts and this ticket was taken out of its seat there. It takes the next free seat of either kind, ahead of tickets not yet in progress, and goes on there. ${/login/.test(l.why) ? 'Renew the workstation\'s gcloud login to have its seats back.' : 'Control keeps trying the workstation; its seats come back once it can be used.'}`;
      if (v['ai-feedback-long'] === long) continue;
      await ctx.attempt(PHASE, `${t.key} ${v.name}`, () => ctx.cli(['ticket:set-ai-feedback', project.id, t.key, v.name, short, long]));
    } else if (v['ai-feedback-long']?.startsWith(SEAT_HEALTH) && !v['is-deleted']) {
      await ctx.attempt(PHASE, `${t.key} ${v.name}`, () => ctx.cli(['ticket:clear-ai-feedback', project.id, t.key, v.name, v['ai-feedback-long']]));
    }
  }
}

// seatNeeds(state, project, plan) — AC6: Map workstation id → why its seats need it started, connected and set up
// now (workstations.js workstationNeeds adds them): a variation in progress holds one of its seats; or it has a free
// seat and a variation waits for an in-progress seat (planFor's waiting and ready) or sits in a VM seat to move into
// it; or its seats are lost and the project has tickets in progress or waiting, who would take them once it is
// back (so its connect is tried again, after its backoff). Nobody seated and nobody waiting: not needed, and it
// may disconnect and stop itself (ASS-433's idle disconnect, its own 30-minute stop).
export function seatNeeds(state, project, plan = planFor(state, project)) {
  const needs = new Map(), records = project.seats ?? [], capacity = seatCapacity(project);
  const waiting = [...plan.waiting, ...plan.ready, ...(plan.memoryWaiting ?? [])], inVm = records.filter(s => s.kind === 'vm');
  const name = list => list.slice(0, 3).map(s => `${s.key} ${s.variation}`).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '');
  for (const w of capacity.workstations) {
    if (w.seats <= 0) continue;
    const on = records.filter(s => isRemoteSeat(s) && s.workstation === w.id);
    if (on.length) needs.set(w.id, `its seat${on.length > 1 ? 's' : ''}: ${name(on)}`);
    else if (w.lost && (records.length || waiting.length || plan.reserved.length)) needs.set(w.id, `its seats lost (${w.lost}); tickets in progress would take them`);
    else if (!w.lost && on.length < w.seats && waiting.length) needs.set(w.id, `a free seat: ${name(waiting)} waiting for one`);
    else if (!w.lost && on.length < w.seats && inVm.length) needs.set(w.id, `a free seat: ${name(inVm)} to move into it from a VM seat`);
  }
  return needs;
}
