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
import { heldBy } from './dependencies.js';
import { isBlockedState, isDoneStep, waitsOnHuman, statusIn, inPlanning, stepOf, isHeld, isActive } from './engine.js';
import { rankSprint } from './rank.js';
import { overSpent } from './spend.js';

// The ticket limits (ASS-126) count tickets in motion: each variation at a
// planning step takes a planning slot, at any other an in-progress slot.
const LIMIT = { planning: 'max-tickets-in-planning', progress: 'max-tickets-in-progress' };
// The cap on the ready queue, the planned waiting for a build seat (ASS-362).
export const READY_LIMIT = 'max-tickets-ready-for-build';

// slotKind(step, status) — the slot a variation at top-level `step` takes:
// none (null) in the queue (a planning step no agent works: backlog,
// committed), at a detour it returns from (follow-return-to-state: Blocked,
// Blocked for Human), a switched-off one (isActive, ASS-192: passed at once), done, or
// a planning step whose plan is finished (status.planned, ASS-362: ready for build); else 'planning' when in
// planning (inPlanning over its `status`, statusOf: inside a sub-engine the
// deepest step that says, falling back up to `step`), else 'progress' — a
// human step (ASS-203) holds its slot like any other, by position.
export function slotKind(step, status = { chain: [{ step }] }) {
  if (!step || !isActive(step) || step['is-done'] === true || step['is-blocked-state'] === true || step['follow-return-to-state'] === true) return null;
  if (step['is-planning-stage'] === true && step.action?.type === 'none') return null;
  if (status.planned === true) return null;
  return inPlanning(status) ? 'planning' : 'progress';
}

// planDispatch({ ranked, engine, engines, assignments, transient, harness, project,
// agentsRunning, projectAgentsRunning, reservedElsewhere, planningElsewhere })
// — `ranked`: one project's sprint tickets in rank order (see rankSprint),
// each with its variations; `engine`: its execution state engine, and
// `engines` the engines beneath it ({ [name]: its JSON }; none, the top
// level alone); `assignments`: its assignments.json records, one occupying a variation when
// its work-item matches and its variation does or is null; `harness` and
// `project`: { max-agents, max-tickets-in-progress, max-tickets-in-planning, max-tickets-ready-for-build } from
// harness.json (every project together) and the project's project.json (it
// alone), null or missing for no limit, 0 for none — a slot or a dispatch must fit both;
// `agentsRunning`: agent processes alive now, of every kind and project, and
// `projectAgentsRunning` this project's; `reservedElsewhere` and
// `planningElsewhere`: the variations other projects have in progress and in
// planning (inMotion), against the harness's limits, and `readyElsewhere`
// those they have ready for build (ASS-362); `harness` and `project`
// also give a ticket its spending limit (spend.js, ASS-191), and `running`,
// { <work-item>: usd }, what its running agents have spent so far toward it
// (ASS-270: spend.js runningSpend's for the project); `asking`, the
// keys of the tickets an open blocking question holds (state.js, ASS-248); `waitsOn(ticket,
// variation)`, whether its dependencies hold it (dependencies.js heldBy, ASS-355). (`transient` is taken
// for the record; triggered engines count through agentsRunning.) Returns
// { dispatch, reserved, planning, inPlanning, ready, readyFull, waiting, held, short, free }: `dispatch`, in rank order, each
// { key, variation, state, agentCount, planning } to put agents on;
// `reserved`, the { key, variation } holding the in-progress slots, in rank
// order; `planning`, how many hold planning slots, and `inPlanning` which;
// `ready`, the { key, variation } whose plan is finished (ASS-362: no seat, its
// VM stopped), in rank order — the queue for Build; `readyFull`, whether
// max-tickets-ready-for-build is reached by those and the ones in planning;
// `waiting`, the { key, variation } in motion but holding no slot, the limits full (ASS-233: no VM runs for one);
// `short`, the { key, variation } a dispatch was skipped for, max-agents full; `held`, each { key, variation,
// state-engine, state } whose step inside a sub-engine may not have an agent
// now; `free`, { planning, progress }: whether a variation holding none could
// take a slot of each (mayEnter) — planning only while readyFull is not.
// A variation is in motion — holds a slot of its step's kind (slotKind), the
// first ones in rank order up to the limits — unless deleted, held (paused,
// it or its ticket, or worked by hand: isHeld), its ticket waiting on the
// operator for an answer (`asking`: no seat, as paused), held by its
// dependencies (`waitsOn`, ASS-355: no slot or seat, as paused), its ticket at its spending limit (overSpent: steps.js
// takes it to Blocked for Human), done, in the blocked state, waiting on
// the outside at a `none` step past planning (one with no always or
// agent-needs-work exit, such as QA Testing waiting on the ticket system), or
// at a step that takes none. Waiting on a human (ASS-203: a gate or a human
// step) still holds its slot, it just gets no agent. It needs an agent when, not waiting, its step's
// action is a prompt, switched on (isActive, ASS-192), and no assignment is on it; it gets one when it holds its
// slot, or its step takes none (Blocked's run). A dispatch whose whole agent-count
// (default 1) would take the agents past max-agents is skipped, and the walk goes on.
// Inside a sub-engine (ASS-67) the variation's detailed step (statusOf) is
// the one that waits on a human or the outside and that needs an agent; its
// run's agents go out with the run (dispatch.js), so it is not dispatched
// here, but it is `held` when it could not be — no slot — or it waits on a human.
export function planDispatch({ ranked, engine, engines = {}, assignments = [], harness = {}, project = {}, agentsRunning = 0, projectAgentsRunning = 0, reservedElsewhere = 0, planningElsewhere = 0, readyElsewhere = 0, asking = new Map(), running = {}, waitsOn = () => false }) {
  const all = name => harness[name] ?? Infinity, own = name => project[name] ?? Infinity;
  const occupied = (key, name) => assignments.some(a => a['work-item'] === key && (a.variation == null || a.variation === name));
  const slots = { planning: [], progress: [] }, elsewhere = { planning: planningElsewhere, progress: reservedElsewhere };
  const free = kind => slots[kind].length < own(LIMIT[kind]) && elsewhere[kind] + slots[kind].length < all(LIMIT[kind]);
  let agents = agentsRunning, projectAgents = projectAgentsRunning;
  const dispatch = [], held = [], short = [], waiting = [], ready = [];
  for (const t of ranked) for (const v of overSpent(t, harness, project, running[t.key] ?? 0) ? [] : t.variations ?? []) {
    const status = statusIn(engine, v, engines), { state, step } = status;
    if (!step || v['is-deleted'] || isHeld(t, v) || asking.has(t.key) || isDoneStep(engine, state) || isBlockedState(engine, state) || waitsOn(t, v)) continue;
    const deep = status.chain.at(-1), inRun = status.chain.length > 1, at = status.detailStep ?? step;
    const hold = () => { if (inRun) held.push({ key: t.key, variation: v.name, 'state-engine': deep['state-engine'], state: deep.state }); };
    if (at['is-done'] !== true && waitsOutside(at)) continue;   // a run done: its group step is about to move on
    const kind = slotKind(step, status), slot = kind != null && free(kind);
    if (status.planned) ready.push({ key: t.key, variation: v.name });   // ASS-362: in the queue for Build, no seat
    if (slot) slots[kind].push({ key: t.key, variation: v.name });
    else if (kind != null) waiting.push({ key: t.key, variation: v.name });
    if (waitsOnHuman(engine, v, engines)) { hold(); continue; }   // keeps its slot (ASS-203), just no agent
    if (at.action?.type !== 'prompt' || !isActive(at) || occupied(t.key, v.name)) continue;
    if (kind != null && !slot) { hold(); continue; }
    if (inRun) continue;
    const agentCount = step.action['agent-count'] ?? 1;
    if (agents + agentCount > all('max-agents') || projectAgents + agentCount > own('max-agents')) { short.push({ key: t.key, variation: v.name }); continue; }
    dispatch.push({ key: t.key, variation: v.name, state, agentCount, planning: kind === 'planning' });
    agents += agentCount;
    projectAgents += agentCount;
  }
  const queued = ready.length + slots.planning.length;
  const readyFull = queued >= own(READY_LIMIT) || readyElsewhere + planningElsewhere + queued >= all(READY_LIMIT);
  return { dispatch, reserved: slots.progress, planning: slots.planning.length, inPlanning: slots.planning, ready, readyFull, waiting, held, short, free: { planning: free('planning') && !readyFull, progress: free('progress') } };
}

// inMotion(projects, engines, state) — { planning, progress, ready }: how many of the
// projects' sprint variations are in planning, in progress and ready for build (planDispatch
// with no limits); given the loaded `state`, those their dependencies hold
// left out (heldBy, ASS-355).
export function inMotion(projects, engines, state) {
  const counts = { planning: 0, progress: 0, ready: 0 };
  for (const p of projects) {
    if (!p.engine) continue;
    const { planning, reserved, ready } = planDispatch({ ranked: p.tickets, engine: p.engine, engines: p.engines ?? engines, asking: p.asking, ...(state ? { waitsOn: heldBy(state, p) } : {}) });
    counts.planning += planning;
    counts.progress += reserved.length;
    counts.ready += ready.length;
  }
  return counts;
}

// planFor(state, project, agents) — planDispatch for one project of `state`
// (loadState's; tick.js lists every project in allProjects): its sprint
// ranked, its assignments, its project.json's limits within harness.json's,
// every other project's variations in motion counted against the harness's,
// its tickets' running agents' spend so far (ASS-270: tick.js load's
// `running`) against their spending limits, those its dependencies hold
// (and other projects' so held) taking nothing (heldBy, ASS-355);
// `agents`, { agentsRunning, projectAgentsRunning }, for its dispatches.
export function planFor(state, project, agents = {}) {
  const others = inMotion((state.allProjects ?? state.projects).filter(p => p.id !== project.id), state.engines, state);
  return planDispatch({
    ranked: rankSprint(project.tickets, { engine: project.engine }), engine: project.engine, engines: project.engines ?? state.engines,
    assignments: state.assignments.filter(a => a.project === project.id), transient: state.transient,
    harness: state.harness, project: project.json, reservedElsewhere: others.progress, planningElsewhere: others.planning, readyElsewhere: others.ready, asking: project.asking, running: state.running?.[project.id] ?? {}, waitsOn: heldBy(state, project), ...agents,
  });
}

// seatsOf(state, project) — what the grouped health check is told of a
// project (ASS-240, dispatch.js {seats}): its limits, project.json's and
// harness.json's (null for none), and who holds its seats (planFor): "<key>
// <variation>" in progress and in planning, and over the limits — in motion
// at a step that takes a seat, with none free.
export function seatsOf(state, project) {
  const { reserved, inPlanning, waiting } = planFor(state, project), names = list => list.map(s => `${s.key} ${s.variation}`);
  const limits = json => Object.fromEntries([LIMIT.progress, LIMIT.planning, 'max-agents'].map(name => [name, json?.[name] ?? null]));
  return { limits: { project: limits(project.json), harness: limits(state.harness) }, 'in-progress': names(reserved), 'in-planning': names(inPlanning), 'over-the-limits': names(waiting) };
}

// mayEnter(state, project, variation, to) — whether the variation may move to
// top-level step `to` (ASS-126): one that takes no slot (slotKind: the queue,
// Blocked, done); one of the kind the variation is in already (it
// holds that slot — or is in it past the limits, and the move takes no
// more); or one whose kind has a slot free (planFor; a planning one only while
// max-tickets-ready-for-build is not reached, ASS-362). Rank order is the
// callers': they move variations highest-ranked first — so a freed in-progress
// seat goes to the highest-ranked ready for build (a finished plan, holding
// none) before a lower-ranked one. A top-level human
// step takes an in-progress slot too (ASS-203), so moving to one needs one.
export function mayEnter(state, project, variation, to) {
  const kind = slotKind(stepOf(project.engine, to));
  if (kind == null) return true;
  const status = statusIn(project.engine, variation, project.engines ?? state.engines);
  return slotKind(status.step, status) === kind || planFor(state, project).free[kind];
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

// waitsOutside(step) — a `none` step past planning with no exit control can
// meet by itself (always, agent-needs-work): it waits on the ticket system or
// another outside event. The planning queue (backlog, committed) still reserves.
const waitsOutside = step => step.action?.type === 'none' && step['is-planning-stage'] !== true
  && !(step['exit-events'] ?? []).some(e => { const k = Object.keys(e.condition ?? {})[0]; return k === 'always' || k === 'agent-needs-work'; });

// triggerAllowed({ transient, kind, project, workItem, variation }) — whether
// a triggered engine of `kind` (check-health, check-ticket-health,
// check-variation-appeal, gap-resolution, self-healing) may start: false while
// a transient engine record for the same project with parent.trigger === kind
// — and, when given, the same work-item and variation — already exists
// (one instance per trigger kind per project, per ticket for the per-ticket kinds).
export const triggerAllowed = ({ transient = [], kind, project, workItem, variation }) =>
  !transient.some(r => r.project === project && r.parent?.trigger === kind
    && (workItem == null || r.parent['work-item'] === workItem)
    && (variation == null || r.parent.variation === variation));
