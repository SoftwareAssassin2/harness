// Phase 3: the steps no agent works — `none`, `script` and `state-engine`
// actions — of every sprint variation and every state engine run, each moved
// on while its exits hold (backlog → committed → … in one tick). A variation
// its dependencies hold (dependencies.js awaitsDependencies, ASS-355), and
// every run under it, is left where it is: no move, script, sub-engine run or
// VM wait, at any step but a done or a person's one.
import { stepOf, engineSteps, nextState, pairedStatus, isManual, isDoneStep, isActive, answersGap, ownBranchFix, awaitsDependency, clearCause, resumeAt, resumeSubAt, whyNotResume, statusIn, mergesAwaited } from './engine.js';
import { enginesFor } from './state.js';
import { rankSprint, rankBacklog } from './rank.js';
import { planFor, slotKind } from './plan.js';
import { waitsForSeat } from './fast-track.js';
import { fillArgs } from './placeholders.js';
import { ticketFacts, ticketValues, runValues, parseOutput, cameFrom } from './facts.js';
import { firstStepId, levelChanges, contextOf, ticketPath, found, moveTicket, moveRun, endRun, isPaused, mayMove, gated, SKIPPED, NO_CHOICE, TIMER } from './moves.js';
import { failed, waiting, held as heldFor, ticketKey, runKey, cleared, BLOCK_AFTER, FAILED_STARTS } from './backoff.js';
import { runsInVm, vmOf } from './vm.js';
import { awaitsVm, NEVER_UP, neverUp, vmUpCeilingMs } from './vm-lifecycle.js';
import { awaitsDependencies } from './dependencies.js';
import { overSpent, spendText, runningOn } from './spend.js';
import { readSession } from '../agents/session.js';
import { diskHeld, makesDisk } from './disk.js';
import { memoryShort, startsVm } from './host-memory.js';
import { credentialsHeld } from './credentials.js';

const PHASE = 'steps';
const CHAIN = 20;   // moves one variation or run may make in a tick
const FAST_TRACK = 'fast-track';

// passedItself(next) — a human step left by its { "fast-tracked": true }
// exit (ASS-151: a fast-tracked ticket's human steps pass themselves, the
// system taking care of itself): what the log says of it; null for any
// other move. The move is recorded with cause fast-track.
const passedItself = next => (next?.to != null && next.exit?.condition?.['fast-tracked'] === true ? `fast-tracked, passed by itself — no human asked (→ ${next.to})` : null);

// rejected(next, facts) — a human step left by its Rejected exit (ASS-228: a Human Review
// rejection): the cause its move carries, operator-reject with the human's reason; else null.
const rejected = (next, facts) => (next?.to != null && next.exit?.condition?.['human-review'] === 'Rejected'
  ? { cause: 'operator-reject', ...(facts.humanReview?.reason ? { reason: facts.humanReview.reason } : {}) } : null);
// rejectedLine(cause, to) — what the log says of an operator's rejection.
const rejectedLine = (cause, to) => `rejected by the operator (→ ${to})${cause.reason ? `: ${cause.reason}` : ''}`;

// humanCause(next, facts) — the cause a human step's move carries: fast-track's (passedItself), an
// operator's rejection (rejected), or NO_CHOICE for its has-variations false exit, nothing for a human
// to choose (ASS-220: its gate approved automatically).
const humanCause = (next, facts) => (passedItself(next) ? FAST_TRACK : rejected(next, facts) ?? (next?.exit?.condition?.['has-variations'] === false ? NO_CHOICE : undefined));

// switchedOff(step) — where a switched-off step (engine.js isActive, ASS-192)
// sends whatever arrives at it: its first exit's move-to-state, taken at once
// whatever its condition — no agent, no human, no gate (moves.js SKIPPED) —
// as { to, exit, reason: 'exit' }, the shape nextState gives.
const switchedOff = step => { const exit = step['exit-events']?.[0]; return { to: exit?.['move-to-state'], exit, reason: 'exit' }; };

// scriptDue(ctx, who, key, visit, step, now) — whether script step `who` runs now:
// a timer step (mode timer) when timer-minutes have passed since it last ran
// for `key` (never: now); any other once per `visit` — a failing script,
// sent back to its own step by its exit, is held between tries by the
// backoff (backoff.js), not hammered every tick. Remembers the run. A skip
// of a step already run this visit is said once (a timer's never: it skips
// nearly every tick), so a stall shows in the log (ASS-212).
export function scriptDue(ctx, who, key, visit, step, now) {
  const { memory } = ctx;
  const last = memory.lastRun.get(key);
  if (step.action.mode === 'timer') {
    if (last != null && now - last < (step.action['timer-minutes'] ?? 0) * 60_000) return false;
  } else {
    if (memory.ran.has(visit)) { warnOnce(ctx, 'ran/' + visit, `${who}: its script already ran this visit; not run again`); return false; }
    memory.ran.add(visit);
  }
  memory.lastRun.set(key, now);
  return true;
}

// diskWaits(ctx, state, step, who) — a script step that makes a VM or a golden
// image (disk.js makesDisk: vm:create's clone, vm:build-golden) waits, not run,
// while the disk hold is on (ASS-288), said once per hold; it runs once the
// hold lifts.
function diskWaits(ctx, state, step, who) {
  if (!makesDisk(step.action?.command)) return false;
  if (!diskHeld(state)) { ctx.memory.warned.delete(`disk/${who}`); return false; }
  warnOnce(ctx, `disk/${who}`, `${who}: waits: the disk is nearly full`);
  return true;
}

// memoryWaits(ctx, state, project, step, who, held) — a script step that starts or
// creates a VM (vm:create, vm:start) waits, not run, while the Mac is short of
// memory for one of the project's VMs (ASS-398, host-memory.js: the hold put
// on or kept), said once per hold, no failure counted; it runs once there is enough.
// ASS-404: its ticket's variation (`held`, { key, variation, state }) is held
// with it, so it holds no seat while it waits (plan.js).
async function memoryWaits(ctx, state, project, step, who, held = null) {
  if (!startsVm(step.action?.command)) return false;
  if (!await memoryShort(ctx, state, project, null, held)) { ctx.memory.warned.delete(`memory/${who}`); return false; }
  warnOnce(ctx, `memory/${who}`, `${who}: waits: out of memory`);
  return true;
}

// setupWaits(ctx, project, step, who) — the same script steps (a VM's or a
// golden image's setup) wait while the project's credentials hold it
// (credentials.js, ASS-395), said once per hold; they run once it lifts.
function setupWaits(ctx, project, step, who) {
  if (!makesDisk(step.action?.command)) return false;
  if (!credentialsHeld(project)) { ctx.memory.warned.delete(`credentials/${who}`); return false; }
  warnOnce(ctx, `credentials/${who}`, `${who}: waits: ${project.id} is blocked by credentials`);
  return true;
}

// heldAtGate(variation, ...gated's) — the variation waits at a gate on
// leaving this step, its work there done (holdAtGate): its script ran
// already, and is not run again — not even by a restarted control, which
// remembers none of it (ASS-117: Request a Restart would restart the new
// control too, over and over) — until the human approves the move.
const heldAtGate = (variation, ...at) => gated(variation, ...at) && variation['state-changes']?.at(-1)?.['work-is-done'] === true;

// A script step run: its command filled and run — in the variation's VM for
// a run-location: vm step (ASS-74) — the facts exitCode and scriptOutput
// (stdout as JSON when it parses); a command that cannot be filled, or a vm
// step whose variation has no VM yet, is a failure (exit code 1), logged.
// `env`, when given, over the command's own (scriptEnv).
async function runScriptStep(ctx, step, values, who, variation, env) {
  let argv, vm;
  try {
    argv = fillArgs(step.action.command, values);
    if (runsInVm(step)) vm = vmOf(variation, who);
  } catch (error) { ctx.log(PHASE, `${who}: ${error.message}`); return { exitCode: 1 }; }
  const { exitCode, stdout } = await (env ? ctx.script(argv, vm, env) : ctx.script(argv, vm));
  return { exitCode, scriptOutput: parseOutput(stdout) };
}

// scriptEnv(state, project, variation) — what a script step's command is told
// of where its variation stands, beyond its arguments: MERGES_AWAITED=1 while
// its status chain, at any level, is at a step with merges-awaited: true
// (ASS-365, engine.js mergesAwaited: merge-request:await-dependencies then
// merges the awaited merge requests early, exit 5); undefined otherwise — no
// variation (a trigger's run), or no such step — so every other command runs
// as it always has.
function scriptEnv(state, project, variation) {
  if (!project || !variation) return undefined;
  return mergesAwaited(statusIn(project.engine, variation, enginesFor(state, project.id))) ? { MERGES_AWAITED: '1' } : undefined;
}

// passedOutput(step, output) — what a state-engine step hands the run it
// starts (ASS-365): the fields its pass-output names, from the step's own
// run's structured-output `output` (grouped-build's Merge the Awaited: the
// merge-request-ids Await Sequential Merge recorded), the run starting with
// them as its own; undefined when it names none or none is there, the run
// starting with none, as before.
function passedOutput(step, output) {
  const fields = (step['pass-output'] ?? []).filter(f => output && typeof output === 'object' && output[f] !== undefined);
  return fields.length ? Object.fromEntries(fields.map(f => [f, output[f]])) : undefined;
}

// Script steps run in the background (ASS-328): awaited, a long one — a
// ticket's two-hour test suite — held its project's whole tick, its ended
// agents unfinished and nothing dispatched, until it exited. Its command is
// started (startScript) and waited for SCRIPT_WAIT at most (ctx.scriptWait when
// set, tick.js), so a quick one — an agent.sh call — is still read in the tick that
// started it and its step moves on at once; then it is left running, and each
// later tick reads it, without waiting, once it has exited (scriptExit). Kept
// in memory.scripts: the step's key → { visit, done, exited }. While it is
// there its step is not started again — by a later tick, the chain, or its
// timer — nor its backoff, gate or disk hold asked, and its variation or run
// is not moved on by its exits until they are read (left running, it is said
// once, in the tick that started it): with the same facts,
// logging, backoff and last-script-failure as when it was awaited.
// Restarted while a script runs (AC3), control runs the step's script again:
// the new control remembers no visit run (scriptDue), and the old one stopped
// the scripts it ran on its way out (tick.js stopScripts, main.js) — never the
// two at once, and no exit waited for that no control would read.
const SCRIPT_WAIT = 5_000;

// scriptRunning(ctx, key, visit) — whether step `key` has a script started
// and not yet read; one a past visit left behind exited and unread (its
// variation moved off meanwhile, by a human say) is forgotten, so the step
// runs anew. One still running from a past visit is waited for: never two at
// once.
function scriptRunning(ctx, key, visit) {
  const entry = ctx.memory.scripts?.get(key);
  if (entry?.exited && entry.visit !== visit) ctx.memory.scripts.delete(key);
  return ctx.memory.scripts?.has(key) ?? false;
}

// startScript(ctx, key, visit, running, who) — `running`, the step's script
// (runScriptStep), kept under `key` until its exit is read; should it throw
// (it never does: a fake's), that is logged and read as exit code 1.
function startScript(ctx, key, visit, running, who) {
  const entry = { visit };
  entry.done = running.then(facts => { entry.exited = facts; }, error => { ctx.log(PHASE, `${who}: ${error.message}`); entry.exited = { exitCode: 1 }; });
  (ctx.memory.scripts ??= new Map()).set(key, entry);
}

// scriptExit(ctx, key, wait) — step `key`'s script's facts (exitCode,
// scriptOutput) once it has exited, forgotten as they are read; null while it
// still runs, after waiting up to `wait` ms for it (only in the tick that
// started it: a later tick never waits).
async function scriptExit(ctx, key, wait) {
  const entry = ctx.memory.scripts?.get(key);
  if (!entry) return null;
  if (!entry.exited && wait) {
    let timer;
    await Promise.race([entry.done, new Promise(resolve => { timer = setTimeout(resolve, wait); })]);
    clearTimeout(timer);
  }
  if (!entry.exited) return null;
  ctx.memory.scripts.delete(key);
  return entry.exited;
}

// scriptExited(ctx, who, key, exitCode, retried, values, step) — a script step's exit
// logged, once its exits are read. A failure holds the step a while before it
// runs again (backoff.js, under `key`; the callers skip it while held, before
// scriptDue counts the run); the retry is logged only when the step will be
// `retried` — no exit matched, or one back into itself — not when an exit
// takes it elsewhere (ASS-236). Given the `values` of the variation it ran
// for, a failure is kept on it as its last-script-failure (ASS-240: read by
// the grouped health check, run by another project's control). A timer
// step's waiting-exit-code (ASS-253: Blocked's await-fix, its fix not landed
// yet) is no failure but its "not yet": polled again on its timer, no
// backoff, and the failures before it forgotten — not in a row, so nothing
// escalates however long the wait.
async function scriptExited(ctx, who, key, exitCode, retried, values, step) {
  if (exitCode === 0) { ctx.log(PHASE, `${who}: script exited 0`); return; }
  if (step.action.mode === 'timer' && exitCode === step.action['waiting-exit-code']) {
    cleared(ctx.memory, key);
    ctx.log(PHASE, `${who}: script exited ${exitCode}, not yet; polled again in ${heldFor((step.action['timer-minutes'] ?? 0) * 60_000)}`);
    return;
  }
  const { until } = failed(ctx.memory, key, ctx.now().getTime(), `script exited ${exitCode}`);
  ctx.log(PHASE, `${who}: script exited ${exitCode}${retried ? `; tried again in ${heldFor(until - ctx.now().getTime())}` : ''}`);
  if (values) await ctx.attempt(PHASE, who, () => ctx.cli(['ticket:record-output', values.project, values['work-item'] ?? values.ticket, values.variation, 'last-script-failure', JSON.stringify({ step: who, 'exit-code': exitCode })]));
}

// agentNeedsWork(planned, step, ticket, variation) — the planner (plan.js
// planFor) would put an agent on the variation were its step a prompt: at a
// planning step (the queue's committed), while a planning slot is free; else
// when it holds an in-progress slot (reserved).
export function agentNeedsWork(planned, step, ticket, variation) {
  if (step['is-planning-stage'] === true) return planned.free.planning;
  return planned.reserved.some(r => r.key === ticket.key && r.variation === variation.name);
}

// One variation's step, moved on while an exit holds (see the module comment)
// — a sprint ticket's in its project's engine, or a backlog ticket's in its
// refinement engine (moves.js found, ASS-144), which takes no slot and
// enters no sub-engine.
async function runVariation(ctx, state, project, key, name) {
  for (let i = 0; i < CHAIN; i++, state = ctx.load()) {
    const at = found(state, { project: project.id, 'work-item': key, variation: name });
    const { ticket, variation, engine, backlog } = at;
    project = at.project;
    const stateId = variation?.['harness-status']?.state;
    const step = stepOf(engine, stateId);
    if (!step) return;
    const who = `${key} ${name} ${stateId}`;
    // An exit's start-sub-engine-at goes with its own target, not one max-visits redirects to.
    // A move into a step whose slot the variation neither holds nor can take waits (ASS-126; plan.js mayEnter).
    // A fast-tracked ticket's move that waits so is remembered, for its pre-emption (fast-track.js, ASS-83).
    // ASS-390: `startAt`, when given, the step the target's sub-engine starts at instead (a cleared block's resume-sub-at).
    const move = async (next, cause, startAt) => {
      if (next?.to == null) return false;
      if (!backlog && !mayMove(ctx, PHASE, state, project, variation, who, next.to)) { waitsForSeat(ctx.memory, project, ticket, variation, slotKind(stepOf(engine, next.to))); return false; }
      return moveTicket(ctx, PHASE, project, ticket, variation, next.to, next.reason === 'max-visits' ? 'max-visits' : undefined, startAt ?? (next.reason === 'exit' ? next.exit['start-sub-engine-at'] : undefined), cause);
    };
    // Held by what it depends on (ASS-195, ASS-355): held at this step, whatever it is but a done or a person's one —
    // nothing moved, started or judged, not even its VM's wait (stopped while it is held), so it goes on here once released.
    if (!backlog && awaitsDependencies(ctx, state, project, ticket, variation, who)) return;
    // Switched off (ASS-192): passed at once, before any VM, fact or action — a ticket limit on its target still holds it.
    if (!isActive(step)) {
      if (!await move(switchedOff(step), SKIPPED)) return;
      ctx.log(PHASE, `${who}: switched off, skipped (→ ${switchedOff(step).to})`);
      continue;
    }
    const vmWait = awaitsVm(ctx, state, project, variation, who);
    if (vmWait === NEVER_UP) await neverUp(ctx, PHASE, at, variation.vm.name, vmUpCeilingMs(state));   // ASS-387: its start pending past the ceiling: Blocked
    if (vmWait) return;   // its VM still starting (ASS-133), or its start still queued (ASS-387)
    const facts = ticketFacts(ctx, project, ticket, variation, undefined, runsInVm(step) ? variation.vm?.name : undefined);
    const changes = levelChanges(variation);
    switch (step.action?.type) {
      case 'none': {
        const planned = backlog ? null : planFor(state, project);
        facts.agentNeedsWork = !backlog && agentNeedsWork(planned, step, ticket, variation);
        if (!await move(nextState(step, engine, facts, changes))) {
          // Kept in the queue for want of a planning slot (committed): a fast-tracked ticket's wait, remembered (ASS-83).
          if (!backlog && step['is-planning-stage'] === true && !facts.agentNeedsWork) waitsForSeat(ctx.memory, project, ticket, variation, 'planning');
          // …or for room in the ready-for-build queue (ASS-362: max-tickets-ready-for-build), said once per visit.
          if (planned?.readyFull && step['is-planning-stage'] === true && !facts.agentNeedsWork) {
            warnOnce(ctx, `ready/${project.id}/${who}/${(variation['state-changes'] ?? []).length}`, `${who}: waits to enter planning: max-tickets-ready-for-build reached (${planned.ready.length} ready for build, ${planned.planning} in planning)`);
          }
          return;
        }
        break;
      }
      case 'script': {
        // A timer step polls: no gate holds it (moves.js TIMER, ASS-236), nor one marked before.
        // One already running (ASS-328) is not started again: its exit read once it has exited.
        const held = ticketKey(project.id, ticket.key, variation.name, step.id), timer = step.action.mode === 'timer';
        const running = `${project.id}/${who}`, visit = `${running}/${(variation['state-changes'] ?? []).length}`;
        const values = ticketValues(project, ticket, variation);
        let wait = 0;
        if (!scriptRunning(ctx, running, visit)) {
          if (waiting(ctx.memory, held, ctx.now().getTime()) || (!timer && heldAtGate(variation))) return;
          if (diskWaits(ctx, state, step, who) || setupWaits(ctx, project, step, who)) return;
          if (await memoryWaits(ctx, state, project, step, who, backlog ? null : { key: ticket.key, variation: variation.name, state: stateId })) return;   // ASS-398, ASS-404
          if (!scriptDue(ctx, who, running, visit, step, ctx.now().getTime())) return;
          startScript(ctx, running, visit, runScriptStep(ctx, step, values, who, variation, backlog ? undefined : scriptEnv(state, project, variation)), who);
          wait = ctx.scriptWait ?? SCRIPT_WAIT;
        }
        const exited = await scriptExit(ctx, running, wait);
        if (!exited) { if (wait) ctx.log(PHASE, `${who}: script still running; its exit is read once it has exited`); return; }   // the step stays where it is
        Object.assign(facts, exited);
        const next = nextState(step, engine, facts, changes);
        await scriptExited(ctx, who, held, facts.exitCode, next?.to == null || next.to === stateId, values, step);
        if (!await move(next, timer ? TIMER : undefined)) return;
        break;
      }
      case 'state-engine': {
        if (backlog) return;
        const run = state.transient.find(r => r.parent?.trigger == null && r.parent?.['work-item'] === key && r.parent.variation === name && r.parent.state === stateId);
        if (!run) {
          // The run, then the ticket entered into the sub-engine (sub-status
          // at its first step), which the run's later moves build on — or,
          // entered already at a named step (sub-status of this engine, set
          // by the exit's start-sub-engine-at, see moveTicket), the run there —
          // starting from the sub-status's output when it brings one (ASS-124).
          const parent = { 'work-item': key, variation: name, 'state-engine': project.engineName, state: stateId };
          const sub = variation['harness-status']['sub-status'];
          const entered = sub?.['state-engine'] === step.action.engine ? sub.state : undefined;
          const start = entered ?? firstStepId(enginesFor(state, project.id)[step.action.engine]);
          await ctx.cli(['transient-state-engine:create', project.id, step.action.engine, start, JSON.stringify(parent), ...(entered && sub.output ? [JSON.stringify(sub.output)] : [])]);
          if (!entered) await ctx.cli(['ticket:change-sub-state', project.id, key, name, step.action.engine, '-', start]);
          ctx.log(PHASE, `${who}: started a ${step.action.engine} run${entered ? ` at ${start}` : ''}`);
          return;
        }
        if (!run['is-done']) return;
        Object.assign(facts, { subEngineDone: true, subEngineState: run.state, structuredOutput: run['structured-output'] });
        const next = nextState(step, engine, facts, changes);
        if (next?.to == null) { warnOnce(ctx, run.id, `${who}: its ${run['state-engine']} run is done but no exit matched`); return; }
        // What the run returned stays with the ticket (record-output-as), once, before it moves:
        // kept with the run's id, which tells a restarted control it was kept (ASS-235).
        if (step['record-output-as'] && run['structured-output'] && typeof run['structured-output'] === 'object' && variation[step['record-output-as']]?.run !== run.id) {
          await ctx.cli(['ticket:record-output', project.id, key, name, step['record-output-as'], JSON.stringify({ ...run['structured-output'], run: run.id })]);
          ctx.log(PHASE, `${who}: its ${run['state-engine']} run's output recorded as ${step['record-output-as']}`);
        }
        // …or added to a list (append-output-to; ASS-107: Blocked's runs, for the next stay to learn from), with where it ended and where the ticket came from.
        if (step['append-output-to'] && ![variation[step['append-output-to']]].flat().some(e => e?.run === run.id)) {
          const kept = { ...(run['structured-output'] && typeof run['structured-output'] === 'object' ? run['structured-output'] : {}), 'ended-at': run.state, 'came-from': cameFrom(variation, stateId) ?? null, run: run.id };
          await ctx.cli(['ticket:record-output', project.id, key, name, step['append-output-to'], JSON.stringify(kept), 'append']);
          ctx.log(PHASE, `${who}: its ${run['state-engine']} run kept in ${step['append-output-to']}`);
        }
        // A block cleared by a landed fix (ASS-309) records the fix-landed cause, so the visit window
        // restarts — as does the cause the exit itself names (ASS-315: merge-gate-red, on release's rebuild exit).
        // ASS-384: one sent back to fix its own branch records own-branch-fix, restarting the window the same way;
        // ASS-390: one sent to wait for its dependency merge request, dependency-wait (engine.js clearCause).
        // Where a landed fix resumes it (ASS-343): the step its run's resume-at names, when engine.js whyNotResume allows it —
        // and, taken, the step its group starts at when the run names one of that group's sub-engine (ASS-390: resume-sub-at, Await Sequential Merge).
        const resume = resumeAt(facts), cleared = ownBranchFix(facts) ? 'the failure is in its own branch (own-branch fix)' : awaitsDependency(facts) ? 'it only waits for its dependency merge request' : 'the fix landed';
        const sub = resume !== undefined && resume === next.to ? resumeSubAt(facts) : undefined;
        const startAt = sub !== undefined && stepOf(enginesFor(state, project.id)[stepOf(engine, next.to)?.action?.engine], sub) ? sub : undefined;
        if (!await move(next, clearCause(facts) ?? next.exit?.cause, startAt)) return;   // gated: the run stays until the human opens the gate, then goes as orphaned (runTransient)
        if (resume !== undefined) ctx.log(PHASE, resume === next.to
          ? `${who}: ${cleared}; resumes at ${resume}${startAt ? ` at ${startAt}` : sub ? ` (its ${sub} not a step there)` : ''}: ${facts.structuredOutput['resume-why'] ?? 'no reason given'}`
          : `${who}: ${cleared}; resume-at ${resume} not taken (${whyNotResume(engine, next.to, resume) ?? 'its return could not be told'}), resumes at ${next.to}`);
        // Why it went there, when the run says (ai-feedback-short/-long in its output; ASS-75: Create VM's
        // out-of-disk reason, for Blocked for Human): the variation's health, set after the move, which clears it.
        const why = run['structured-output'];
        if (typeof why?.['ai-feedback-short'] === 'string') await ctx.cli(['ticket:set-ai-feedback', project.id, key, name, why['ai-feedback-short'], String(why['ai-feedback-long'] ?? '')]);
        await endRun(ctx, PHASE, run);
        break;
      }
      case 'human': {
        // A human's step moves by what the human recorded (human-review,
        // selected-variation, made since the variation arrived) or by what
        // needs no human (has-variations false): the dashboard moves on a
        // choice itself when it can tell where; this covers the rest — and a
        // backlog ticket's waiting points, by their exits (its questions answered).
        // A fast-tracked ticket's pass by its fast-tracked exit (passedItself) is logged and recorded.
        const next = nextState(step, engine, facts, changes), passed = passedItself(next), reject = rejected(next, facts);
        if (!await move(next, humanCause(next, facts))) return;
        if (passed) ctx.log(PHASE, `${who}: ${passed}`);
        if (reject) ctx.log(PHASE, `${who}: ${rejectedLine(reject, next.to)}`);
        break;
      }
      default: return;
    }
  }
}

// One run's step, moved on while an exit holds — against the run's output and,
// for a run working for a ticket (contextOf), that ticket's facts, so a step
// can read its ticket-system-status; its steps' max-visits counted over the
// run's own state-changes; a run that is done at a trigger's top
// level, or whose matching exit leads nowhere (the one step of a *-steps
// list), has finished and is removed.
async function runTransient(ctx, state, id) {
  for (let i = 0; i < CHAIN; i++, state = ctx.load()) {
    const run = state.transient.find(r => r.id === id);
    if (!run) return;
    const engine = engineSteps(enginesFor(state, run.project), run['state-engine']);
    const step = stepOf(engine, run.state);
    const who = `run ${run['state-engine']} ${run.id.slice(0, 8)} ${run.state}`;
    // Its step gone from its engine (renamed, or its list removed): nothing will ever move it, so it ends (ASS-236).
    if (!step) { await endRun(ctx, PHASE, run, `its step ${run.state} no longer exists`); return; }
    // A ticket step's own run (no trigger; its parent names the step) whose
    // ticket has left that step — moved by a human, a gap fixed, a run left
    // behind — has nothing to do, finished or not.
    if (run.parent?.trigger == null && run.parent?.['work-item'] != null && run.parent.state != null && found(state, { project: run.project, ...run.parent }).variation?.['harness-status']?.state !== run.parent.state) { await endRun(ctx, PHASE, run, 'its ticket has moved on'); return; }
    if (run['is-done']) {
      if (run.parent?.trigger != null) await endRun(ctx, PHASE, run, 'done');
      return;   // a ticket's or another run's sub-engine: its parent ends it
    }
    const context = contextOf(run, state.transient);
    const place = found(state, { project: run.project, 'work-item': context.workItem, variation: context.variation });
    const { project, ticket, variation, backlog } = place;
    // Its ticket held by what it depends on (ASS-195, ASS-355): the run stays at its step, nothing started, as the ticket's own step does.
    if (ticket && variation && !backlog && awaitsDependencies(ctx, state, project, ticket, variation, who)) return;
    // Switched off (ASS-192): passed at once, as a ticket's step is (runVariation).
    if (!isActive(step)) {
      const next = switchedOff(step);
      if (next.to == null || !await moveRun(ctx, PHASE, run, next.to, undefined, undefined, SKIPPED)) return;
      ctx.log(PHASE, `${context.workItem ?? '-'} ${context.variation ?? '-'} ${run['state-engine']}/${step.id}: switched off, skipped (→ ${next.to})`);
      continue;
    }
    const vmWait = awaitsVm(ctx, state, project, variation, who);
    if (vmWait === NEVER_UP) await neverUp(ctx, PHASE, place, variation.vm.name, vmUpCeilingMs(state));   // ASS-387
    if (vmWait) return;   // its ticket's VM still starting (ASS-133), or its start still queued (ASS-387)
    const facts = { ...(ticket && variation ? ticketFacts(ctx, project, ticket, variation, undefined, runsInVm(step) ? variation.vm?.name : undefined) : {}), structuredOutput: run['structured-output'], agentNeedsWork: true };
    // Its steps' visits are the run's own (ASS-66): counted over its moves, none from an earlier run or its parent.
    const changes = run['state-changes'] ?? [];
    const settle = async (next, output, cause) => {
      if (!next) return false;
      if (next.to == null) { await endRun(ctx, PHASE, run, 'finished'); return false; }
      return moveRun(ctx, PHASE, run, next.to, output, next.reason === 'max-visits' ? 'max-visits' : undefined, cause);   // gated: the run stays for the human
    };
    switch (step.action?.type) {
      case 'none': {
        if (!await settle(nextState(step, engine, facts, changes))) return;
        break;
      }
      case 'script': {
        // As a ticket's script step (runVariation): one already running (ASS-328) is not started again.
        const held = runKey(run.id, run.state), at = ticketPath(run, state.transient), timer = step.action.mode === 'timer';
        const running = `${run.id}/${run.state}`, visit = `${running}/${changes.length}`;
        const values = runValues(run, context);
        let wait = 0;
        if (!scriptRunning(ctx, running, visit)) {
          if (waiting(ctx.memory, held, ctx.now().getTime()) || (!timer && variation && at && heldAtGate(variation, run['state-engine'], run.state, at.path.length + 1))) return;
          if (diskWaits(ctx, state, step, who) || setupWaits(ctx, project, step, who)) return;
          if (await memoryWaits(ctx, state, project, step, who, ticket && variation && !backlog ? { key: ticket.key, variation: variation.name, state: variation['harness-status']?.state } : null)) return;   // ASS-398, ASS-404
          if (!scriptDue(ctx, who, running, visit, step, ctx.now().getTime())) return;
          startScript(ctx, running, visit, runScriptStep(ctx, step, values, who, variation, ticket && variation && !backlog ? scriptEnv(state, project, variation) : undefined), who);
          wait = ctx.scriptWait ?? SCRIPT_WAIT;
        }
        const exited = await scriptExit(ctx, running, wait);
        if (!exited) { if (wait) ctx.log(PHASE, `${who}: script still running; its exit is read once it has exited`); return; }   // the run stays where it is
        Object.assign(facts, exited);
        // A step that records its script's output (record-script-output) merges that JSON into the run's structured-output.
        const recorded = step['record-script-output'] === true && facts.scriptOutput && typeof facts.scriptOutput === 'object' && !Array.isArray(facts.scriptOutput) ? facts.scriptOutput : undefined;
        const next = nextState(step, engine, facts, changes);
        await scriptExited(ctx, who, held, facts.exitCode, !next || next.to === run.state, variation && values, step);   // to null: the run ends
        if (!await settle(next, recorded, timer ? TIMER : undefined)) return;
        break;
      }
      case 'state-engine': {
        const child = state.transient.find(r => r.parent?.['transient-state-engine'] === run.id && r.parent.state === run.state);
        if (!child) {
          // The run, then — for a ticket step's run — the ticket entered into it beneath this run's state (ASS-67).
          // …starting with what the step hands it (pass-output, ASS-365), from this run's output.
          const parent = { 'transient-state-engine': run.id, 'state-engine': run['state-engine'], state: run.state };
          const start = firstStepId(enginesFor(state, run.project)[step.action.engine]), at = ticketPath(run, state.transient), passed = passedOutput(step, run['structured-output']);
          await ctx.cli(['transient-state-engine:create', run.project, step.action.engine, start, JSON.stringify(parent), ...(passed ? [JSON.stringify(passed)] : [])]);
          if (at) await ctx.cli(['ticket:change-sub-state', run.project, at.workItem, at.variation, step.action.engine, '-', start, ...at.path, run.state]);
          ctx.log(PHASE, `${who}: started a ${step.action.engine} run`);
          return;
        }
        if (!child['is-done']) return;
        Object.assign(facts, { subEngineDone: true, subEngineState: child.state, structuredOutput: { ...(run['structured-output'] ?? {}), ...(child['structured-output'] ?? {}) } });
        const next = nextState(step, engine, facts, changes);
        if (!next) { warnOnce(ctx, child.id, `${who}: its ${child['state-engine']} run is done but no exit matched`); return; }
        await endRun(ctx, PHASE, child);
        if (!await settle(next, child['structured-output'])) return;
        break;
      }
      case 'human': {
        // As a ticket's human step (runVariation): by what the human recorded
        // at it, the variation's detailed step (ticket:human-review,
        // ticket:select-variation; ASS-67), its return walked over the run's own history —
        // or, a fast-tracked ticket's, passed by itself (passedItself), logged and recorded;
        // a rejection logged and recorded with cause operator-reject (ASS-228).
        const next = nextState(step, engine, facts, changes), passed = passedItself(next), reject = rejected(next, facts);
        if (!await settle(next, undefined, humanCause(next, facts))) return;
        if (passed) ctx.log(PHASE, `${context.workItem} ${context.variation} ${run['state-engine']}/${step.id}: ${passed}`);
        if (reject) ctx.log(PHASE, `${context.workItem} ${context.variation} ${run['state-engine']}/${step.id}: ${rejectedLine(reject, next.to)}`);
        break;
      }
      default: return;
    }
  }
}

const warnOnce = (ctx, key, text) => { if (!ctx.memory.warned.has(key)) { ctx.memory.warned.add(key); ctx.log(PHASE, text); } };

// runSteps(ctx, state) — every sprint variation and run not paused (moves.js
// isPaused: a pause stops every move but self-healing's own, so the ticket
// system is left alone too), not deleted, and without a gap
// (a ticket-system-status that is not its step's pairing: left, said once, to
// gap resolution — triggers.js detectGaps — unless its own sub-engine run
// answers it, engine.js answersGap, ASS-224), then every run, each moved on
// while its exits hold: a `none`
// step by its facts (agentNeedsWork from the planner, plan.js planFor); a `script` step by its
// command's exit code and output, run when due (scriptDue); a `state-engine`
// step by starting its run when none is (at its sub-engine's first step, or
// at the one the exit into it named, start-sub-engine-at), and by its run's
// output once that is done (the run then removed; its output kept on the variation first
// when the step has record-output-as, and its ai-feedback, when it has one, after the
// move); a `human` step by what the human recorded;
// `prompt` steps rest here. The variations go in rank order (rankSprint),
// so a free slot goes to the highest-ranked that can move into it; a move
// into a step whose slot the variation neither holds nor can take waits
// (moves.js mayMove, ASS-126), a done run kept for the next try. A move the
// variation gates (moves.js moveTicket) marks its work done and stops
// instead; a done sub-engine run whose ticket has since moved on (through the
// gate) is removed. Then every backlog ticket not paused, in refinement
// order (rankBacklog), at a step of its refinement engine, moved on the same
// way (ASS-144): its script steps run (Check the Answers), its human steps and
// done step left by their exits (questions answered, the operator's choice, a
// question not accepted); its prompt steps rest here, for dispatch.js.
// blockFailing(ctx, state) — each ticket step that failed BLOCK_AFTER times in
// a row (backoff.js, memory.toBlock) goes to Blocked, when its engine has that
// step and the variation is still at the step that failed: there an AI
// troubleshoots it and has its fix ticketed (engines/blocked) — unless it is
// worked by hand (engine.js isManual, ASS-166). So does the
// ticket a run's failing step is inside (ASS-67: the run a ticket step's,
// ticketPath, and still at that step); a trigger's run blocks nothing. A
// step inside Blocked (ASS-226) — Blocked's own, or one of its run's — goes to
// Blocked for Human instead, its health (ai-feedback, set after the move,
// which clears it) the failing step and its last error. Its backoff is
// cleared only when the ticket moved: one skipped keeps doubling.
async function blockFailing(ctx, state) {
  for (const key of [...(ctx.memory.toBlock ?? [])]) {
    ctx.memory.toBlock.delete(key);
    const [projectId, workItem, name, at] = key.startsWith('run/') ? runTicket(state, key) : key.split('/');
    if (projectId == null) continue;
    const { project, ticket, variation, engine } = found(state, { project: projectId, 'work-item': workItem, variation: name });
    const to = at === 'blocked' ? 'blocked-for-human' : 'blocked';
    if (!variation || isManual(ticket) || variation['harness-status']?.state !== at || !stepOf(engine, to) || at === 'blocked-for-human') continue;
    const why = `failed ${BLOCK_AFTER} times in a row`, feedback = `${key.split('/').at(-1)} ${why}: ${ctx.memory.backoff.get(key)?.error ?? 'no error said'}`;
    await ctx.attempt(PHASE, `${workItem} ${name}`, async () => {
      if (!await moveTicket(ctx, PHASE, project, ticket, variation, to, why)) return;
      cleared(ctx.memory, key);
      if (to === 'blocked-for-human') await ctx.cli(['ticket:set-ai-feedback', project.id, workItem, name, feedback, feedback]);
    });
  }
}

// stderrOf(dir) — what the agent whose session is at `dir` said on stderr:
// { last, tail } — its last line, and its last 10 (at most 2000 characters).
function stderrOf(dir) {
  const lines = (readSession(dir) ?? []).filter(l => l.startsWith('[stderr] ')).map(l => l.slice(9)).slice(-10);
  return { last: lines.at(-1) ?? 'nothing on stderr', tail: lines.join('\n').slice(-2000) };
}

// escalateFailedStarts(ctx, state) — each step whose agent could not start
// FAILED_STARTS times in a row (backoff.js counted, ASS-167) sends its ticket
// to Blocked for Human — a run's step the ticket it is inside, as blockFailing
// finds it, so one of Blocked's own steps too — when its engine has that step,
// the variation is still at the step and not worked by hand; its health
// (ai-feedback, set after the move, which clears it) the last agent's stderr.
// Its counts and backoff are cleared, and it is not blocked as well.
async function escalateFailedStarts(ctx, state) {
  for (const [key, { count, dir }] of [...(ctx.memory.failedStarts ?? [])]) {
    if (count < FAILED_STARTS) continue;
    ctx.memory.failedStarts.delete(key);
    ctx.memory.toBlock?.delete(key);
    cleared(ctx.memory, key);
    const [projectId, workItem, name, at] = key.startsWith('run/') ? runTicket(state, key) : key.split('/');
    if (projectId == null) continue;
    const { project, ticket, variation, engine } = found(state, { project: projectId, 'work-item': workItem, variation: name });
    if (!variation || isManual(ticket) || variation['harness-status']?.state !== at || !stepOf(engine, 'blocked-for-human') || at === 'blocked-for-human') continue;
    const { last, tail } = stderrOf(dir);
    await ctx.attempt(PHASE, `${workItem} ${name}`, async () => {
      if (await moveTicket(ctx, PHASE, project, ticket, variation, 'blocked-for-human', `could not start ${FAILED_STARTS} times in a row`)) await ctx.cli(['ticket:set-ai-feedback', project.id, workItem, name, `agent could not start ${FAILED_STARTS} times: ${last}`, tail]);
    });
  }
}

// runTicket(state, key) — for a run's backoff key (run/<id>/<state>) whose run
// is still at that state and works for a ticket step: [project, work-item,
// variation, the ticket's top-level state it is inside]; [] otherwise.
function runTicket(state, key) {
  const [, id, at] = key.split('/');
  const run = state.transient.find(r => r.id === id);
  const of = run?.state === at ? ticketPath(run, state.transient) : null;
  return of ? [run.project, of.workItem, of.variation, of.state] : [];
}

// stopAtSpendingLimit(ctx, state) — each sprint ticket whose spend has
// reached its limit (spend.js overSpent, ASS-191, its running agents' spend
// so far among it, ASS-270; dispatch starts it no agent)
// has each active variation — not deleted, paused or worked by hand
// (isPaused), done or at Blocked for Human already — with no agent on it
// (a running one is shut down first, supervise.js, then its move is made) moved to
// Blocked for Human, when its engine has that step, its health (ai-feedback, short and long,
// set after the move, which clears it) "spending limit reached: $X of $Y".
// Handed back with the limit raised, it works on; not raised, it comes back.
async function stopAtSpendingLimit(ctx, state) {
  for (const project of state.projects) for (const ticket of project.tickets) {
    const over = overSpent(ticket, state.harness, project.json, runningOn(state.running, project.id, ticket.key));
    if (!over || !stepOf(project.engine, 'blocked-for-human')) continue;
    const reason = `spending limit reached: ${spendText(over.spend, over.limit)}`;
    for (const v of ticket.variations ?? []) {
      const at = v['harness-status']?.state;
      if (v['is-deleted'] || at === 'blocked-for-human' || isDoneStep(project.engine, at) || isPaused(state, project.id, ticket.key, v.name)) continue;
      if (state.assignments.some(a => a.project === project.id && a['work-item'] === ticket.key && (a.variation == null || a.variation === v.name))) continue;
      await ctx.attempt(PHASE, `${ticket.key} ${v.name}`, async () => {
        if (await moveTicket(ctx, PHASE, project, ticket, v, 'blocked-for-human', reason)) await ctx.cli(['ticket:set-ai-feedback', project.id, ticket.key, v.name, reason, reason]);
      });
    }
  }
}

export async function runSteps(ctx, state) {
  await escalateFailedStarts(ctx, state);
  await blockFailing(ctx, ctx.load());
  await stopAtSpendingLimit(ctx, ctx.load());
  state = ctx.load();
  for (const project of state.projects) {
    if (!project.engine || !project.sprint) continue;
    // In rank order, so the highest-ranked takes a slot first (ASS-126).
    for (const ticket of rankSprint(project.tickets, { engine: project.engine })) for (const v of ticket.variations ?? []) {
      if (v['is-deleted'] || isPaused(state, project.id, ticket.key, v.name)) continue;
      const stateId = v['harness-status']?.state, paired = pairedStatus(project.engine, stateId), status = ticket['ticket-system-status'];
      if (paired != null && status != null && status !== paired && !answersGap(project.engine, v, status, enginesFor(state, project.id))) { warnOnce(ctx, `gap/${project.id}/${ticket.key}/${v.name}/${stateId}`, `${ticket.key} ${v.name} ${stateId}: the ticket system says ${status}, the step pairs ${paired}; left to gap resolution`); continue; }
      await ctx.attempt(PHASE, `${ticket.key} ${v.name}`, () => runVariation(ctx, ctx.load(), project, ticket.key, v.name));
    }
  }
  // Then each backlog ticket at a step of its refinement engine, in refinement order (ASS-144).
  for (const project of state.projects) {
    if (!project.refinement) continue;
    for (const ticket of rankBacklog(project.backlog ?? [])) for (const v of ticket.variations ?? []) {
      if (v['is-deleted'] || isPaused(state, project.id, ticket.key, v.name)) continue;
      await ctx.attempt(PHASE, `${ticket.key} ${v.name}`, () => runVariation(ctx, state, project, ticket.key, v.name));
    }
  }
  for (const run of state.transient) {
    if (!state.projects.some(p => p.id === run.project)) continue;   // another project's control's (ASS-9)
    const { workItem, variation } = contextOf(run, state.transient);   // the pause is on the variation (ASS-225)
    if (isPaused(state, run.project, workItem, variation, run.id)) continue;
    await ctx.attempt(PHASE, `run ${run.id.slice(0, 8)}`, () => runTransient(ctx, ctx.load(), run.id));
  }
}
