// Planning which sprint ticket variations get an agent on this tick, which
// may move into a step (the ticket limits, ASS-126), and whether a triggered
// engine may start. Pure: nothing is dispatched or moved here. A variation
// its dependencies hold (dependencies.js, ASS-355) is planned as a paused one
// is: no slot, no seat, no agent — its slot free for the next ticket.
//
// A finished plan holds no seat (ASS-362): a variation whose top-level
// planning step's sub-engine has reached its is-done step (grouped Plan at
// done; engine.js finishedPlanning, statusOf's `planned`) only waits for an
// in-progress seat to move on to Build. It holds neither a planning seat —
// so the next ticket at committed may start planning — nor an in-progress
// one; it is `ready`, and its VM is stopped while it waits (vm-lifecycle.js,
// as for one waiting for a slot, ASS-233). The ready form a queue in rank
// order: control moves the sprint's variations highest-ranked first
// (steps.js), so a freed in-progress seat goes to the highest-ranked ready
// one (mayEnter), never a lower-ranked one ahead of it. A planning step at a
// gate or a human step, a plan sent back for revision, Requirements Changed
// and any planning step not done keep their seat as before. The optional
// max-tickets-ready-for-build (harness.json, every project's together, and
// project.json, its own; unset for no limit) caps the queue: while the ready
// and those still planning (who will join it) reach it, no ticket enters
// planning (free.planning false; steps.js says so once at committed).
//
// A variation whose VM is held for want of the Mac's memory (ASS-404:
// host-memory.js, its project's memory-hold.json `held`) holds no seat
// either, planning or in progress, while it waits: it is `memoryHeld`, its VM
// not started (vm-lifecycle.js, as for one waiting for a slot), and its seat
// goes to the next in rank order. Once its VM can start (the hold lifted) it
// takes a seat again as any variation in motion does, highest-ranked first —
// at the step it waited at, nothing re-run, no visit spent.
//
// ASS-420: a seat is given only when the variation's VM fits in the Mac's
// memory (seat-memory.js): one whose next steps need a VM that is not running
// and does not fit is refused the seat — its project's memory-wait.json
// `waiting`, `memoryWaiting` here — and holds none, planning or in progress,
// waiting as for a slot (its VM not started, no move, no visit spent) while
// the next in rank order may take it; it is weighed again every tick. This
// replaces ASS-404's rule that, while the hold is on, a freed seat went only
// to a variation whose VM is up; the memory hold stays as the safety net on
// VM starts.
//
// ASS-527: a variation holds a seat only while its current step uses its
// machine (machine-steps.js usesMachine: an AI step, or a script step
// declared as running in the machine — the deepest step of its status, so a
// Build whose run is at a host-only script holds none). At any other step —
// a host-only script, a wait, a gate or a human step (ASS-203's rule that a
// gate kept its seat is gone), a step its gate-when-leaving-state holds — it
// holds none, planning or in progress, the seat free for the next in rank
// order that the same tick (the planner reads the live data), and its VM is
// stopped (vm-lifecycle.js). Which pool a position belongs to (poolOf: the
// planning or the in-progress seats, by position as before) is apart from
// whether it takes a seat now (slotKind). A variation in that work already
// moves into any step without a free seat (mayEnter; ASS-522's return from
// Blocked generalised) and, at a step that needs one, waits there (planDispatch
// `waiting`: no agent, script or run step) until it takes the next free seat
// in rank order. Only starting work from the queue (committed into planning)
// and a finished plan going on to Build (ASS-362's ready queue) still need a
// free seat to move, so the queues stay where they are.
//
// ASS-528: the seats are no longer counts in project.json and harness.json
// (max-tickets-in-progress, max-tickets-in-planning: no longer read) but one
// pool per project, planning and building alike, taken in control's rank
// order (those holding a recorded seat first): its seats on the Mac, the seat
// budget's (seat-budget.js — from the Mac's memory and CPU and the project's
// share of them; no limit while there is none), and one per usable remote
// machine (seat-kinds.js seatCapacity). A planning holder takes a Mac seat (a
// remote one in workstation mode, where the project has none on the Mac); one
// in progress takes a remote seat first, else a Mac seat. Machines are never
// shared, so no project counts another's seats: the Mac is shared through the
// seat budget alone. The pools by position (poolOf: planning, progress) stay,
// for the queues and the dashboard.
//
// ASS-531: the focus-on-planning switch (planning-focus-file.js; project:set-planning-focus, the sprint screen's P).
// While a project's is on, every variation of it at a planning step (atPlanningStep: in planning, or at the queue that
// starts it — committed) ranks ahead of every other when the seats are given and the agents dispatched, rank order
// within each group (rank.js planningFirst): planDispatch gives the free seats to those in planning before those in
// progress, works out whether one may enter planning (free.planning) as though only those in planning were waiting, and
// dispatches their agents first; sprintOrder puts them first where control walks the sprint (steps.js moves, the seat
// queue, the memory walk), dispatch.js their runs. Nothing running is cut off: a seat already recorded is still kept
// ahead of the rest, in plain rank order. max-tickets-ready-for-build does not hold planning back while it is on
// (readyFull false). Off, every order here is rankSprint's, exactly as before.
import { heldBy } from './dependencies.js';
import { memoryHeldIn } from './host-memory.js';
import { isBlockedState, isDoneStep, waitsOnHuman, humanWaits, statusIn, inPlanning, stepOf, isHeld, isActive } from './engine.js';
import { usesMachine } from './machine-steps.js';
import { rankSprint, planningFirst } from './rank.js';
//
// ASS-540: run targets (run-targets.js). A variation at a step that takes a seat (slotKind) runs on one of the step's
// candidates — its own run-targets filtered to the project's, in the step's order, or the project's — and takes the
// first with a free seat now, else waits (`waiting`); with none at all (its list and the project's share nothing) it
// is never started (`refused`, also `waiting`; control logs the project's run-target errors once). A seat already
// held is kept ahead of the rest, on its own target while the step still allows it. The Mac targets, local-worktree
// and local-workspace, take no seat (`local`): any number of local-worktree holders, one local-workspace holder per
// project. Every holder's target is in `targets`; seats.js records them (seats.json `target`, and its `local` list).
import { planningFocusOn } from './planning-focus-file.js';
import { overSpent } from './spend.js';
import { seatCapacity, seatedIn, freeMachine } from './seat-kinds.js';
import { candidates, projectRunTargets, seatKindOf, isMacTarget, targetOfSeat, MODE_TARGETS, HOST_OF, poolChoiceOf } from './run-targets.js';
import { headroomOf, mostRoom } from './pool-choice.js';
import { workModeOf, skipsForStack } from './work-mode.js';
//
// ASS-553: pool choice (run-targets.js poolChoiceOf, pool-choice.js). A holder taking a seat anew whose step (or project)
// chooses `most-room` takes, of its candidates with a free seat, the one with the most headroom now (`headroom`, planFor:
// pool-choice.js headroomOf — the Mac's and each machine's room in tickets), ties in list order; `remote-first` (the
// default for worktree targets) a remote machine's while one has a free seat, the most room among them, the Mac's
// only when none has; `first` (the default otherwise) takes the first, as before. A seat already held is kept either
// way. Its `targets` entry then carries `choice`, the `machine` picked for a remote target, and `rooms` (each candidate
// rated), which seats.js places by and logs once.

// memoryWaitIn(project) — ASS-420: whether a variation of the project was
// refused a seat for want of memory for its VM, by its memory-wait.json
// (state.js memoryWait), (ticket, variation) → bool.
export const memoryWaitIn = project => {
  const waiting = project?.memoryWait?.waiting;
  if (!Array.isArray(waiting) || !waiting.length) return () => false;
  return (ticket, variation) => waiting.some(w => w.key === ticket.key && w.variation === variation.name);
};

// atPlanningStep(status) — ASS-531: the variation (its statusIn) is at a planning step for the focus-on-planning switch:
// in the planning pool (poolOf 'planning': planning, seated or not, at a planning gate too), or at the queue's step
// that starts planning (a planning `none` step: committed) — never a finished plan (ready for build), Blocked or a
// step past planning.
export function atPlanningStep(status) {
  const step = status?.step;
  if (!step || status.planned === true) return false;
  if (step['is-planning-stage'] === true && step.action?.type === 'none' && isActive(step)) return true;
  return poolOf(step, status) === 'planning';
}

// sprintOrder(state, project) — ASS-531: the project's sprint variations, [{ ticket, variation }], in the order control
// walks them (steps.js moves, seat-queue.js, seat-memory.js): rankSprint's, ticket by ticket; with its focus-on-planning
// switch on, those at a planning step (atPlanningStep) ahead of the rest, each group in that order.
export function sprintOrder(state, project) {
  const pairs = rankSprint(project.tickets ?? [], { engine: project.engine }).flatMap(ticket => (ticket.variations ?? []).map(variation => ({ ticket, variation })));
  if (!planningFocusOn(project) || !project.engine) return pairs;
  const engines = project.engines ?? state.engines ?? {};
  return planningFirst(pairs, ({ variation }) => atPlanningStep(statusIn(project.engine, variation, engines)));
}

// The cap on the ready queue, the planned waiting for a build seat (ASS-362).
export const READY_LIMIT = 'max-tickets-ready-for-build';

// poolOf(step, status) — the pool of seats a variation at top-level `step` belongs to, by position:
// none (null) in the queue (a planning step no agent works: backlog,
// committed), at a detour it returns from (follow-return-to-state: Blocked,
// Blocked for Human), a switched-off one (isActive, ASS-192: passed at once), done, or
// a planning step whose plan is finished (status.planned, ASS-362: ready for build); else 'planning' when in
// planning (inPlanning over its `status`, statusOf: inside a sub-engine the
// deepest step that says, falling back up to `step`), else 'progress'. (ASS-527: slotKind before it; whether the
// variation takes a seat of it now is slotKind's.)
export function poolOf(step, status = { chain: [{ step }] }) {
  if (!step || !isActive(step) || step['is-done'] === true || step['is-blocked-state'] === true || step['follow-return-to-state'] === true) return null;
  if (step['is-planning-stage'] === true && step.action?.type === 'none') return null;
  if (status.planned === true) return null;
  return inPlanning(status) ? 'planning' : 'progress';
}

// slotKind(step, status, variation) — the seat a variation at top-level `step` takes now (ASS-527): its pool's
// (poolOf) while its current step uses its machine (machineStep), else none — a host-only script, a wait, a gate or
// a human step (ASS-203's seat at a gate is gone), or, given the `variation`, a step it waits at on a human
// (humanWaits: its gate-when-leaving-state, its work there done).
export function slotKind(step, status = { chain: [{ step }] }, variation) {
  const pool = poolOf(step, status);
  if (pool == null || !machineStep(status, variation)) return null;
  if (variation && humanWaits(status.chain ?? [], variation)) return null;
  return pool;
}

// machineStep(status) — the variation's current step uses its machine (machine-steps.js usesMachine): the deepest
// step of its status (statusOf's chain). A state-engine step whose run has not started (no deeper level) is judged by
// the step its run will start at (statusOf's entryStep), none when not known; a deeper step its engines do not hold
// (not loaded), or one with no action at all, counts as one that does, as before ASS-527.
// ASS-556: a step the variation's work mode skips (work-mode.js skipsForStack: `stack: required` in worktree mode) uses none.
function machineStep(status, variation) {
  const chain = status?.chain ?? [];
  const deep = chain.at(-1);
  if (!deep) return false;
  if (deep.step == null) return chain.length > 1;
  if (!deep.step.action) return true;   // no action at all (no engine validation passes): as before ASS-527
  const judged = deep.step.action.type === 'state-engine' ? status.entryStep : deep.step;
  if (variation && skipsForStack(judged, variation)) return false;
  return usesMachine(judged);
}

// judgedStep(status) — ASS-540: the step whose run-targets decide where the variation runs now: the deepest of its
// status, or for a state-engine step whose run has not started, the step its run starts at (as machineStep judges).
export function judgedStep(status) {
  const deep = status?.chain?.at(-1)?.step;
  return deep?.action?.type === 'state-engine' ? status.entryStep : deep;
}

// planDispatch({ ranked, engine, engines, assignments, transient, harness, project, seats, planningRemote,
// agentsRunning, projectAgentsRunning, readyElsewhere, planningPoolElsewhere, planningFocus })
// — `ranked`: one project's sprint tickets in rank order (see rankSprint),
// each with its variations; `engine`: its execution state engine, and
// `engines` the engines beneath it ({ [name]: its JSON }; none, the top
// level alone); `assignments`: its assignments.json records, one occupying a variation when
// its work-item matches and its variation does or is null; `harness` and
// `project`: { max-agents, max-tickets-ready-for-build } from
// harness.json (every project together) and the project's project.json (it
// alone), null or missing for no limit, 0 for none — a dispatch must fit both;
// `seats` (ASS-528): { mac, remote }, the project's one pool — its seats on the Mac (the seat budget's; Infinity for
// no limit) and its usable remote machines' (one each) — and `planningRemote` whether a planning holder takes a remote
// seat (workstation mode) rather than a Mac seat;
// `agentsRunning`: agent processes alive now, of every kind and project, and
// `projectAgentsRunning` this project's; `readyElsewhere` the variations other projects have ready for build
// (ASS-362), `planningPoolElsewhere` those they have in planning seated or not (ASS-527: for
// max-tickets-ready-for-build); `harness` and `project`
// also give a ticket its spending limit (spend.js, ASS-191), and `running`,
// { <work-item>: usd }, what its running agents have spent so far toward it
// (ASS-270: spend.js runningSpend's for the project); `asking`, the
// keys of the tickets an open blocking question holds (state.js, ASS-248); `waitsOn(ticket,
// variation)`, whether its dependencies hold it (dependencies.js heldBy, ASS-355); `memoryHeld(ticket,
// variation)`, whether its VM is held for memory (ASS-404: host-memory.js memoryHeldIn); `memoryWaits(ticket, variation)`,
// whether it was refused a seat for want of memory for its VM (ASS-420: memoryWaitIn); `seated(ticket, variation)`,
// its recorded seat or false (ASS-469, ASS-528: seats.js, seat-kinds.js seatedIn — a planning or an in-progress seat,
// kept ahead of the rest, see below); `planningFocus` (ASS-531) the project's focus-on-planning switch: on, those at a
// planning step (atPlanningStep) are seated and dispatched before the rest and readyFull is false. (`transient` is taken
// for the record; triggered engines count through agentsRunning.) Returns
// { dispatch, reserved, planning, inPlanning, ready, readyFull, waiting, memoryHeld, memoryWaiting, entering, held, short, free,
// onMac, seats, freeSeats }: `dispatch`, in rank order, each
// { key, variation, state, agentCount, planning } to put agents on;
// `reserved`, the { key, variation } holding in-progress seats, in rank
// order; `planning`, how many hold planning seats, and `inPlanning` which; `planningPool` (ASS-527), how many are
// in planning, seated or not;
// `ready`, the { key, variation } whose plan is finished (ASS-362: no seat, its
// VM stopped), in rank order — the queue for Build; `readyFull`, whether
// max-tickets-ready-for-build is reached by those and the ones in planning (planningPool);
// `waiting`, the { key, variation } in motion but holding no seat, the pool full (ASS-233: no VM runs for one);
// `memoryHeld`, the { key, variation } at a step that takes a seat whose VM is held for memory (ASS-404: no seat, no agent);
// `memoryWaiting`, those at such a step refused a seat for want of memory for their VMs (ASS-420: no seat, no agent);
// `entering`, ASS-525: the { key, variation } not yet started — at the queue (a planning step no agent works,
// committed), in motion otherwise — in rank order, who take a free seat after `waiting`'s (seat-queue.js);
// `short`, the { key, variation } a dispatch was skipped for, max-agents full; `held`, each { key, variation,
// state-engine, state } whose step inside a sub-engine may not have an agent
// now; `free`, { planning, progress }: whether a variation holding none could
// take a seat for each (mayEnter) — planning only while readyFull is not; `onMac` (ASS-528), the { key, variation,
// seated } holding a Mac seat (seat-budget.js counts demand and use by it); `seats`, { mac, remote, used: { mac,
// remote } }; `freeSeats`, how many seats of the pool are left (Infinity for no limit).
// A variation is in motion — holds a seat of its step's pool (slotKind), the
// first ones in rank order up to the pool's seats (those `seated` first,
// ASS-469, ASS-528) — unless deleted, held (paused,
// it or its ticket, or worked by hand: isHeld), its ticket waiting on the
// operator for an answer (`asking`: no seat, as paused), held by its
// dependencies (`waitsOn`, ASS-355: no slot or seat, as paused), its ticket at its spending limit (overSpent: steps.js
// takes it to Blocked for Human), done, in the blocked state, waiting on
// the outside at a `none` step past planning (one with no always or
// agent-needs-work exit, such as QA Testing waiting on the ticket system), or
// at a step that takes none. ASS-527: it takes its slot only while its current
// step uses its machine (slotKind) — waiting on a human (a gate or a human
// step), at a host-only script or a wait, it holds none (ASS-203's rule that
// it kept its slot is gone). It needs an agent when, not waiting, its step's
// action is a prompt, switched on (isActive, ASS-192), and no assignment is on it; it gets one when it holds its
// slot, or its step takes none (Blocked's run). A dispatch whose whole agent-count
// (default 1) would take the agents past max-agents is skipped, and the walk goes on.
// Inside a sub-engine (ASS-67) the variation's detailed step (statusOf) is
// the one that waits on a human or the outside and that needs an agent; its
// run's agents go out with the run (dispatch.js), so it is not dispatched
// here, but it is `held` when it could not be — no slot — or it waits on a human.
export function planDispatch({ ranked, engine, engines = {}, assignments = [], harness = {}, project = {}, seats = { mac: Infinity, remote: 0 }, planningRemote = false, agentsRunning = 0, projectAgentsRunning = 0, readyElsewhere = 0, planningPoolElsewhere = 0, asking = new Map(), running = {}, waitsOn = () => false, memoryHeld = () => false, memoryWaits = () => false, seated = () => false, planningFocus = false, runTargets, headroom = null }) {
  const all = name => harness[name] ?? Infinity, own = name => project[name] ?? Infinity;
  const occupied = (key, name) => assignments.some(a => a['work-item'] === key && (a.variation == null || a.variation === name));
  const slots = { planning: [], progress: [] };
  const mac = seats.mac ?? Infinity, remote = seats.remote ?? 0, used = { mac: 0, remote: 0, workstation: 0, 'cloud-vm': 0, workspace: 0 };
  // ASS-540: the project's run targets — given (planFor: projectRunTargets of its project.json), else as the seats it
  // has stand (workstation mode when a planning holder takes a remote seat; remote seats first when it has any).
  const rt = runTargets ?? { targets: MODE_TARGETS[planningRemote ? 'workstation' : remote > 0 ? 'vm+workstation' : 'vm'], derived: true, mode: planningRemote ? 'workstation' : remote > 0 ? 'vm+workstation' : 'vm', docker: new Set() };
  // room(target, taken) — the target has a seat free (or, on the Mac, room): a Mac seat for local-vm and
  // local-substrate; a remote one of its kind (seats.byKind, when given; the remote seats, shared, in any case) for
  // the others; local-worktree always; local-workspace while no one holds it.
  const room = (t, taken) => {
    const kind = seatKindOf(t);
    if (kind == null) return t !== 'local-workspace' || taken.workspace < 1;
    if (kind === 'vm') return taken.mac < mac;
    return taken.remote < remote && taken[kind] < (seats.byKind?.[kind] ?? remote);
  };
  // seatFor(targets, record, taken) — the target a holder takes now, of its candidates `targets` in order, or null with
  // none free: its recorded seat's target first while the step still allows it and it is free (a seat held is kept).
  const seatFor = (targets, record, taken = used) => {
    const held = record ? targetOfSeat(record) : null;
    if (held && targets.includes(held) && room(held, taken)) return held;
    return targets.find(t => room(t, taken)) ?? null;
  };
  // ASS-553: choose(targets, record, choice) — seatFor's pick, or, with `most-room` (and a headroom to read), the
  // candidate with a free seat and the most room now; { target, machine?, rooms? } (target null with none free).
  const placedNow = new Map();
  // remote-first: the remote candidates with a free seat first, the one with the most room among them; with none, the
  // Mac's in list order.
  const choose = (targets, record, choice) => {
    const held = record ? targetOfSeat(record) : null;
    if (choice === 'first' || !headroom || (held && targets.includes(held) && room(held, used))) return { target: seatFor(targets, record) };
    const rated = targets.filter(t => room(t, used)).map(t => ({ target: t, ...headroom(t, placedNow) }));
    const remote = rated.filter(r => HOST_OF[r.target] !== 'local');
    const best = choice === 'remote-first' ? (remote.length ? mostRoom(remote) : rated[0] ?? null) : mostRoom(rated);
    if (!best) return { target: null };
    const host = HOST_OF[best.target] === 'local' ? 'mac' : best.machine;
    if (host) placedNow.set(host, (placedNow.get(host) ?? 0) + 1);
    return { target: best.target, ...(best.machine ? { machine: best.machine } : {}), rooms: rated, choice };
  };
  const take = (t, taken = used) => { const kind = seatKindOf(t); if (kind === 'vm') taken.mac++; else if (kind) { taken.remote++; taken[kind]++; } else if (t === 'local-workspace') taken.workspace++; };
  let agents = agentsRunning, projectAgents = projectAgentsRunning;
  const dispatch = [], held = [], short = [], waiting = [], ready = [], memory = [], memoryWaiting = [], entering = [], onMac = [], refused = [], local = [], targets = [];
  // The variations in motion, in rank order, each with the slot kind its step takes.
  const moving = [];
  for (const t of ranked) for (const v of overSpent(t, harness, project, running[t.key] ?? 0) ? [] : t.variations ?? []) {
    const status = statusIn(engine, v, engines), { step } = status;
    if (!step || v['is-deleted'] || isHeld(t, v) || asking.has(t.key) || isDoneStep(engine, status.state) || isBlockedState(engine, status.state) || waitsOn(t, v)) continue;
    const at = status.detailStep ?? step;
    if (at['is-done'] !== true && waitsOutside(at)) continue;   // a run done: its group step is about to move on
    const kind = slotKind(step, status, v);   // ASS-527: none unless its current step uses its machine
    if (kind != null && memoryHeld(t, v)) { memory.push({ key: t.key, variation: v.name }); continue; }   // ASS-404: its VM held for memory — no seat, no agent
    if (kind != null && memoryWaits(t, v)) { memoryWaiting.push({ key: t.key, variation: v.name }); continue; }   // ASS-420: refused a seat, its VM not fitting — no seat, no agent
    const can = kind != null ? candidates(judgedStep(status), rt, kind, workModeOf(v)) : [];   // ASS-540: where its step may run; ASS-556: in its work mode
    moving.push({ t, v, status, kind, at, pool: poolOf(step, status), record: kind != null ? seated(t, v) : false, can, choice: poolChoiceOf(judgedStep(status), rt, can) });
  }
  // The seats: in rank order — but ASS-469, ASS-528: a seat already recorded (seats.js), planning or in progress, is
  // kept ahead of the rest, so a ticket at work never loses its seat to a higher-ranked one (one pool: not to one
  // coming back from a gate either), and when the seats shrink those taken out of theirs are the ones left waiting.
  // ASS-531: with the focus on planning, those not holding one are seated planning first (`order`), and whether one
  // more may enter planning is judged by the seats left once they are (`planningLeft`), not counting those waiting in
  // progress — so a ticket at committed enters planning ahead of them and takes the next seat. The recorded seats keep
  // plain rank order: nothing running is cut off for planning.
  const order = planningFocus ? planningFirst(moving, m => atPlanningStep(m.status)) : moving;
  const gets = new Set();
  const withSeat = moving.filter(m => m.kind != null && m.record), rest = order.filter(m => m.kind != null && !m.record);
  let planningLeft = null, ahead = 0;
  for (const m of [...withSeat, ...rest]) {
    if (planningFocus && planningLeft == null && !m.record && !atPlanningStep(m.status)) planningLeft = { ...used };
    const picked = choose(m.can, m.record, m.choice), { target } = picked;
    if (!target) continue;
    take(target);
    if (!m.record) ahead++;   // ASS-572: seated anew this pass, ahead of a next ticket
    gets.add(m);
    m.target = target;
    targets.push({ key: m.t.key, variation: m.v.name, target, candidates: m.can, ...(picked.rooms ? { choice: picked.choice, rooms: picked.rooms } : {}), ...(picked.machine ? { machine: picked.machine } : {}) });
    if (isMacTarget(target)) local.push({ key: m.t.key, variation: m.v.name, target });
    if (seatKindOf(target) === 'vm') onMac.push({ key: m.t.key, variation: m.v.name, seated: Boolean(m.record) && m.record.pool !== 'local' });
  }
  for (const m of order) {
    const { t, v, status, kind, at } = m, { state, step } = status;
    const deep = status.chain.at(-1), inRun = status.chain.length > 1;
    const hold = () => { if (inRun) held.push({ key: t.key, variation: v.name, 'state-engine': deep['state-engine'], state: deep.state }); };
    const slot = gets.has(m);
    if (status.planned) ready.push({ key: t.key, variation: v.name });   // ASS-362: in the queue for Build, no seat
    if (slot && !isMacTarget(m.target)) slots[kind].push({ key: t.key, variation: v.name });
    else if (slot) { /* ASS-540: on a Mac target — no seat, its agent dispatched below */ }
    else if (kind == null && !status.planned && step['is-planning-stage'] === true && step.action?.type === 'none') entering.push({ key: t.key, variation: v.name });   // ASS-525: not yet started
    else if (kind != null) {
      waiting.push({ key: t.key, variation: v.name });
      if (!m.can.length) refused.push({ key: t.key, variation: v.name, step: judgedStep(status)?.id ?? state });   // ASS-540 AC3: never started
    }
    if (waitsOnHuman(engine, v, engines)) { hold(); continue; }   // no agent (and, ASS-527, no slot)
    if (at.action?.type !== 'prompt' || !isActive(at) || skipsForStack(at, v) || occupied(t.key, v.name)) continue;   // ASS-556: a stack step in worktree mode is passed, no agent
    if (kind != null && !slot) { hold(); continue; }
    if (inRun) continue;
    const agentCount = step.action['agent-count'] ?? 1;
    if (agents + agentCount > all('max-agents') || projectAgents + agentCount > own('max-agents')) { short.push({ key: t.key, variation: v.name }); continue; }
    dispatch.push({ key: t.key, variation: v.name, state, agentCount, planning: kind === 'planning' });
    agents += agentCount;
    projectAgents += agentCount;
  }
  // ASS-527: the ready-for-build cap counts every variation in planning, seated or not (one at a planning gate holds
  // no seat, but will join the queue all the same).
  const planningPool = moving.filter(m => m.pool === 'planning').length, queued = ready.length + planningPool;
  // ASS-531: the focus on planning lifts the cap off planning (readyFull false while it is on).
  const readyFull = !planningFocus && (queued >= own(READY_LIMIT) || readyElsewhere + planningPoolElsewhere + queued >= all(READY_LIMIT));
  // Whether one holding none could take a seat of each pool now: a seat on any of the project's run targets for it.
  const free = { planning: seatFor(candidates(undefined, rt, 'planning'), null, planningLeft ?? used) != null && !readyFull, progress: seatFor(candidates(undefined, rt, 'progress'), null) != null };
  const freeSeats = Math.max(0, mac - used.mac) + Math.max(0, remote - used.remote);
  // ASS-572: where the project's next ticket would go now — one more holder taking a seat anew, after every holder
  // above, at a step with no run-target list of its own (the project's list and pool choice): choose's answer, the
  // same rule every holder above was placed by, so the compute network screen's headline is the planner's own.
  const nextCan = candidates(undefined, rt, 'progress'), nextChoice = poolChoiceOf(undefined, rt, nextCan);
  // `ahead`: the holders seated anew this pass (waiting tickets the free seats go to first).
  const next = { ...choose(nextCan, null, nextChoice), choice: nextChoice, ahead };
  // ASS-528: the queue's demand for a seat — those at the queue's step that starts work (a planning `none` step with an
  // agent-needs-work exit: committed) and the finished plans waiting for Build — which seat-budget.js counts in the
  // project's demand, so a project with work waiting to start is allotted seats for it.
  const waitingToStart = moving.filter(m => m.kind == null && (m.status.planned === true || startsWork(m.status.step))).length;
  return { dispatch, queued: waitingToStart, reserved: slots.progress, planning: slots.planning.length, inPlanning: slots.planning, planningPool, ready, readyFull, waiting, memoryHeld: memory, memoryWaiting, entering, held, short, free, onMac, seats: { mac, remote, used }, freeSeats, refused, local, targets, next };
}

// inMotion(projects, engines, state) — { planning, progress, ready, planningPool (ASS-527: in planning, seated or not) }: how many of the
// projects' sprint variations are in planning, in progress and ready for build (planDispatch
// with no limits); given the loaded `state`, those their dependencies hold
// left out (heldBy, ASS-355); those whose VM is held for memory left out too
// (ASS-404: memoryHeldIn), and those refused a seat for memory (ASS-420: memoryWaitIn). (ASS-528: only
// max-tickets-ready-for-build spans projects now; seats are each project's own.)
export function inMotion(projects, engines, state) {
  const counts = { planning: 0, progress: 0, ready: 0, planningPool: 0 };
  for (const p of projects) {
    if (!p.engine) continue;
    const { planning, reserved, ready, planningPool } = planDispatch({ ranked: p.tickets, engine: p.engine, engines: p.engines ?? engines, asking: p.asking, ...(state ? { waitsOn: heldBy(state, p) } : {}), memoryHeld: memoryHeldIn(p), memoryWaits: memoryWaitIn(p) });
    counts.planning += planning;
    counts.progress += reserved.length;
    counts.ready += ready.length;
    counts.planningPool += planningPool;
  }
  return counts;
}

// planFor(state, project, agents, macSeats) — planDispatch for one project of `state`
// (loadState's; tick.js lists every project in allProjects): its sprint
// ranked, its assignments, its project.json's limits within harness.json's,
// every other project's ready-for-build queue counted against harness.json's max-tickets-ready-for-build (when set),
// its tickets' running agents' spend so far (ASS-270: tick.js load's
// `running`) against their spending limits, those its dependencies hold
// (and other projects' so held) taking nothing (heldBy, ASS-355), nor those
// whose VM is held for memory (ASS-404: memoryHeldIn), nor those refused a
// seat for memory (ASS-420: memoryWaitIn);
// `agents`, { agentsRunning, projectAgentsRunning }, for its dispatches.
// ASS-469, ASS-528: its seats are one pool — its Mac seats (the seat budget's, seat-kinds.js seatCapacity; `macSeats`
// instead when given: seat-budget.js asks with Infinity for the project's demand) and its usable remote machines' —
// and those holding a recorded seat (its seats.json, seatedIn) keep it ahead of the rest.
export function planFor(state, project, agents = {}, macSeats) {
  const readyCapped = state.harness?.[READY_LIMIT] != null;
  const others = readyCapped ? inMotion((state.allProjects ?? state.projects).filter(p => p.id !== project.id), state.engines, state) : { ready: 0, planningPool: 0 };
  const capacity = seatCapacity(project);
  return planDispatch({
    ranked: rankSprint(project.tickets, { engine: project.engine }), engine: project.engine, engines: project.engines ?? state.engines,
    assignments: state.assignments.filter(a => a.project === project.id), transient: state.transient,
    harness: state.harness, project: project.json ?? {}, seats: { mac: macSeats ?? capacity.vm, remote: capacity.remote, byKind: capacity.byKind }, planningRemote: capacity.mode === 'workstation', runTargets: project.runTargets ?? projectRunTargets(project.json ?? {}), headroom: headroomOf(project),
    readyElsewhere: others.ready, planningPoolElsewhere: others.planningPool, asking: project.asking, running: state.running?.[project.id] ?? {}, waitsOn: heldBy(state, project), memoryHeld: memoryHeldIn(project), memoryWaits: memoryWaitIn(project), seated: seatedIn(project), planningFocus: planningFocusOn(project), ...agents,
  });
}

// seatsOf(state, project) — what a harness run about another project's
// ticket is told of that project (ASS-240, dispatch.js {seats}; the TUI's
// seats too): its seats (ASS-528: { mac (its Mac seats now, the seat budget's; null for no limit), remote (its usable
// remote machines'), free (how many are left; null for no limit) }), its seat budget (seat-budget.js: share,
// allotment, used; null with none), max-agents (project.json's and harness.json's, null for none), and who holds its
// seats (planFor): "<key> <variation>" in progress and in planning, and over the limits — in motion at a step that
// takes a seat, with none free.
export function seatsOf(state, project) {
  const { reserved, inPlanning, waiting, seats, freeSeats, targets = [] } = planFor(state, project), names = list => list.map(s => `${s.key} ${s.variation}`);
  const finite = n => (Number.isFinite(n) ? n : null), budget = project.seatBudget ?? null;
  return {
    seats: { mac: finite(seats.mac), remote: seats.remote, free: finite(freeSeats) },
    budget: budget ? { share: budget.share ?? null, allotment: budget.allotment?.seats ?? null, used: budget.used?.seats ?? null } : null,
    limits: { project: { 'max-agents': project.json?.['max-agents'] ?? null }, harness: { 'max-agents': state.harness?.['max-agents'] ?? null } },
    'in-progress': names(reserved), 'in-planning': names(inPlanning), 'over-the-limits': names(waiting),
    // ASS-559: the run target each holder's step runs on now (the planner's), "<key> <variation>" → target — the
    // dashboard's sprint screen's Machine and Runs in for a holder control has not recorded in seats.json yet.
    targets: Object.fromEntries(targets.map(t => [`${t.key} ${t.variation}`, t.target])),
  };
}

// nextPlacement(state, project) — ASS-572: where the project's next ticket would go now (planDispatch `next`, planFor's
// answer): { target, machine, choice, rooms?, ahead } — target null when nothing has room, `ahead` how many waiting
// tickets were given a seat first; `machine` the remote machine's id
// (pool choice's pick, else, for a remote target placed by `first`, the machine seats.js would give it: seat-kinds.js
// freeMachine), null on the Mac. The compute network screen's headline (n) asks it, so it names the planner's choice.
export function nextPlacement(state, project) {
  const { next } = planFor(state, project);
  const remote = next.target != null && HOST_OF[next.target] !== 'local';
  return { ...next, machine: next.machine ?? (remote ? freeMachine(seatCapacity(project), project.seats ?? [], HOST_OF[next.target])?.id ?? null : null) };
}

// mayEnter(state, project, variation, to) — whether the variation may move to
// top-level step `to` (ASS-126): one in no pool (poolOf: the queue, Blocked,
// done); one of the pool the variation is in already, or from a detour
// (Blocked, Requirements Changed: ASS-527 AC3, generalising ASS-522) — it
// moves without a free seat and, at a step that needs one, waits there for
// the next in rank order (planDispatch `waiting`); or one whose pool has a
// seat free (planFor; a planning one only while max-tickets-ready-for-build is
// not reached, ASS-362) — starting work from the queue, or a finished plan
// going on to Build; ASS-528: or one the variation already holds a seat of the one pool for, which it takes along
// (a plan passed over into Build). Rank order is the callers': they move variations
// highest-ranked first — so a freed in-progress seat goes to the highest-ranked
// ready for build (a finished plan, holding none) before a lower-ranked one.
// (ASS-420: whether its VM fits in memory is moves.js mayMove's to ask, seat-memory.js.)
export function mayEnter(state, project, variation, to) {
  const pool = poolOf(stepOf(project.engine, to));
  if (pool == null) return true;
  const status = statusIn(project.engine, variation, project.engines ?? state.engines);
  if (poolOf(status.step, status) === pool) return true;
  if (status.step?.['is-blocked-state'] === true || status.step?.['follow-return-to-state'] === true) return true;
  const plan = planFor(state, project);
  // ASS-528: one pool — a variation holding a seat now takes it along into the other pool (planning into progress).
  const ticket = project.tickets.find(t => t.variations?.includes(variation));
  if (ticket && [...plan.inPlanning, ...plan.reserved].some(s => s.key === ticket.key && s.variation === variation.name)) return true;
  return plan.free[pool];
}

// topRun(transient, run) — the run, or the run it is under, walked up to the top.
export function topRun(transient, run) {
  let top;
  for (let r = run, seen = new Set(); r && !seen.has(r.id); r = transient.find(t => t.id === r.parent?.['transient-state-engine'])) { seen.add(r.id); top = r; }
  return top;
}

// grooming(state, project) — how many backlog tickets have an agent on them
// (ASS-144: a backlog ticket at a prompt step of its refinement engine is
// groomed by its own assignment, no run), every project's or, given,
// `project`'s: what max-tickets-in-grooming caps (ASS-87, ASS-129).
export function grooming(state, project) {
  const projects = state.allProjects ?? state.projects;
  const inBacklog = a => projects.find(p => p.id === a.project)?.backlog?.some(t => t.key === a['work-item']);
  return new Set(state.assignments.filter(a => a['transient-state-engine'] == null && a['work-item'] != null && (project == null || a.project === project) && inBacklog(a))
    .map(a => `${a.project}/${a['work-item']}`)).size;
}

// refinementDue(ticket, questions, now) — whether a backlog ticket at its
// refinement engine's first step is groomed now (ASS-144): never refined;
// or since it was last refined (last-refined: when its last completed groom
// turn started, ASS-213, so what arrived during that groom counts) its requirements changed
// (changed-at), a question was answered (`questions`' answered-time-stamp) or
// the operator decided at a human step (a variation's human-review, Reject);
// or 48 hours have passed. A pass's own writes to the questions file —
// accepting, rejecting, asking — change none of these.
const REFINE_AGAIN = 48 * 3600e3;
export function refinementDue(ticket, questions, now) {
  const last = Date.parse(ticket['last-refined']) || 0;
  if (!last || now - last >= REFINE_AGAIN) return true;
  const since = stamp => (Date.parse(stamp) || 0) > last;
  return since(ticket['changed-at']) || questions.some(q => since(q['answered-time-stamp'])) || (ticket.variations ?? []).some(v => since(v['human-review']?.timestamp));
}

// startsWork(step) — ASS-528: the queue's step that starts work: a planning `none` step with an agent-needs-work exit (committed).
const startsWork = step => step?.['is-planning-stage'] === true && step.action?.type === 'none'
  && (step['exit-events'] ?? []).some(e => Object.keys(e.condition ?? {})[0] === 'agent-needs-work');

// waitsOutside(step) — a `none` step past planning with no exit control can
// meet by itself (always, agent-needs-work): it waits on the ticket system or
// another outside event. The planning queue (backlog, committed) still reserves.
const waitsOutside = step => step.action?.type === 'none' && step['is-planning-stage'] !== true
  && !(step['exit-events'] ?? []).some(e => { const k = Object.keys(e.condition ?? {})[0]; return k === 'always' || k === 'agent-needs-work'; });

// triggerAllowed({ transient, kind, project, workItem, variation }) — whether
// a triggered engine of `kind` (check-health, check-memory,
// check-variation-appeal, gap-resolution, self-healing) may start: false while
// a transient engine record for the same project with parent.trigger === kind
// — and, when given, the same work-item and variation — already exists
// (one instance per trigger kind per project, per ticket for the per-ticket kinds).
export const triggerAllowed = ({ transient = [], kind, project, workItem, variation }) =>
  !transient.some(r => r.project === project && r.parent?.trigger === kind
    && (workItem == null || r.parent['work-item'] === workItem)
    && (variation == null || r.parent.variation === variation));
