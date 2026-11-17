// ASS-469: a project's in-progress seats come in two kinds, VM seats and
// workstation seats (operator decision, 2026-11-15: "there is a
// VM-seat-count and a workstation-seat-count"). project.json's
// max-tickets-in-progress keeps its meaning as the project's VM seats; each
// workstation of its dev-environments is exactly one workstation seat (AC9,
// operator 2026-11-16: no `seats` setting). vm mode has VM seats alone; workstation
// mode workstation seats alone; vm+workstation both. The project's
// in-progress capacity (what plan.js planFor grants, under harness.json's
// max-tickets-in-progress across projects as before) is its VM seats plus the
// number of its workstations that can be used: a workstation whose gcloud
// login lapsed, whose setup failed, or whose last connect failed
// (unreachable, or it would not start) has its seats lost while that lasts
// (no bound seats). One merely stopped — its own 30-minute idle stop — keeps
// its seats: a ticket taking one has it started at once (workstations.js).
//
// Which variation holds which seat is control's live data,
// data/projects/<p>/seats.json (seats.js writes it each tick, atomically):
// { seats: [{ key, variation, kind: 'vm' } | { key, variation, kind:
// 'workstation', workstation: <id> }, each with since] }. Planning seats have
// no kinds (planning steps run on VMs).
//
// ASS-481: a workstation seat is one kind of remote seat; a cloud VM of the
// project's dev-environments (its pool, after its workstations) is exactly
// one remote seat too, of kind 'cloud-vm' ({ key, variation, kind:
// 'cloud-vm', workstation: <its id>, since }), treated as a workstation seat
// in every rule here: preferred over VM seats, lost while its VM can't be
// used (lostWhy: also a start or SSH wait that timed out), filled again once
// it can; free remote seats filled in the pool's order — workstations
// first, then cloud VMs. Its own idle stop (60 minutes) keeps its seat as a
// stopped workstation's does. This file is pure — the planner, the
// workstation job and the dashboard all read seats through it, so they agree.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readJson } from './read.js';
import { loginExpired } from './workstation-connection.js';

export const SEATS_FILE = 'seats.json';
// ASS-481: the remote seats' kinds, a workstation's and a cloud VM's; isRemoteSeat(record) — the record is one.
export const REMOTE_SEAT_KINDS = new Set(['workstation', 'cloud-vm']);
export const isRemoteSeat = s => REMOTE_SEAT_KINDS.has(s?.kind);
// remoteSeatKind(remote) — the seat kind of a remote of seatCapacity's workstations: 'cloud-vm' for a cloud VM.
const remoteSeatKind = w => (w?.kind === 'cloud-vm' ? 'cloud-vm' : 'workstation');
const MODES_WITH_VMS = new Set(['vm', 'vm+workstation']), MODES_WITH_WORKSTATIONS = new Set(['workstation', 'vm+workstation']);

// loadSeats(projectDir, read) — its seats.json's records, [] without one; one caught half-written reads as [] (the next tick writes it whole).
// `read`: readJson, or loadState's readJsonCached (ASS-495).
export function loadSeats(projectDir, read = readJson) {
  try {
    const file = join(projectDir, SEATS_FILE);
    return existsSync(file) ? read(file)?.seats ?? [] : [];
  } catch { return []; }
}

const same = (a, b) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();

// seatOf(records, key, variation) — the variation's seat record, or undefined.
export const seatOf = (records = [], key, variation) => records.find(s => same(s.key, key) && s.variation === variation);

// lostWhy(entry) — why a workstation's seats are lost now (see the module comment), from its workstations.json
// entry, or null while it can be used (running, or stopped and to be started).
export function lostWhy(entry) {
  if (loginExpired(entry)) return 'its gcloud login needs reauthentication';
  if (entry?.setup?.ok === false) return `its setup failed${entry.setup.error ? `: ${entry.setup.error}` : ''}`;
  if (entry?.['last-error']?.kind === 'timeout' && entry.connected !== true) return `its start timed out${entry['last-error'].message ? `: ${entry['last-error'].message}` : ''}`;   // ASS-481: a cloud VM's
  if (entry?.['last-error'] && entry.connected !== true) return `it could not be reached or started${entry['last-error'].message ? `: ${entry['last-error'].message}` : ''}`;
  return null;
}

// seatCapacity(project) — { mode, vm (its VM seats: project.json's max-tickets-in-progress, Infinity for none, 0 in
// workstation mode), workstations: [{ id, seats (always 1, AC9), lost (lostWhy, or null), kind ('cloud-vm' for a cloud VM,
// ASS-481; none for a workstation) }] in the pool's order, workstations then cloud VMs ([] in vm
// mode), total (the VM seats and one per workstation not lost) }. `project` is loadState's (or the dashboard's alike): json,
// devEnvironments ({ mode, workstations }, null while wrong — read as vm mode) and workstations (the live data).
export function seatCapacity(project) {
  const mode = project?.devEnvironments?.mode ?? 'vm';
  const limit = project?.json?.['max-tickets-in-progress'];
  const vm = MODES_WITH_VMS.has(mode) ? limit ?? Infinity : 0;
  const workstations = MODES_WITH_WORKSTATIONS.has(mode) ? (project.devEnvironments.workstations ?? []).map(w => ({ id: w.id, seats: 1, lost: lostWhy(project.workstations?.[w.id]), ...(w.kind === 'cloud-vm' ? { kind: 'cloud-vm' } : {}) })) : [];
  return { mode, vm, workstations, total: vm + workstations.reduce((sum, w) => sum + (w.lost ? 0 : w.seats), 0) };
}

// seatLimits(project) — its project.json limits as the planner counts them (plan.js planFor): max-tickets-in-progress
// its whole in-progress capacity (seatCapacity's total; null for no limit), the rest as they are.
export function seatLimits(project) {
  const json = project?.json ?? {};
  if ((project?.devEnvironments?.mode ?? 'vm') === 'vm') return json;
  const { total } = seatCapacity(project);
  return { ...json, 'max-tickets-in-progress': Number.isFinite(total) ? total : null };
}

// seatedIn(project) — (ticket, variation) → whether it holds a recorded in-progress seat (the planner keeps those
// seated first: a seat once held is not taken by a higher-ranked ticket, plan.js planDispatch's `seated`).
export function seatedIn(project) {
  const records = project?.seats ?? [];
  if (!records.length) return () => false;
  return (ticket, variation) => Boolean(seatOf(records, ticket.key, variation.name));
}

// keepSeats(records, capacity) — of last tick's `records`, { kept, lost, unseated } (AC5; seats.js runs it before
// the planner, so those taken out hold nothing it keeps seated): `lost` ([{ key, variation, workstation, why }]) each
// whose workstation is lost or no longer listed, or whose kind the mode no longer has; `unseated` ([record]) each over
// its kind's count (VM seats lowered by hand; never two on one workstation), the latest seated first; `kept` the rest.
export function keepSeats(records = [], capacity) {
  const ws = new Map(capacity.workstations.map(w => [w.id, w])), lost = [];
  let kept = [];
  for (const s of records) {
    if (isRemoteSeat(s)) {
      const w = ws.get(s.workstation);
      if (!w || w.lost) { lost.push({ key: s.key, variation: s.variation, workstation: s.workstation, ...(s.kind === 'cloud-vm' ? { kind: 'cloud-vm' } : {}), why: w ? w.lost : `it is no longer one of the project's ${s.kind === 'cloud-vm' ? 'cloud VMs' : 'workstations'}` }); continue; }
      if (s.kind !== remoteSeatKind(w)) { kept.push({ ...s, kind: remoteSeatKind(w) }); continue; }   // ASS-481: an id moved between the two lists
    } else if (s.kind !== 'vm' || capacity.vm <= 0) { lost.push({ key: s.key, variation: s.variation, workstation: null, why: `${capacity.mode} mode has no VM seats` }); continue; }
    kept.push({ ...s });
  }
  const over = (list, count) => list.toSorted((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? ''))).slice(count);
  const unseated = [...over(kept.filter(s => s.kind === 'vm'), capacity.vm), ...capacity.workstations.flatMap(w => over(kept.filter(s => isRemoteSeat(s) && s.workstation === w.id), w.seats))];
  kept = kept.filter(s => !unseated.includes(s));
  return { kept, lost, unseated };
}

// placeSeats({ records, reserved, capacity, midStep, now }) — the seats given out, pure (seats.js runs it each tick
// over keepSeats' kept): `records` the seats held, `reserved` the { key, variation } the planner gives an in-progress
// seat now, in rank order, `capacity` seatCapacity's, `midStep(key, variation)` whether a step of the variation runs
// on its machine now. Returns { records (the new ones, in rank order), left ([record]: no longer in progress), moved
// ([{ key, variation, workstation }]: from a VM seat into a workstation seat), seated ([record]: given a seat) }, by
// these rules, in order:
// 1. One no longer reserved (Done, a detour, set aside, held) leaves its seat.
// 2. AC3: each free workstation seat, in list order, goes to the highest-ranked variation in a VM seat whose step is
//    not running on its machine — it moves between steps, never during one; one mid-step is passed over, and moves
//    at a later tick, once its step has ended, if a workstation seat is still free. The VM seat it leaves is free.
// 3. AC2: each reserved variation with no seat takes a free workstation seat, else a free VM seat; with neither (the
//    planner and these counts briefly apart) it waits for the next tick.
// (keepSeats' rules are applied again first, so a record over a count or on a lost workstation is never kept.)
export function placeSeats({ records = [], reserved = [], capacity, midStep = () => false, now = new Date().toISOString() }) {
  const rank = new Map(reserved.map((r, i) => [`${String(r.key).toUpperCase()} ${r.variation}`, i]));
  const rankOf = s => rank.get(`${String(s.key).toUpperCase()} ${s.variation}`) ?? Infinity;
  const left = [], moved = [], seated = [];
  let { kept } = keepSeats(records, capacity);
  kept = kept.filter(s => (rank.has(`${String(s.key).toUpperCase()} ${s.variation}`) ? true : (left.push(s), false)));
  const used = id => kept.filter(s => isRemoteSeat(s) && s.workstation === id).length;
  const freeWs = () => capacity.workstations.find(w => !w.lost && used(w.id) < w.seats);
  for (const s of kept.filter(x => x.kind === 'vm').toSorted((a, b) => rankOf(a) - rankOf(b))) {
    const w = freeWs();
    if (!w) break;
    if (midStep(s.key, s.variation)) continue;
    Object.assign(s, { kind: remoteSeatKind(w), workstation: w.id, since: now });
    moved.push({ key: s.key, variation: s.variation, workstation: w.id, ...(w.kind === 'cloud-vm' ? { kind: 'cloud-vm' } : {}) });
  }
  for (const r of reserved) {
    if (seatOf(kept, r.key, r.variation)) continue;
    const w = freeWs();
    const record = w ? { key: r.key, variation: r.variation, kind: remoteSeatKind(w), workstation: w.id, since: now }
      : kept.filter(s => s.kind === 'vm').length < capacity.vm ? { key: r.key, variation: r.variation, kind: 'vm', since: now } : null;
    if (!record) continue;
    kept.push(record);
    seated.push(record);
  }
  return { records: kept.toSorted((a, b) => rankOf(a) - rankOf(b)).map(({ key, variation, kind, workstation, since }) => ({ key, variation, kind, ...(REMOTE_SEAT_KINDS.has(kind) ? { workstation } : {}), since })), left, moved, seated };
}

// seatWords(record) — a seat in words for the logs: "a VM seat", "a workstation seat on <id>", "a cloud VM seat on <id>" (ASS-481).
export const seatWords = s => (s?.kind === 'workstation' ? `a workstation seat on ${s.workstation}` : s?.kind === 'cloud-vm' ? `a cloud VM seat on ${s.workstation}` : 'a VM seat');
