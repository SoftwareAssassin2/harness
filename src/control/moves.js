// Moving work on, the only way control does it: a ticket variation with
// ticket:change-state (which carries the ticket system's status along) — or,
// at a human gate, ticket:mark-work-done
// and a wait — a state engine run with transient-state-engine:change-state.
// And the small readings the phases share.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleared, ticketKey, runKey } from './backoff.js';
import { changePath, stepOf, isHeld } from './engine.js';
import { mayEnter, slotKind, topRun } from './plan.js';

// firstStepId(engine) — the id of the step with the lowest sequence, where a run starts.
export const firstStepId = engine => (engine?.steps ?? []).toSorted((a, b) => a.sequence - b.sequence)[0]?.id;

// levelChanges(variation) — the variation's state-changes at the top level: a
// change made within a state (sub-state-change) belongs to the visit before it,
// so it is left out of the visit count.
export const levelChanges = variation => (variation['state-changes'] ?? []).filter(c => !c['sub-state-change']);

// found(state, record) — the project, ticket and variation a record or a
// run's parent names ({ project, 'work-item', variation }), each undefined
// when missing: the ticket in the project's sprint, else in its backlog
// (`backlog` true, ASS-144) — and `engine`, the engine the variation's steps
// are of: the project's execution engine; for a backlog ticket its own
// refinement engine, its harness-status's state-engine, else the project's
// (state.js refinementOf).
export function found(state, { project: id, 'work-item': key, variation: name }) {
  const project = state.projects.find(p => p.id === id);
  const inSprint = project?.tickets.find(t => t.key === key);
  const ticket = inSprint ?? (key == null ? undefined : project?.backlog?.find(t => t.key === key));
  const variation = ticket?.variations?.find(v => v.name === name && !v['is-deleted']);
  const backlog = ticket != null && !inSprint;
  const engine = backlog ? (project.engines ?? state.engines)?.[variation?.['harness-status']?.['state-engine']] ?? project.refinement : project?.engine;
  return { project, ticket, variation, engine, backlog };
}

// contextOf(run, transient) — the { workItem, variation } a run works for:
// its parent's, or the nearest ancestor run's (a sub-engine of a sub-engine),
// each undefined when none names one.
export function contextOf(run, transient) {
  for (let r = run, seen = new Set(); r && !seen.has(r.id); r = transient.find(t => t.id === r.parent?.['transient-state-engine'])) {
    seen.add(r.id);
    if (r.parent?.['work-item'] != null) return { workItem: r.parent['work-item'], variation: r.parent.variation ?? undefined };
  }
  return {};
}

// ticketPath(run, transient) — for a run that works for a ticket step (its
// parent is one: a work-item and variation, no trigger; or its parent run's
// is, walked up as far as it goes): { workItem, variation, state, path },
// `state` the ticket's top-level state the runs are under and `path` the
// states beneath it their parent runs are under, top first ([] for the
// step's own run) — where the run's level sits in the variation's status
// (ASS-67). Null for a trigger's run, or none's.
export function ticketPath(run, transient) {
  const path = [];
  for (let r = run, seen = new Set(); r && !seen.has(r.id); r = transient.find(t => t.id === r.parent?.['transient-state-engine'])) {
    seen.add(r.id);
    if (r.parent?.['transient-state-engine'] == null) {
      return r.parent?.trigger == null && r.parent?.['work-item'] != null && r.parent.variation != null ? { workItem: r.parent['work-item'], variation: r.parent.variation, state: r.parent.state, path } : null;
    }
    path.unshift(r.parent.state);
  }
  return null;
}

// exempt(state, pause, workItem, runId) — what an AI pause leaves going: the
// work of the health check that took it (its run and the runs under it, the
// run's parents walked up to pause.run) and, while a self-healing fix is under
// way (assignments.json self-healing, one record per fix ticket), the fix
// tickets and the self-healing runs with the runs under them.
function exempt(state, pause, workItem, runId) {
  const fixes = Object.keys(state.selfHealing ?? {});
  const healing = fixes.length > 0;
  if (healing && workItem != null && fixes.includes(workItem)) return true;
  const transient = state.transient ?? [];
  for (let r = transient.find(t => t.id === runId), seen = new Set(); r && !seen.has(r.id); r = transient.find(t => t.id === r.parent?.['transient-state-engine'])) {
    seen.add(r.id);
    if (r.id === pause.run || (healing && r.parent?.trigger === 'self-healing')) return true;
  }
  return false;
}

// backgroundOff(project) — the project's background work is switched off
// (project.json background-work false, project:set-background-work, ASS-127):
// control starts none of its BACKGROUND runs and holds those going (isPaused).
// Absent is on. Self-healing starts only from check-health, so it is held with it.
export const BACKGROUND = ['check-health', 'check-memory', 'check-variation-appeal', 'check-ticket-health', 'self-healing'];
export const backgroundOff = project => project?.json?.['background-work'] === false;

// backgroundProject(state, runId) — the project of the run, or the run it is
// under (walked up to the top), when that was started as background work; else undefined.
export function backgroundProject(state, runId) {
  const transient = state.transient ?? [];
  const top = topRun(transient, transient.find(t => t.id === runId));
  return BACKGROUND.includes(top?.parent?.trigger) ? (state.allProjects ?? state.projects).find(p => p.id === top.project) : undefined;
}

// heldBackground(state, runId) — the run is background work (backgroundProject) of a project with that off.
const heldBackground = (state, runId) => backgroundOff(backgroundProject(state, runId));

// weeklyLimit(ctx, project) — what the project's weekly Claude usage does to
// its grooming and background work (ASS-232): null while it is under the
// limit — its last claude-usage.json weekly percent (loadState's claudeUsage)
// below project.json's background-weekly-usage-limit-percent (absent, 90;
// null, never: project:set-background-weekly-usage-limit), or that week has
// reset (resets-at); a missing or `-` reading is never at it. At it: 'api'
// for a project declaring an API key beside its subscription (declaresApiKey,
// ASS-327) — that work goes onto the key, so the subscription's last share is
// still kept for sprint work while nothing stops; dispatch.js paymentFor pays
// it api, per step, and holds it as any API dispatch (the anthropic rate
// limit, the API caps) — else 'held'. Logged under "hold" once when it
// starts, when it changes between the two, and once when it lifts
// (memory.weeklyHolds: id → which).
const WEEKLY_LIMIT = 'background-weekly-usage-limit-percent';
export function weeklyLimit(ctx, project) {
  const limit = WEEKLY_LIMIT in project.json ? project.json[WEEKLY_LIMIT] : 90;
  const { percent, 'resets-at': resetsAt } = project.claudeUsage?.weekly ?? {};
  const reset = Date.parse(resetsAt) <= ctx.now().getTime();
  const at = limit != null && typeof percent === 'number' && percent >= limit && !reset;
  const now = at ? (declaresApiKey(ctx, project) ? 'api' : 'held') : null;
  const holds = (ctx.memory.weeklyHolds ??= new Map());
  const was = holds.get(project.id) ?? null;
  if (now === was) return now;
  if (now) {
    holds.set(project.id, now);
    ctx.log('hold', `${project.id}: weekly Claude usage is ${percent}%, at or above its limit of ${limit}%; its grooming and background work ${now === 'api' ? 'go to its API key' : 'are held'}`);
  } else {
    holds.delete(project.id);
    const why = limit == null ? 'its weekly usage limit is off' : reset ? 'its weekly Claude usage has reset' : typeof percent === 'number' ? `weekly Claude usage is ${percent}%, under its limit of ${limit}%` : 'its weekly Claude usage is not known';
    ctx.log('hold', `${project.id}: ${why}; its grooming and background work ${was === 'api' ? 'go back to its subscription' : 'go on'}`);
  }
  return now;
}

// weeklyHeld(ctx, project) — whether the project's grooming and background
// work are held for its weekly usage (weeklyLimit 'held', ASS-232): none of
// its BACKGROUND triggers start (triggers.js, reverts.js) and dispatch.js
// puts no agent on that work. One at the limit with an API key is not held
// (ASS-327): its work goes on, onto the key.
export const weeklyHeld = (ctx, project) => weeklyLimit(ctx, project) === 'held';

// declaresApiKey(ctx, project) — the project declares an API key beside its
// subscription (ASS-217) somewhere its agents run: its host .claude-api
// (dispatch.js configDir(ctx, project, 'api')) or a VM its vms.json records
// as holding both (credential-kind `both`, vm-lifecycle.js credentialKindOf).
// Project-wide, for the weekly limit (ASS-327): whether a step's own agent
// can pay by the key is paymentFor's, per step; one that cannot waits there.
function declaresApiKey(ctx, project) {
  if (existsSync(join(ctx.paths.projects, project.id, '.claude-api'))) return true;
  const vms = join(ctx.paths.projects, project.id, 'vms.json');
  try { return existsSync(vms) && Object.values(JSON.parse(readFileSync(vms, 'utf8'))).some(vm => vm?.['credential-kind'] === 'both'); } catch { return false; }
}

// humanPause(state, project) — the scope of the human pause holding the
// project ("all", or its own id, in that order), or undefined: a human's
// pause holds everything there (isPaused), its VMs too (vm-lifecycle.js,
// ASS-297); an AI's is a brief hold, and not one.
export const humanPause = (state, project) => ['all', project].find(scope => state.pauses[scope]?.human);

// isPaused(state, project, workItem, variation, runId?) — the project's agents
// are paused (assignments.json pauses, by scope: "all" and the project's own;
// a human's holds everything there, an AI's all but its health check's work,
// see exempt), or that ticket or variation is held (engine.js isHeld:
// is-paused, or the ticket worked by hand, ASS-166), or the run is
// background work (its top run's trigger is BACKGROUND) of a project with its
// background work off (ASS-127). runId names the run the work is for, when it
// is a run's.
export function isPaused(state, project, workItem, variation, runId) {
  if (humanPause(state, project)) return true;
  for (const scope of ['all', project]) {
    const pause = state.pauses[scope];
    if (pause?.ai && !exempt(state, pause.ai, workItem, runId)) return true;
  }
  if (runId != null && heldBackground(state, runId)) return true;
  const { ticket, variation: v } = found(state, { project, 'work-item': workItem, variation });
  return isHeld(ticket, v);
}

// gated(variation, engineName, state, depth) — the variation waits for a
// human before it leaves `state` of `engineName` at level `depth` of its
// status (0, the default, its top level and harness-status's own): its
// gate-when-leaving-state lists "<engine>/<state>" (ASS-67) and its latest
// state change is the one into it at that level.
export function gated(variation, engineName = variation['harness-status']?.['state-engine'], state = variation['harness-status']?.state, depth = 0) {
  return (variation['gate-when-leaving-state'] ?? []).includes(`${engineName}/${state}`) && changePath(variation['state-changes']?.at(-1))[depth]?.['to-state'] === state;
}

// moveTicket(ctx, phase, project, ticket, variation, to, why, startAt) — the
// variation moved from its state to `to` (ticket:change-state, which sets
// the new step's paired-ticket-system-status on the ticket when that
// differs; its word on that logged too) — entering, given `startAt` (an
// exit's start-sub-engine-at), the sub-engine of `to` at that step. Unless
// the variation is gated (gated): then its work there is marked done
// (ticket:mark-work-done, the move held as its pending move — holdAtGate;
// logged, naming where it would go) and it stays for the human, whose
// approval on the dashboard (ticket:approve-gate) makes that move. Each move of a sprint ticket is handed to ticket health
// sampling (see triggers.js sampleHealth); a backlog ticket moves through its refinement engine the same way (ASS-144).
// Given a `cause` (a move no human made at a human step: fast-track, ASS-151; or a block
// cleared by a landed fix, FIX_LANDED, ASS-309, which restarts the step-visit window), it is
// recorded on the change (MOVE_CAUSE, sprint.bash); SKIPPED's, a switched-off step passed
// (ASS-192), is no gate's to hold, nor NO_CHOICE's, a pass with no human choice, unless the project holds those (ASS-220). Returns whether it moved.
export async function moveTicket(ctx, phase, project, ticket, variation, to, why, startAt, cause) {
  const from = variation['harness-status'].state;
  if (to !== from) cleared(ctx.memory, ticketKey(project.id, ticket.key, variation.name, from));   // moved on: its failures there forgotten
  if (!passesGate(project, cause) && gated(variation)) {
    await holdAtGate(ctx, phase, project.id, ticket.key, variation, `${ticket.key} ${variation.name} ${from}`, { from, to, reason: why ?? 'exit', ...(startAt ? { 'start-sub-engine-at': startAt } : {}) });
    return false;
  }
  const said = await ctx.cli(['ticket:change-state', project.id, ticket.key, variation.name, from, to, ...(startAt ? [startAt] : [])], causeEnv(cause));
  ctx.log(phase, `${ticket.key} ${variation.name} ${from} → ${to}${startAt ? ` at ${startAt}` : ''}${why ? ` (${why})` : ''}`);
  const status = /ticket system status → (.*)$/m.exec(said);
  if (status) ctx.log(phase, `${ticket.key} ticket system status → ${status[1]}`);
  if (project.tickets.some(t => t.key === ticket.key)) ctx.memory.health.push({ project: project.id, 'work-item': ticket.key, variation: variation.name });   // a sprint ticket's: a backlog ticket's refinement is not sampled
  return true;
}

// mayMove(ctx, phase, state, project, variation, who, to) — whether the
// variation may move to top-level step `to` under the ticket limits (plan.js
// mayEnter, ASS-126); when not, said once per visit. Every move control makes
// on its own asks first (steps.js, dispatch.js's pass-over) — all but an
// agent's finished turn (finish.js), whose work is done and would only be
// redone at the step it left. While its project's memory hold is on (ASS-404,
// host-memory.js) a variation whose VM is not up takes no seat a held
// variation freed (mayEnter's memorySeats): its own VM would be held too.
export function mayMove(ctx, phase, state, project, variation, who, to) {
  const memorySeats = Boolean(project.memoryHold) && !(variation.vm?.name && ctx.memory.vmsUp?.has(variation.vm.name));
  if (mayEnter(state, project, variation, to, { memorySeats })) return true;
  const key = `slot/${project.id}/${who}/${(variation['state-changes'] ?? []).length}/${to}`;
  if (!ctx.memory.warned.has(key)) {
    ctx.memory.warned.add(key);
    const memory = memorySeats && mayEnter(state, project, variation, to) ? ' (the one free is a seat a VM held for memory left: its VM would be held too)' : '';   // ASS-404
    ctx.log(phase, `${who}: waits for ${slotKind(stepOf(project.engine, to)) === 'planning' ? 'a planning' : 'an in-progress'} slot to move to ${to}${memory}`);
  }
  return false;
}

// SKIPPED — the cause of a switched-off step's pass (ASS-192, steps.js): the history says "(skipped: switched off)".
export const SKIPPED = { cause: 'skipped', reason: 'switched off' };

// NO_CHOICE — a human step's pass by itself with nothing for a human to choose (its has-variations false
// exit, the ticket's one variation; ASS-220): its exit's move, so no cause is recorded, and its gate
// approved automatically unless the project holds such gates (project.json hold-gates-with-no-human-choice).
export const NO_CHOICE = { cause: 'no-human-choice' };

// TIMER — the cause of a timer script step's move (steps.js, ASS-236): a poll (a merge seen, auto-merge
// set) that a gate would hold for hours and replay stale on approval, so no gate holds it — a
// gate-when-leaving-state on a timer step is ignored — and its move is recorded as any exit's, with no cause.
export const TIMER = { cause: 'timer' };

// passesGate(project, cause) — the move is held by no gate: a switched-off step's pass, a timer step's move (TIMER), or a pass with no human choice (NO_CHOICE) where the project does not hold those.
const passesGate = (project, cause) => cause === SKIPPED || cause === TIMER || (cause === NO_CHOICE && project?.json?.['hold-gates-with-no-human-choice'] !== true);

// causeEnv(cause) — the env that records a move's cause (sprint.bash MOVE_CAUSE): a name, or { cause, reason }; none without one, nor for NO_CHOICE or TIMER.
const causeEnv = cause => (cause && cause !== NO_CHOICE && cause !== TIMER ? { MOVE_CAUSE: JSON.stringify(typeof cause === 'string' ? { cause } : cause) } : undefined);

// moveRun(ctx, phase, run, to, output, why, cause) — the run moved from its state to `to`
// (transient-state-engine:change-state), `output` merged over its
// structured-output so what every step returned (a ticket's key, a summary)
// stays with the run. Logs it. Unless the run works for a ticket step
// (ticketPath) whose variation is gated on leaving the run's step (gated, at
// the run's level): then, as moveTicket does, its work there is marked done
// (on the variation's latest change, holdAtGate) and the run stays for the
// human, whose approval on the dashboard (ticket:approve-gate) makes the move,
// the output merged as here — the pending move holding the step's own output
// alone, not an earlier step's verdict the run carries (ASS-236). `why` says why it goes there when not by its
// exit (max-visits); `cause`, recorded on the ticket's change as moveTicket's (SKIPPED's held by no gate, NO_CHOICE's as there). Returns whether it moved.
export async function moveRun(ctx, phase, run, to, output, why, cause) {
  const state = ctx.load(), at = ticketPath(run, state.transient);
  const { variation } = at ? found(state, { project: run.project, 'work-item': at.workItem, variation: at.variation }) : {};
  const merged = output == null ? run['structured-output'] : { ...(run['structured-output'] ?? {}), ...output };
  if (!passesGate((state.allProjects ?? state.projects).find(p => p.id === run.project), cause) && variation && gated(variation, run['state-engine'], run.state, at.path.length + 1)) {
    await holdAtGate(ctx, phase, run.project, at.workItem, variation, `${at.workItem} ${at.variation} ${run['state-engine']}/${run.state}`,
      { run: run.id, from: run.state, to, reason: why ?? 'exit', ...(output == null ? {} : { output }) });
    return false;
  }
  if (to !== run.state) cleared(ctx.memory, runKey(run.id, run.state));
  await ctx.cli(['transient-state-engine:change-state', run.id, run.state, to, ...(merged == null ? [] : [JSON.stringify(merged)])], causeEnv(cause));
  ctx.log(phase, `run ${run['state-engine']} ${run.id.slice(0, 8)} ${run.state} → ${to}`);
  return true;
}

// holdAtGate(ctx, phase, project, workItem, variation, who, pending) — the
// variation waits at its gate: its work there marked done with `pending`, the
// move held ({ from, to, reason }, and a run's { run, output: its step's own }), as its
// pending move (ticket:mark-work-done; ASS-132), logged — once, or again when
// the move now goes elsewhere (a retry turned into a block).
async function holdAtGate(ctx, phase, project, workItem, variation, who, pending) {
  const last = variation['state-changes'].at(-1);
  if (last['work-is-done'] === true && last['pending-move']?.to === pending.to) return;
  await ctx.cli(['ticket:mark-work-done', project, workItem, variation.name, variation['harness-status'].state, JSON.stringify(pending)]);
  ctx.log(phase, `${who}: work done; waiting at the gate for a human (next would be ${pending.to})`);
}

// releaseWorkspace(ctx, phase, record) — the record's agent ran in the
// workspace (working-in-dev-container, see dispatch.js) on a ticket and no
// assignment in the workspace is left: the workspace given back
// (code:release-workspace), logged. Nothing otherwise.
export async function releaseWorkspace(ctx, phase, record) {
  if (record['working-in-dev-container'] !== true || record['work-item'] == null) return;
  if (ctx.load().assignments.some(a => a['working-in-dev-container'] === true)) return;
  await ctx.cli(['code:release-workspace', record.project, record['work-item'], record.variation]);
  ctx.log(phase, `${record['work-item']} ${record.variation}: the workspace is released`);
}

// endRun(ctx, phase, run, why) — the run removed (transient-state-engine:remove), logged.
export async function endRun(ctx, phase, run, why) {
  await ctx.cli(['transient-state-engine:remove', run.id]);
  ctx.log(phase, `run ${run['state-engine']} ${run.id.slice(0, 8)} ended${why ? ` (${why})` : ''}`);
}
