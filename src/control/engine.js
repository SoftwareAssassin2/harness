// Reading a state engine (engines/<name>/state-engine.json) for control: its
// steps, whether a step's exit conditions hold
// against the facts control has gathered, and where a ticket variation goes
// next, and which steps only wait on a person (waitsOnHuman,
// waitsOnTicketSystem: ASS-355, never held for a dependency). Pure: plain
// data in, plain data out, nothing read or written.

// Every step list an engine holds: `steps` and each top-level `*-steps` / `*-trigger`.
const isStepList = (key, list) => (key === 'steps' || /-(steps|trigger)$/.test(key)) && Array.isArray(list);
const allSteps = engine => Object.entries(engine ?? {}).flatMap(([key, list]) => isStepList(key, list) ? list : []);

// markOff(name, steps, entries) — engine `name`'s steps with each one an entry
// "<engine>/<step-id>" names switched off ("is-active": false; ASS-209: a
// project's switched-off-steps), copied; the others as they are.
export const markOff = (name, steps, entries) => steps.map(s => (entries.includes(`${name}/${s.id}`) ? { ...s, 'is-active': false } : s));

// switchOff(engines, entries) — `engines` ({ [name]: its JSON }) with the steps
// `entries` name switched off in every list (markOff); `engines` itself when none.
export const switchOff = (engines, entries = []) => (!entries.length ? engines : Object.fromEntries(Object.entries(engines).map(([name, engine]) =>
  [name, Object.fromEntries(Object.entries(engine).map(([key, list]) => [key, isStepList(key, list) ? markOff(name, list, entries) : list]))])));

// stepOf(engine, id) — the step with that id in any of the engine's lists, or undefined.
export const stepOf = (engine, id) => allSteps(engine).find(s => s.id === id);

// engineSteps(engines, name) — `engines` maps engine names to their JSON; `name`
// is "<engine>" for its `steps` or "<engine>/<key>" for one of its `*-steps` /
// `*-trigger` lists. Returns the list as { steps }, an engine the functions
// here take; undefined when there is no such list.
export function engineSteps(engines, name) {
  const [engine, key = 'steps'] = name.split('/');
  const steps = engines?.[engine]?.[key];
  return Array.isArray(steps) ? { steps } : undefined;
}

// evaluateCondition(condition, facts) — whether a condition holds. Facts:
// agentNeedsWork, turnComplete, exitCode, ticketSystemStatus,
// structuredOutput, scriptOutput, subEngineDone, subEngineState (the step its
// done run rests at), variationCount, variation,
// humanReview { state, decision }, selectedVariation { state }, stepId (the
// step the condition belongs to), fileUpdated(file, since),
// scriptSucceeds(command) and questions() (the ticket's questions, ASS-144)
// answering for the ticket, and fastTracked (the ticket is, ASS-83). Throws on an unknown leaf.
// A question is open — waiting on the operator — unless it is Answered,
// Answer Accepted or Assumed (ASS-248: a non-blocking one closed on its
// assumption): Asked, Answer Rejected, or a status none of the known ones
// (ASS-170), so a malformed question holds its ticket rather than releasing it.
// It blocks (ASS-248) unless question:ask flagged it blocking: false — one
// asked before the flag counts as blocking; blocksTicket, open and blocking:
// what holds a ticket for the operator.
export const isOpenQuestion = q => !['Answered', 'Answer Accepted', 'Assumed'].includes(q.status);
export const isBlockingQuestion = q => q.blocking !== false;
export const blocksTicket = q => isOpenQuestion(q) && isBlockingQuestion(q);
export function evaluateCondition(condition, facts) {
  const [[key, value]] = Object.entries(condition);
  const has = output => output != null && Object.entries(value).every(([k, v]) => output[k] === v);
  const questions = () => facts.questions?.() ?? [];
  switch (key) {
    case 'all': return value.every(c => evaluateCondition(c, facts));
    case 'not': return !evaluateCondition(value, facts);
    case 'always': return value === true;
    case 'agent-needs-work': return (facts.agentNeedsWork === true) === value;
    case 'turn-complete': return (facts.turnComplete === true) === value;
    case 'file-updated': return Boolean(facts.fileUpdated?.(value.file, value.since));
    case 'structured-output': return has(facts.structuredOutput);
    case 'script-output': return has(facts.scriptOutput);
    case 'script-succeeds': return Boolean(facts.scriptSucceeds?.(value));
    case 'exit-code': return facts.exitCode === value;
    // null is an unknown status (ASS-282): none synced (null) or none on the facts (undefined) alike.
    case 'ticket-system-status': return (facts.ticketSystemStatus ?? null) === value;
    case 'human-review': return facts.humanReview?.state === facts.stepId && facts.humanReview.decision === value;
    case 'variation-selected': return (facts.selectedVariation?.state === facts.stepId) === value;
    case 'has-variations': return ((facts.variationCount ?? 0) > 1) === value;
    // A fast-tracked ticket (ASS-151): a human step's exit on it passes the step with no human — the system taking care of itself.
    case 'fast-tracked': return (facts.fastTracked === true) === value;
    case 'is-done':
    case 'workflow-ended': return (facts.subEngineDone === true) === value;
    // Which done step it ended at (ASS-68): a group leaves its sub-engine for Blocked, or loops into another group.
    case 'sub-engine-ended-at': return facts.subEngineDone === true && facts.subEngineState === value;
    // The ticket's questions (ASS-144), the blocking ones alone (ASS-248: a non-blocking one never holds):
    // one open (blocksTicket); every one Answer Accepted (none is all).
    case 'open-questions': return questions().some(blocksTicket) === value;
    case 'all-questions-accepted': return questions().filter(isBlockingQuestion).every(q => q.status === 'Answer Accepted') === value;
    case 'structured-ticket-variation-array-check': return (facts.variation?.[value['member-name']] ?? []).length >= value['min-length'];
    default: throw new Error(`unknown condition "${key}"`);
  }
}

// firstExit(step, facts) — the first of the step's exit-events whose condition holds, or null.
export const firstExit = (step, facts) => (step['exit-events'] ?? []).find(e => evaluateCondition(e.condition, { ...facts, stepId: step.id })) ?? null;

// Where a variation at `stateId` goes back to on an exit that follows the
// return-to-state, walking `stateChanges` back from the end (the TUI's rule):
// the step it came from sends it to that step's
// return-to-state when it has one; else, when that step follows the
// return-to-state itself (as blocked and blocked-for-human do), the walk goes
// on to the step before it; else it is that step. Null when history does not say.
export function returnTo(stateId, engine, stateChanges) {
  for (let at = stateId, i = stateChanges.length; ;) {
    i = stateChanges.findLastIndex((c, k) => k < i && c['to-state'] === at);
    if (i < 0) return null;
    at = stateChanges[i]['from-state'];
    const step = stepOf(engine, at);
    if (step?.['return-to-state']) return step['return-to-state'];
    if (!step?.['follow-return-to-state']) return at;
  }
}

// resolveTarget(exit, step, engine, stateChanges, facts) — the step id an exit
// leads to: move-to-state-from-structured-output, the named field of
// facts.structuredOutput, when it names a step of the engine — else (missing
// or unknown) the exit's move-to-state, its fallback (ASS-231), or null —
// move-to-state-from-human-review the same, from the human's choice
// (facts.humanReview: a Human Review rejection's return-to, ASS-228);
// move-to-state; else follow-return-to-state (or the older
// follow-return-to), see returnTo — or, on a block cleared by a landed fix,
// the step its run's resume-at names when whyNotResume allows it (ASS-343).
// Null when it cannot be told.
export function resolveTarget(exit, step, engine, stateChanges = [], facts = {}) {
  const output = exit['move-to-state-from-structured-output'], choice = exit['move-to-state-from-human-review'];
  const field = output ?? choice, named = field && (output ? facts.structuredOutput : facts.humanReview)?.[field];
  if (field) return stepOf(engine, named) ? named : exit['move-to-state'] ?? null;
  if (exit['move-to-state']) return exit['move-to-state'];
  if (exit['follow-return-to-state'] || exit['follow-return-to']) {
    const back = returnTo(step.id, engine, stateChanges), wanted = resumeAt(facts);
    return wanted !== undefined && back != null && whyNotResume(engine, back, wanted) == null ? wanted : back;
  }
  return null;
}

// resumeAt(facts) — the step a block cleared by a landed fix (clearedByFix)
// asks to resume at (ASS-343): its run's structured-output resume-at
// (grouped-blocked's resume-step, ticket:fix-resume-step) — or one sent back
// to fix its own branch (ownBranchFix, ASS-384: ticket:own-branch-fix's
// resume-at, Generate Solution's group) — or one sent to wait for its
// dependency merge request (awaitsDependency, ASS-390: ticket:dependency-wait's
// resume-at, Build's group); undefined for any other move, or when it names none.
export const resumeAt = facts => ((clearedByFix(facts) || ownBranchFix(facts) || awaitsDependency(facts)) && facts.structuredOutput['resume-at'] != null ? facts.structuredOutput['resume-at'] : undefined);

// resumeSubAt(facts) — the step within resume-at's group the group's run
// starts at, when the run names one (ASS-390: ticket:dependency-wait's
// resume-sub-at, Build's await-dependencies — Await Sequential Merge — so the
// ticket waits there before its tests, not from Refresh); undefined when
// resumeAt is, or it names none. steps.js takes it only with resume-at, and
// only when it is a step of that group's sub-engine.
export const resumeSubAt = facts => (resumeAt(facts) !== undefined && typeof facts.structuredOutput['resume-sub-at'] === 'string' && facts.structuredOutput['resume-sub-at'] !== '' ? facts.structuredOutput['resume-sub-at'] : undefined);

// whyNotResume(engine, back, wanted) — why a ticket whose fix landed may not
// resume at `wanted` instead of `back`, the step it blocked at, which the
// return-to-state walk (returnTo) would send it to; null when it may (ASS-343).
// It may resume at a step of the engine's `steps` that comes at or before
// `back` in their list order and does real work: no done step, blocked or
// detour state (sequence 0, or one that follows the return-to-state:
// Blocked, Self-Healing, Requirements Changed), and no step of a human or of
// nothing (Backlog, Committed). Earlier than `back`, the steps after it run
// again, so what the fix changed is made afresh.
export function whyNotResume(engine, back, wanted) {
  const steps = engine?.steps ?? [];
  if (typeof wanted !== 'string' || wanted === '') return 'it names no step';
  const at = steps.findIndex(s => s.id === wanted), from = steps.findIndex(s => s.id === back);
  if (at < 0) return `${wanted} is no step of the engine`;
  if (from < 0) return `${back}, the step it blocked at, is no step of the engine`;
  const s = steps[at];
  if (s['is-done'] === true) return `${wanted} is a done step`;
  if (s['is-blocked-state'] === true || s.sequence === 0 || s['follow-return-to-state'] || s['follow-return-to']) return `${wanted} is a blocked or detour state`;
  if (['none', 'human'].includes(s.action?.type)) return `${wanted} does no work (its action is ${s.action.type})`;
  if (at > from) return `${wanted} comes after ${back}, the step it blocked at`;
  return null;
}

// visitsInto(stateChanges, stepId, initialState) — how many times the
// variation has been in the step at this level of its history, as the TUI
// counts it: the changes into it, plus one when its history starts there (the
// first change's from-state, or `initialState` when there is no change yet).
// A change made within the step (sub-state-change: a move inside a group's
// run) is no visit (ASS-130).
export const visitsInto = (stateChanges = [], stepId, initialState) =>
  stateChanges.filter(c => c['to-state'] === stepId && !c['sub-state-change']).length + ((stateChanges[0]?.['from-state'] ?? initialState) === stepId ? 1 : 0);

// A human's resolution of a blocked human step (Blocked for Human, ASS-22): a
// move out of it to anywhere but its own move-to-state exits (Have AI Try
// Again's blocked) — the Resolved exit, or a human moving the ticket on.
function isResolution(engine, from, to) {
  if (!isBlockedState(engine, from) || !isHumanStep(engine, from)) return false;
  return !(stepOf(engine, from)['exit-events'] ?? []).some(e => e['move-to-state'] === to);
}

// FIX_LANDED — the cause of a move that clears a block because the fix it
// waited on landed (ASS-309: grouped-blocked's await-fix, whose ticket:fix-landed
// says landed). Recorded on the clearing change (MOVE_CAUSE, moves.js causeEnv),
// so sinceResolution restarts the step-visit window at it, and the moves after it
// count afresh too — else the counts the ticket was blocked with send it straight
// back to Blocked (ASS-303: build 5/5, test 3/3).
export const FIX_LANDED = { cause: 'fix-landed' };
// clearedByFix(facts) — the current move clears a block because the fix landed:
// the sub-engine run (grouped-blocked) is done and its recorded output says
// landed (facts.structuredOutput.landed; steps.js record-script-output). Tells a
// landed-fix clear apart from the retry and other (needs-fix:false, repaired) clears.
export const clearedByFix = facts => facts?.subEngineState === 'done' && facts?.structuredOutput?.landed === true;

// OWN_BRANCH_FIX — the cause of a move that clears a block by sending the
// ticket back to fix a failure in its own branch (ASS-384: grouped-blocked's
// ticket:own-branch-fix — not on the latest master, in a file the variation's
// branch adds or changes — its finding in the execution plan). Recorded on
// the clearing change as FIX_LANDED is, and for the same reason: the visit
// counts the ticket was blocked with would send it straight back to Blocked
// before Generate Solution could make the fix. ticket:fix-attempts's budget,
// counted across these returns, bounds the loop instead.
export const OWN_BRANCH_FIX = { cause: 'own-branch-fix' };
// ownBranchFix(facts) — the current move is such a return: the sub-engine run
// is done and its recorded output says own-branch-fix (ticket:own-branch-fix).
export const ownBranchFix = facts => facts?.subEngineState === 'done' && facts?.structuredOutput?.['own-branch-fix'] === true;

// DEPENDENCY_WAIT — the cause of a move that clears a block by sending the
// ticket to wait for one of its own dependency merge requests to merge
// (ASS-390 AC5: grouped-blocked's dependency-wait, ticket:dependency-wait —
// Classify found the block only waits for it). Recorded on the clearing change
// as FIX_LANDED and OWN_BRANCH_FIX are, and for the same reason: the visit
// counts the ticket was blocked with would send it straight back to Blocked.
// ticket:fix-attempts counts these returns too, bounding the loop.
export const DEPENDENCY_WAIT = { cause: 'dependency-wait' };
// awaitsDependency(facts) — the current move is such a return: the sub-engine
// run is done and its recorded output says awaits-dependency.
export const awaitsDependency = facts => facts?.subEngineState === 'done' && facts?.structuredOutput?.['awaits-dependency'] === true;
// clearCause(facts) — the cause a move clearing a block records, of those that
// restart the visit window (FIX_LANDED, OWN_BRANCH_FIX, DEPENDENCY_WAIT); undefined for any other move.
export const clearCause = facts => (clearedByFix(facts) ? FIX_LANDED : ownBranchFix(facts) ? OWN_BRANCH_FIX : awaitsDependency(facts) ? DEPENDENCY_WAIT : undefined);

// MERGE_GATE_RED — the cause of the move an exit makes when the merge gate went red
// (ASS-315: v2-release's merge-pull-request failing npm test on the rebased branch, or no clean
// rebase, ends its run at rebuild, and release's exit for it sends the ticket back to Build).
// The exit itself names it, in the engine JSON ("cause" on harness-development-v2's release
// rebuild exit; steps.js records it), so the window restarts there for every step the return trip
// passes back through — but never for the step the move left (release), whose own max-visits still
// bounds a gate that never goes green (AC2). Else a green, cleanly rebased change is sent to
// Blocked at Build's exit because the reds left Test at its cap (ASS-311).
export const MERGE_GATE_RED = { cause: 'merge-gate-red' };

// NO_OP_ROUND — the cause of the move that ends a round which changed nothing
// (ASS-388): an Address Merge Request Feedback round that pushed no commit to
// any merge request it was sent for and replied to or resolved nothing
// (merge-request:feedback-round), its check step's exit naming the cause in
// the engine JSON (grouped-merge's check-feedback-round; a project Release's
// own), the move going back to the step the round left (the check). The
// round is no visit: withoutNoOpRounds drops it from the history visits are
// counted over, and the move itself is never redirected by max-visits.
export const NO_OP_ROUND = { cause: 'no-op-round' };

// withoutNoOpRounds(stateChanges) — the changes with each no-op round taken
// out (ASS-388): a change with cause no-op-round returns to the step the round
// started from, so it and every change back to and including the last one out
// of that step (the check's move into Address Merge Request Feedback) are
// dropped, as if the round had not been. A sub-state-change (a ticket's record
// of a move inside a group's run) is no visit anyway and is left; with no move
// out of that step before it, the no-op change alone is dropped.
export function withoutNoOpRounds(stateChanges = []) {
  const kept = [];
  for (const c of stateChanges) {
    if (c.cause !== NO_OP_ROUND.cause || c['sub-state-change']) { kept.push(c); continue; }
    const start = kept.findLastIndex(k => k['from-state'] === c['to-state'] && !k['sub-state-change']);
    if (start >= 0) kept.length = start;
  }
  return kept;
}

// sinceResolution(engine, stateChanges, targetStep) — the changes from the last
// resolution of Blocked for Human, the last move out of a done step (a
// ticket reopened from Done, ASS-130), the last move out of a human step
// with restarts-visit-count (ASS-264: the family's Too Large, whose operator
// sends a ticket back to be groomed and estimated afresh), the last block
// cleared by a landed fix (ASS-309: its change's cause is fix-landed), or the
// last merge-gate red (ASS-315: cause merge-gate-red), on (it included), the
// history step visits are counted over; the whole history when there has been
// none. `targetStep` is the step whose visits are being counted: a merge-gate
// red is no restart for the step it left (release), so that step's own visits
// keep accumulating across reds and its max-visits still bounds the gate.
export function sinceResolution(engine, stateChanges = [], targetStep) {
  const at = stateChanges.findLastIndex(c => isResolution(engine, c['from-state'], c['to-state']) || isDoneStep(engine, c['from-state']) || restartsVisits(engine, c['from-state']) || c.cause === FIX_LANDED.cause || c.cause === OWN_BRANCH_FIX.cause || c.cause === DEPENDENCY_WAIT.cause
    || (c.cause === MERGE_GATE_RED.cause && c['from-state'] !== targetStep));
  return at < 0 ? stateChanges : stateChanges.slice(at);
}

// nextState(step, engine, facts, stateChanges) — where the variation moves
// from `step`: { to, exit, reason } — reason 'exit' for the first matching
// exit's target, 'max-visits' when that target (or the one it redirects to)
// has been visited `max-visits` times already and its `on-max-visits` is taken
// instead, 'unresolved' with `to` null when the exit's target cannot be told.
// Null when no exit matches, so a step without exits (done) rests. Visits
// count since the last resolution of Blocked for Human (sinceResolution, over
// the step being counted), and from none on the move that is itself one, itself
// a block cleared by a landed fix (clearedByFix, ASS-309) or sent back to fix its
// own branch (ownBranchFix, ASS-384) or to wait for its dependency merge
// request (awaitsDependency, ASS-390), or itself a merge-gate
// red's return (ASS-315: else the first red is redirected by the counts it is
// meant to restart), or itself a no-op round's return (ASS-388: NO_OP_ROUND;
// and a no-op round anywhere in the history is no visit, withoutNoOpRounds),
// or itself a move out of a step with restarts-visit-count
// (ASS-399: grouped-plan's Awaiting the Plan Answer, whose return to Write
// Execution Plan the old counts would send to Blocked); the return walk reads it all.
export function nextState(step, engine, facts, stateChanges = []) {
  const exit = firstExit(step, facts);
  if (!exit) return null;
  let to = resolveTarget(exit, step, engine, stateChanges, facts);
  if (to == null) return { to: null, exit, reason: 'unresolved' };
  // ASS-388: a no-op round's return is no visit, so never redirected; every other count skips the no-op rounds.
  const counted = isResolution(engine, step.id, to) || restartsVisits(engine, step.id) || clearCause(facts) || exit.cause === MERGE_GATE_RED.cause || exit.cause === NO_OP_ROUND.cause
    ? [] : withoutNoOpRounds(sinceResolution(engine, stateChanges, to));
  let reason = 'exit';
  for (const seen = new Set(); !seen.has(to); reason = 'max-visits') {
    seen.add(to);
    const target = stepOf(engine, to);
    if (target?.['max-visits'] == null || !target['on-max-visits'] || visitsInto(counted, to) < target['max-visits']) break;
    to = target['on-max-visits'];
  }
  return { to, exit, reason };
}

// restartsVisits(engine, stateId) — the step has restarts-visit-count: true (ASS-264; validate.js keeps it to human steps).
const restartsVisits = (engine, stateId) => stepOf(engine, stateId)?.['restarts-visit-count'] === true;
// isDoneStep(engine, stateId) — the step has is-done: true.
export const isDoneStep = (engine, stateId) => stepOf(engine, stateId)?.['is-done'] === true;
// pairedStatus(engine, stateId) — the step's paired-ticket-system-status, or undefined.
export const pairedStatus = (engine, stateId) => stepOf(engine, stateId)?.['paired-ticket-system-status'];
// isPlanning(engine, stateId) — the step has is-planning-stage: true.
export const isPlanning = (engine, stateId) => stepOf(engine, stateId)?.['is-planning-stage'] === true;
// isBlockedState(engine, stateId) — the step has is-blocked-state: true.
export const isBlockedState = (engine, stateId) => stepOf(engine, stateId)?.['is-blocked-state'] === true;
// isActive(step) — the step is switched on: its is-active is not false (ASS-192; absent is on).
// A switched-off step is passed at once by its first exit's move-to-state (steps.js), never waited, dispatched or gated at.
export const isActive = step => step?.['is-active'] !== false;
// isHumanStep(engine, stateId) — the step's action is a human's.
export const isHumanStep = (engine, stateId) => stepOf(engine, stateId)?.action?.type === 'human';
// isManual(ticket) — the ticket is worked by hand (ASS-166: its
// worked-manually, ticket:set-manual), so control leaves it alone: no move,
// dispatch, slot, VM or run about it, no gap resolution, no pre-emption.
// It is no pause — is-paused is set and cleared apart from it.
export const isManual = ticket => ticket?.['worked-manually'] != null;
// isHeld(ticket, variation) — control leaves the variation where it is: it
// or its ticket is paused (is-paused), or the ticket is worked by hand (isManual).
export const isHeld = (ticket, variation) => ticket?.['is-paused'] === true || variation?.['is-paused'] === true || isManual(ticket);

// statusOf(engines, engineName, variation) — where a ticket variation stands
// (ASS-67): `chain`, every level of its harness-status top first, each {
// state-engine, state, step } — the top level's engine `engineName` (the
// variation's own when not given), each sub-status's its own, `step` that
// engine's step of that id (engineSteps; undefined when not known); `state`
// and `step` the top level's, its high-level state; `detail` and
// `detailStep` the deepest's, its detailed step; `planned`, whether it has
// finished planning and only waits to leave it (finishedPlanning, ASS-362).
// Without a harness-status, chain [] and the rest undefined (planned false).
export function statusOf(engines, engineName, variation) {
  const chain = [];
  for (let at = variation?.['harness-status']; at?.state != null; at = at['sub-status']) {
    const name = (chain.length ? undefined : engineName) ?? at['state-engine'];
    chain.push({ 'state-engine': name, state: at.state, step: name == null ? undefined : stepOf(engineSteps(engines, name), at.state) });
  }
  const top = chain[0], deep = chain.at(-1);
  return { chain, state: top?.state, step: top?.step, detail: deep?.state, detailStep: deep?.step, planned: finishedPlanning(engines, chain, variation) };
}

// finishedPlanning(engines, chain, variation) — the status `chain` (statusOf's,
// `engines` beneath it) has finished planning (ASS-362): its top-level step is
// a planning one (is-planning-stage) that runs a sub-engine, its deepest step
// in there is an is-done one — the run over, the step about to move by its
// own exits — and among those exits is one out of planning to a step past it
// (leavesPlanning: grouped Plan's to Build), so it is the plan finished, not
// a planning step on the way to another (grouped Setup's done goes on to
// Plan). And it waits on no person (humanWaits: a gate on leaving the step
// keeps it as it is). Generic: any planning sub-engine's is-done step. A
// flat engine's steps have no sub-engine, so it is never so.
export function finishedPlanning(engines, chain, variation) {
  const top = chain[0]?.step;
  if (chain.length < 2 || top?.['is-planning-stage'] !== true || chain.at(-1).step?.['is-done'] !== true) return false;
  const steps = engineSteps(engines, chain[0]['state-engine']);
  return (top['exit-events'] ?? []).some(e => leavesPlanning(stepOf(steps, e['move-to-state']))) && !humanWaits(chain, variation);
}

// leavesPlanning(step) — a step past planning that holds a seat (not done, a
// detour or the blocked state): where a finished plan goes next.
const leavesPlanning = step => step != null && step['is-planning-stage'] !== true && step['is-done'] !== true
  && step['is-blocked-state'] !== true && step['follow-return-to-state'] !== true;

// mergesAwaited(status) — the status (statusOf) is, at any level of its
// chain, at a step with merges-awaited: true (ASS-365): the project's workflow
// has Build merge the merge requests its Await Sequential Merge waits on
// (merge-request:await-dependencies, told by MERGES_AWAITED, steps.js
// scriptEnv). The flag says so, never a step's id or name, nor the project:
// it goes on the parent step that runs grouped-build (a project's own Build),
// so grouped-build, shared, is the same for every project and acts on it only
// where that project's engine sets it, as the TUI reads shows-merge-train
// (ASS-363) anywhere in the chain.
export const mergesAwaited = status => status.chain.some(l => l.step?.['merges-awaited'] === true);

// inPlanning(status) — the status (statusOf) is in planning: the deepest
// step of its chain that sets is-planning-stage says, falling back up; false
// when none does.
export const inPlanning = status => status.chain.findLast(l => l.step?.['is-planning-stage'] != null)?.step['is-planning-stage'] === true;

// gateName(level) — how gate-when-leaving-state names a level of a status
// chain: "<engine>/<step>", at every level.
export const gateName = level => `${level['state-engine']}/${level.state}`;

// changePath(change) — a state change and each sub-state-change beneath it, top first.
export function changePath(change) {
  const path = [];
  for (let at = change; at; at = at['sub-state-change']) path.push(at);
  return path;
}

// statusIn(engine, variation, engines) — the variation's status (statusOf)
// with `engine` as its own top-level engine's, `engines` ({ [name]: its
// JSON }) beneath it; none, its top level alone.
export const statusIn = (engine, variation, engines = {}) => {
  const name = variation['harness-status']?.['state-engine'] ?? '';
  return statusOf({ ...engines, [name]: engine }, name, variation);
};

// statusExit(condition, status) — the condition reads the ticket system's
// status alone — ticket-system-status leaves, under all / not (ASS-282:
// grouped-qa's QA Testing on any status but Done and In Testing) — and holds for `status`.
const readsStatusAlone = c => {
  const [key, value] = Object.entries(c ?? {})[0] ?? [];
  return key === 'ticket-system-status' || (key === 'not' && readsStatusAlone(value)) || (key === 'all' && Array.isArray(value) && value.length > 0 && value.every(readsStatusAlone));
};
const statusExit = (condition, status) => readsStatusAlone(condition) && evaluateCondition(condition, { ticketSystemStatus: status });

// waitsOnTicketSystem(step) — a `none` step past planning, not done, whose
// every exit reads the ticket system's status alone (readsStatusAlone): it
// waits for a person to move the ticket on the board — grouped-qa's QA
// Testing, a flat engine's QA Testing — and nothing else moves it (ASS-355:
// such a step is never held for a dependency).
export const waitsOnTicketSystem = step => step?.action?.type === 'none' && step['is-planning-stage'] !== true && step['is-done'] !== true
  && (step['exit-events'] ?? []).length > 0 && step['exit-events'].every(e => readsStatusAlone(e.condition));

// answersGap(engine, variation, status, engines) — the ticket system's
// `status`, not its step's pairing, is the variation's own sub-engine run's
// to answer (ASS-224): beneath the top level (statusIn) it is at a step with
// an exit on that status (statusExit: a project Release's Team Code Review on In Testing
// or In Progress, grouped-qa's QA Testing on On Hold), or at a done step, its parent step about to move by its
// own exits. Then there is no gap to resolve: runSteps moves it, detectGaps
// leaves it be.
export const answersGap = (engine, variation, status, engines) => statusIn(engine, variation, engines).chain.slice(1)
  .some(({ step }) => step?.['is-done'] === true || (step?.['exit-events'] ?? []).some(e => statusExit(e.condition, status)));

// waitsOnHuman(engine, variation, engines) — the variation waits for a human:
// at a human step, or at a step its gate-when-leaving-state lists (gateName)
// once the latest change, into that step at its level, has work-is-done — at
// the top level, and given the `engines` beneath it at every level of its
// status (statusOf). A switched-off step (isActive) waits on no one.
export function waitsOnHuman(engine, variation, engines) {
  const { chain, step } = statusIn(engine, variation, engines);
  return step != null && humanWaits(chain, variation);
}

// humanWaits(chain, variation) — waitsOnHuman over a status chain (statusOf's) of the variation.
function humanWaits(chain, variation) {
  const last = variation?.['state-changes']?.at(-1), path = changePath(last);
  const gates = variation?.['gate-when-leaving-state'] ?? [];
  return chain.some((l, i) => isActive(l.step) && (l.step?.action?.type === 'human'
    || (gates.includes(gateName(l)) && path[i]?.['to-state'] === l.state && last['work-is-done'] === true)));
}
