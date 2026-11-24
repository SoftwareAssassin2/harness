// ASS-469: a project's in-progress seats come in two kinds, VM seats and
// workstation seats (operator decision, 2026-11-15: "there is a
// VM-seat-count and a workstation-seat-count"). ASS-528: the project's VM
// seats — its seats on the Mac — are the seat budget's (seat-budget.js: its
// seat-budget.json `seats`, from the Mac's memory and CPU and its share; no
// limit while there is none), no longer project.json's
// max-tickets-in-progress, and planning takes them too (one pool); each
// workstation of its dev-environments was exactly one workstation seat (AC9,
// operator 2026-11-16: no `seats` setting) — ASS-529: each remote machine now
// has as many seats as its own memory and CPU allow (remote-seats.js, its
// remote-seats.json: remoteSeats here), several of the project's tickets on
// it at once, each in a folder of its own there. vm mode has VM seats alone; workstation
// mode workstation seats alone; vm+workstation both. The project's
// capacity (what plan.js planFor grants) is its VM seats plus the
// number of its workstations that can be used: a workstation whose gcloud
// login lapsed, whose setup failed, or whose last connect failed
// (unreachable, or it would not start) has its seats lost while that lasts
// (no bound seats); one that could not be reached or started has its connect retried by control meanwhile, needed
// or not (ASS-502: unreachable), so it comes back by itself. One merely stopped — its own 30-minute idle stop — keeps
// its seats: a ticket taking one has it started at once (workstations.js).
//
// Which variation holds which seat is control's live data,
// data/projects/<p>/seats.json (seats.js writes it each tick, atomically):
// { seats: [{ key, variation, kind: 'vm' } | { key, variation, kind:
// 'workstation', workstation: <id> }, each with since], planning: [{ key,
// variation, since }] } — ASS-528: the planning seat holders too, so the
// planner keeps everyone seated ahead of the rest in its one pool (a planning
// seat is a VM seat on the Mac, in workstation mode a remote one).
//
// ASS-481: a workstation seat is one kind of remote seat; a cloud VM of the
// project's dev-environments (its pool, after its workstations) is a remote
// seat too (one before ASS-529; as many as it carries since), of kind 'cloud-vm' ({ key, variation, kind:
// 'cloud-vm', workstation: <its id>, since }), treated as a workstation seat
// in every rule here: preferred over VM seats, lost while its VM can't be
// used (lostWhy: also a start or SSH wait that timed out), filled again once
// it can; free remote seats filled in the pool's order — workstations
// first, then cloud VMs (ASS-529: a machine is filled up to its seats before
// the next is used, so the others stay idle and stop themselves). Its own idle stop (60 minutes) keeps its seat as a
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
export const MODES_WITH_VMS = new Set(['vm', 'vm+workstation']), MODES_WITH_WORKSTATIONS = new Set(['workstation', 'vm+workstation']);

// loadSeats(projectDir, read, list) — its seats.json's records, [] without one; one caught half-written reads as []
// (the next tick writes it whole). `read`: readJson, or loadState's readJsonCached (ASS-495). `list`: 'seats' (the
// in-progress seats), or 'planning' (ASS-528: the planning seat holders).
export function loadSeats(projectDir, read = readJson, list = 'seats') {
  try {
    const file = join(projectDir, SEATS_FILE);
    return existsSync(file) ? read(file)?.[list] ?? [] : [];
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

// unreachable(entry) — ASS-502: its seats are lost for lostWhy's last-error cases alone (it could not be reached or
// started, or its start timed out) — not an expired login (the operator's to renew), not a failed setup (retried while
// connected). Control's workstation job retries such a machine's connect even while nothing needs it, so it comes
// back by itself once the cause is gone.
export const unreachable = entry => Boolean(entry?.['last-error']) && entry.connected !== true && !loginExpired(entry) && entry.setup?.ok !== false;

// macSeats(project) — ASS-528: the seats it may hold on the Mac now, its seat budget's (seat-budget.js, its
// seat-budget.json loaded as project.seatBudget): Infinity while it has none (no reading of the Mac, or none yet).
export const macSeats = project => {
  const seats = project?.seatBudget?.seats;
  return typeof seats === 'number' && Number.isFinite(seats) ? Math.max(0, seats) : Infinity;
};

// remoteSeats(project, id) — ASS-529: the seats remote machine `id` may hold now, its remote-seats.json's (remote-seats.js:
// as many tickets as its own memory and CPU allow), 1 while it has none (no reading phase yet: one each, as before).
export const remoteSeats = (project, id) => {
  const seats = project?.remoteBudget?.[id]?.seats;
  return typeof seats === 'number' && Number.isFinite(seats) ? Math.max(0, seats) : 1;
};

// seatCapacity(project) — { mode, vm (its VM seats: ASS-528 the seat budget's, macSeats — Infinity for none; 0 in
// workstation mode), workstations: [{ id, seats (ASS-529: remoteSeats, from its own memory and CPU; was always 1, AC9), lost (lostWhy, or null), kind ('cloud-vm' for a cloud VM,
// ASS-481; none for a workstation) }] in the pool's order, workstations then cloud VMs ([] in vm
// mode), remote (how many of those are not lost), total (the VM seats and one per workstation not lost) }. `project` is
// loadState's (or the dashboard's alike): seatBudget, devEnvironments ({ mode, workstations }, null while wrong — read
// as vm mode) and workstations (the live data).
export function seatCapacity(project) {
  const mode = project?.devEnvironments?.mode ?? 'vm';
  const vm = MODES_WITH_VMS.has(mode) ? macSeats(project) : 0;
  // ASS-553 AC7: a machine not up within remote-boot-wait-seconds of a step being placed on it is lost too while that
  // lasts (seats.js bootWaits: project.bootWaitOver).
  // ASS-564: a machine where Claude Code's sandbox can't run keeps its seats for the worktree targets too (its worktree
  // agents run unsandboxed: dispatch.js agentSandbox), so nothing here asks about the sandbox (ASS-555's noSandbox gone).
  const workstations = MODES_WITH_WORKSTATIONS.has(mode) ? (project.devEnvironments.workstations ?? []).map(w => ({ id: w.id, seats: remoteSeats(project, w.id), lost: lostWhy(project.workstations?.[w.id]) ?? project.bootWaitOver?.[w.id] ?? null, ...(w.kind === 'cloud-vm' ? { kind: 'cloud-vm' } : {}) })) : [];
  const remote = workstations.reduce((sum, w) => sum + (w.lost ? 0 : w.seats), 0);
  // ASS-540: the remote seats by kind, so a step's run targets can ask for a workstation's or a cloud VM's.
  const byKind = { workstation: 0, 'cloud-vm': 0 };
  for (const w of workstations) if (!w.lost) byKind[w.kind === 'cloud-vm' ? 'cloud-vm' : 'workstation'] += w.seats;
  return { mode, vm, workstations, remote, byKind, total: vm + remote };
}

// seatedIn(project) — (ticket, variation) → its recorded seat (seats.json: an in-progress seat record, or ASS-528 a
// planning one, { key, variation, pool: 'planning', since }), or false: the planner keeps those seated first (a seat
// once held is not taken by a higher-ranked ticket, plan.js planDispatch's `seated`).
// ASS-540: or a Mac target's record (seats.json's `local` list: { key, variation, target, since }), as { …, pool:
// 'local' } — no seat, but a local-workspace holder keeps the workspace ahead of the rest.
export function seatedIn(project) {
  const records = project?.seats ?? [], planning = project?.planningSeats ?? [], local = project?.localSeats ?? [];
  if (!records.length && !planning.length && !local.length) return () => false;
  return (ticket, variation) => {
    const seat = seatOf(records, ticket.key, variation.name);
    if (seat) return seat;
    const p = seatOf(planning, ticket.key, variation.name);
    if (p) return { ...p, pool: 'planning' };
    const l = seatOf(local, ticket.key, variation.name);
    return l ? { ...l, pool: 'local' } : false;
  };
}

// targetOf(project, key, variation) — ASS-540: the run target the variation holds now, as this tick's seats say: its
// seat record's (seats.json `target`, or by its kind), its planning record's, or its Mac target (`local`); null with none.
export function targetOf(project, key, variation) {
  const seat = seatOf(project?.seats ?? [], key, variation) ?? seatOf(project?.planningSeats ?? [], key, variation);
  if (seat) return seat.target ?? (seat.kind ? ({ vm: 'local-vm', workstation: 'workstation', 'cloud-vm': 'cloud-vm' })[seat.kind] : null) ?? null;
  return seatOf(project?.localSeats ?? [], key, variation)?.target ?? null;
}
// onMacTarget(project, key, variation) — the variation runs on local-worktree or local-workspace now.
export const onMacTarget = (project, key, variation) => ['local-worktree', 'local-workspace'].includes(targetOf(project, key, variation));
// onRemoteWorktree(project, key, variation) — ASS-553: the variation runs on workstation-worktree or cloud-vm-worktree
// now: its steps claim its seat's machine in a folder of its own kept for it (workstation:claim --worktree).
export const onRemoteWorktree = (project, key, variation) => ['workstation-worktree', 'cloud-vm-worktree'].includes(targetOf(project, key, variation));
// onSubstrateTarget(project, key, variation) — ASS-535: the variation runs on a substrate run target now (its step in its
// Substrate sandbox, sandboxes.js), not in its VM nor on a workstation's or cloud VM's folder.
export const onSubstrateTarget = (project, key, variation) => ['local-substrate', 'workstation-substrate', 'cloud-vm-substrate'].includes(targetOf(project, key, variation));

// keepSeats(records, capacity) — of last tick's `records`, { kept, lost, unseated } (AC5; seats.js runs it before
// the planner, so those taken out hold nothing it keeps seated): `lost` ([{ key, variation, workstation, why }]) each
// whose workstation is lost or no longer listed, or whose kind the mode no longer has; `unseated` ([record]) each over
// its kind's count (VM seats lowered; a remote machine's seats never fall below those it holds, remote-seats.js), the latest seated first; `kept` the rest.
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
export function placeSeats({ records = [], reserved = [], capacity, midStep = () => false, now = new Date().toISOString(), targetFor = () => null }) {
  const rank = new Map(reserved.map((r, i) => [`${String(r.key).toUpperCase()} ${r.variation}`, i]));
  const rankOf = s => rank.get(`${String(s.key).toUpperCase()} ${s.variation}`) ?? Infinity;
  const left = [], moved = [], seated = [];
  let { kept } = keepSeats(records, capacity);
  kept = kept.filter(s => (rank.has(`${String(s.key).toUpperCase()} ${s.variation}`) ? true : (left.push(s), false)));
  const freeWs = (kind, prefer) => freeMachine(capacity, kept, kind, prefer) ?? undefined;
  // ASS-553: the worktree targets on a workstation or a cloud VM take that machine's seat, as its plain target does.
  const targetKind = t => (t === 'local-vm' || t === 'local-substrate' ? 'vm' : t === 'workstation' || t === 'workstation-substrate' || t === 'workstation-worktree' ? 'workstation' : t === 'cloud-vm' || t === 'cloud-vm-substrate' || t === 'cloud-vm-worktree' ? 'cloud-vm' : null);
  // ASS-540: one whose planned target (targetFor: plan.js targets) is a seat of another kind than its record's moves
  // to it between its steps (never mid-step), when one is free; else it keeps its seat.
  for (const s of kept.toSorted((a, b) => rankOf(a) - rankOf(b))) {
    const plan = targetFor(s.key, s.variation), kind = targetKind(plan?.target);
    if (!kind) continue;
    if (kind === s.kind) { s.target = plan.target; continue; }
    if (midStep(s.key, s.variation)) continue;
    if (kind === 'vm') {
      if (kept.filter(x => x.kind === 'vm').length >= capacity.vm) continue;
      Object.assign(s, { kind: 'vm', since: now, target: plan.target });
      delete s.workstation;
      moved.push({ key: s.key, variation: s.variation, workstation: null, kind: 'vm' });
      continue;
    }
    const w = freeWs(kind, plan.machine);
    if (!w) continue;
    Object.assign(s, { kind: remoteSeatKind(w), workstation: w.id, since: now, target: plan.target });
    moved.push({ key: s.key, variation: s.variation, workstation: w.id, ...(w.kind === 'cloud-vm' ? { kind: 'cloud-vm' } : {}) });
  }
  for (const s of kept.filter(x => x.kind === 'vm').toSorted((a, b) => rankOf(a) - rankOf(b))) {
    const plan = targetFor(s.key, s.variation);
    // ASS-540: only toward a remote target its step ranks ahead of the local VM (with none planned, as before).
    const remoteFirst = plan?.candidates ? plan.candidates.findIndex(t => ['workstation', 'cloud-vm'].includes(targetKind(t))) : 0;
    if (remoteFirst < 0 || (plan?.candidates && remoteFirst > plan.candidates.indexOf(plan.target))) continue;
    const kind = plan?.candidates ? targetKind(plan.candidates[remoteFirst]) : undefined;
    const w = freeWs(kind);
    if (!w) continue;
    if (midStep(s.key, s.variation)) continue;
    Object.assign(s, { kind: remoteSeatKind(w), workstation: w.id, since: now, ...(plan?.candidates ? { target: plan.candidates[remoteFirst] } : {}) });
    moved.push({ key: s.key, variation: s.variation, workstation: w.id, ...(w.kind === 'cloud-vm' ? { kind: 'cloud-vm' } : {}) });
  }
  for (const r of reserved) {
    if (seatOf(kept, r.key, r.variation)) continue;
    // ASS-540: its planned target's kind of seat; that one taken meanwhile (a move above), the next of its candidates
    // with a free seat, in order — as the planner counted it, one seat of the pool.
    const plan = targetFor(r.key, r.variation);
    const order = plan?.target ? [plan.target, ...(plan.candidates ?? []).filter(t => t !== plan.target)] : [null];
    let record = null;
    for (const t of order) {
      const kind = targetKind(t);
      if (t && !kind) continue;   // a Mac target: no seat
      const w = kind === 'vm' ? null : freeWs(kind ?? undefined, t === plan?.target ? plan?.machine : undefined);
      const vmFree = kept.filter(s => s.kind === 'vm').length < capacity.vm;
      record = w ? { key: r.key, variation: r.variation, kind: remoteSeatKind(w), workstation: w.id, since: now }
        : (kind == null || kind === 'vm') && vmFree ? { key: r.key, variation: r.variation, kind: 'vm', since: now } : null;
      if (record) { if (t) record.target = t; break; }
    }
    if (!record) continue;
    kept.push(record);
    seated.push(record);
  }
  return { records: kept.toSorted((a, b) => rankOf(a) - rankOf(b)).map(({ key, variation, kind, workstation, since, target }) => ({ key, variation, kind, ...(REMOTE_SEAT_KINDS.has(kind) ? { workstation } : {}), ...(target ? { target } : {}), since })), left, moved, seated };
}

// freeMachine(capacity, records, kind, prefer) — the first usable remote machine of seatCapacity's `capacity` with a seat
// free by `records` (seat records: those on it counted) — of `kind`, 'workstation' or 'cloud-vm', when given (ASS-540)
// — or null. ASS-553: `prefer`, the machine the planner picked by pool choice (most-room: plan.js `machine`), when it
// still has one. placeSeats places by it; ASS-572: plan.js seatsOf names the next ticket's machine by it.
export function freeMachine(capacity, records = [], kind, prefer) {
  const used = id => records.filter(s => isRemoteSeat(s) && s.workstation === id).length;
  const ok = w => !w.lost && used(w.id) < w.seats && (!kind || remoteSeatKind(w) === kind);
  return (prefer && capacity.workstations.find(w => w.id === prefer && ok(w))) || capacity.workstations.find(ok) || null;
}

// seatWords(record) — a seat in words for the logs: "a VM seat", "a workstation seat on <id>", "a cloud VM seat on <id>" (ASS-481).
export const seatWords = s => (s?.kind === 'workstation' ? `a workstation seat on ${s.workstation}` : s?.kind === 'cloud-vm' ? `a cloud VM seat on ${s.workstation}` : 'a VM seat');
