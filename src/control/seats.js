// ASS-469: each ticket variation in progress sits in one seat, a VM seat or a
// workstation seat (seat-kinds.js says what each project has: project.json's
// max-tickets-in-progress VM seats, one seat per workstation: AC9), recorded in
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
// Machines follow seats (workstation-steps.js): a workstation-seat holder's
// steps claim its seat's workstation, a VM-seat holder's run on its VM; the
// workstation is kept started while its seats are used (workstations.js,
// seatNeeds here).
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planFor } from './plan.js';
import { seatCapacity, keepSeats, placeSeats, seatWords, isRemoteSeat, SEATS_FILE } from './seat-kinds.js';
import { stepOnMachine } from './workstation-steps.js';

const PHASE = 'seats';
// SEAT_HEALTH — what the long Health of a variation taken out of a lost workstation's seat begins with.
export const SEAT_HEALTH = 'Lost its workstation seat:';

const keyOf = (project, key, variation) => `${project} ${String(key).toUpperCase()} ${variation}`;

// assignSeats(ctx, state) — the tick's phase (see the module comment), project by project.
export async function assignSeats(ctx, state) {
  const m = (ctx.memory.seatKinds ??= { lost: new Map() });   // (memory.seats is fast-track.js's)
  const lostNow = new Map();
  for (const project of state.projects) {
    if (!project.engine) continue;
    const capacity = seatCapacity(project), dir = join(ctx.paths.projects, project.id), withWs = capacity.workstations.length > 0;
    const before = project.seats ?? [];
    const { kept, lost, unseated } = keepSeats(before, capacity);
    for (const l of lost) {
      ctx.log(PHASE, `${l.key} ${l.variation}: taken out of its ${l.workstation ? `${l.kind === 'cloud-vm' ? 'cloud VM' : 'workstation'} seat on ${l.workstation}` : 'VM seat'}: ${l.workstation ? `${l.workstation} can't be used (${l.why})` : l.why}; it takes the next free seat of either kind`);
      if (l.workstation) m.lost.set(keyOf(project.id, l.key, l.variation), l);
    }
    for (const s of unseated) ctx.log(PHASE, `${s.key} ${s.variation}: gives up ${seatWords(s)}: that kind's seats were lowered; it takes the next free seat`);
    project.seats = kept;
    const { reserved, waiting } = planFor(state, project);
    const placed = placeSeats({ records: kept, reserved, capacity, midStep: (key, variation) => stepOnMachine(ctx, state, project.id, key, variation), now: ctx.now().toISOString() });
    for (const s of placed.left) if (withWs) ctx.log(PHASE, `${s.key} ${s.variation}: leaves ${seatWords(s)} (no longer in progress)`);
    for (const s of placed.moved) ctx.log(PHASE, `${s.key} ${s.variation}: moves from a VM seat to ${seatWords({ kind: s.kind ?? 'workstation', workstation: s.workstation })}, between its steps; its VM seat is free for the next ticket`);
    for (const s of placed.seated) if (withWs || m.lost.has(keyOf(project.id, s.key, s.variation))) ctx.log(PHASE, `${s.key} ${s.variation}: takes ${seatWords(s)}`);
    project.seats = placed.records;
    record(ctx, dir, before, placed.records);
    // Those taken out of a lost workstation's seat, still in progress and seated nowhere yet, keep their Health.
    const seatedNow = new Set(placed.records.map(s => keyOf(project.id, s.key, s.variation)));
    const inProgress = new Set([...reserved, ...waiting].map(s => keyOf(project.id, s.key, s.variation)));
    for (const [k, l] of m.lost) if (k.startsWith(`${project.id} `) && !seatedNow.has(k) && inProgress.has(k)) lostNow.set(k, { ...l, project: project.id });
  }
  m.lost = lostNow;
  await health(ctx, state, lostNow);
}

// record(ctx, dir, before, records) — seats.json written when it differs (by a temporary file renamed over it),
// removed when nobody holds a seat.
function record(ctx, dir, before, records) {
  const file = join(dir, SEATS_FILE), strip = list => JSON.stringify(list.map(({ key, variation, kind, workstation }) => [key, variation, kind, workstation ?? null]));
  if (!records.length) { if (existsSync(file)) rmSync(file, { force: true }); return; }
  if (strip(before) === strip(records) && existsSync(file)) return;
  const tmp = `${file}.tmp`;
  try { writeFileSync(tmp, `${JSON.stringify({ seats: records }, null, 2)}\n`); renameSync(tmp, file); } catch (error) { ctx.log('error', `${PHASE}: ${file}: ${error.message}`); }
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
