// Phase 1: finishing the agents whose turn ended, or whose process exited,
// since the last tick — their assignments removed with what they cost, their
// processes ended, and the work moved on by the step's exits — before anything
// else happens in the tick.
import { stepOf, engineSteps, nextState } from './engine.js';
import { enginesFor } from './state.js';
import { ticketFacts } from './facts.js';
import { runsInVm } from './vm.js';
import { found, contextOf, levelChanges, moveTicket, moveRun, isPaused, releaseWorkspace, firstStepId } from './moves.js';
import { failed, recordKey, held, counted } from './backoff.js';
import { anotherRepository, visitOf } from './repositories.js';
import { dirname } from 'node:path';
import { readSession, memoryUse, sessionDir } from '../agents/session.js';
import { billed } from '../agents/process.js';
import { readUsage } from '../agents/session-usage.js';

const PHASE = 'finish';

// pendingWaitMs(state) — how long finish holds an agent whose turn ended with
// background work still pending (ASS-334), in ms: harness.json's
// agent-pending-work-wait-seconds, 30 minutes by default. The bound releases an
// agent whose work never completes. Same `state.harness[...] ?? default`
// pattern as supervise.js's agent-graceful-shut-down-delay-in-seconds; no entry
// in data/harness.json is needed for the default to apply.
const pendingWaitMs = state => (state.harness['agent-pending-work-wait-seconds'] ?? 1800) * 1000;

// turnComplete(group, pen) — a step's turn is complete when the pen-holder's
// turn has ended and every other agent of the assignment has approved:
// `group` the assignment's records, `pen` the pen-holder's, whose turn is
// known to have ended.
export const turnComplete = (group, pen) => group.every(a => a === pen || pen.approvals?.[a['agent-name']] != null);

// costArgs(live, usage) — what the live agent's turns cost, as
// assignments:remove takes them: [cost-usd, input, output, cache-read,
// cache-write], then --estimated when the cost is an estimate (ASS-268), then
// --billing <subscription|api> once its session has said (ASS-216; usage.json's
// billing when the live agent never heard it) — the cost 0 on a subscription
// (process.js billed). `usage` is its session's usage.json (session-usage.js,
// read from live.agent.dir by default): where every turn ended, the exact
// total of its results; with a turn unfinished — usage.json not exact: tokens
// since its last result, or before its first — usage.json's estimate of every
// turn, the finished ones exact and the unfinished priced from harness.json's
// model-prices, with its tokens; with no price for its model, the finished
// turns' exact cost, flagged, as the most that is known. No cost at all when
// nothing it spent is known (no result, no estimate).
const KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
export function costArgs(live, usage = readUsage(live.agent?.dir)) {
  const billing = live.agent?.billing ?? usage?.billing ?? null;
  const unfinished = usage?.costExact === false;
  const [usd, tokens] = unfinished && usage.costUsd != null ? [usage.costUsd, usage.tokens]
    : live.result ? [live.cost, live.tokens]
    : usage?.costUsd != null ? [usage.costUsd, usage.tokens] : [null];
  return [
    ...(usd != null ? [billed({ billing }, usd).toFixed(6), ...KEYS.map(k => String(Math.round(tokens[k] ?? 0))), ...(unfinished ? ['--estimated'] : [])] : []),
    ...(billing ? ['--billing', billing] : []),
  ];
}

// spentSoFar(live, usage) — what the live agent has cost so far, in dollars
// (ASS-270): costArgs' cost — its finished turns exact, the unfinished one
// usage.json's estimate — 0 on a subscription or with nothing yet known. What
// the API caps (supervise.js capHolds) and its ticket's spending limit (tick.js
// load's running, spend.js runningSpend) count for it while it runs: a single
// long turn is seen as it goes, not once its result says.
export function spentSoFar(live, usage = readUsage(live.agent?.dir)) {
  const [usd] = costArgs(live, usage);
  return /^\d/.test(usd ?? '') ? Number(usd) : 0;
}

// usageArgs(usage) — costArgs from a session's usage.json alone, for an agent
// no live process of this control speaks for (main.js's startup clean-up, a
// kill of an agent control does not hold): its cost as usage.json has it,
// --estimated unless every turn ended, and its billing.
export const usageArgs = usage => costArgs({}, usage);

// sessionSpend(ctx, record) — usageArgs and memoryArgs of the session the
// record's agent wrote (session.js sessionDir, by its name and start-time):
// what an agent no live process speaks for cost; none when the record names
// no session.
export function sessionSpend(ctx, record) {
  let dir;
  try { dir = sessionDir(dirname(ctx.paths.agents), record['agent-name'], record['start-time']); } catch { return []; }
  return [...usageArgs(readUsage(dir)), ...memoryArgs(dir)];
}

// costText(args) — costArgs' cost as the log says it: " ($0.5000)", " (~$0.6000,
// estimated)", nothing without one.
const costText = args => (/^\d/.test(args[0] ?? '') ? ` (${args.includes('--estimated') ? '~' : ''}$${Number(args[0]).toFixed(4)}${args.includes('--estimated') ? ', estimated' : ''})` : '');

// memoryArgs(dir) — how the session at `dir` used its memory (ASS-147),
// counted from its log (session.js memoryUse), as assignments:remove takes it:
// --memory <recalls> <returned> <saves> <deletes>; zeros for one without memory.
export const memoryArgs = dir => {
  const { recalls, returned, saves, deletes } = memoryUse(readSession(dir));
  return ['--memory', ...[recalls, returned, saves, deletes].map(String)];
};

// The agent's assignment removed (with its cost — costArgs: exact, or
// usage.json's estimate of a turn cut short — and its memory use), the workspace given back
// when it held it (releaseWorkspace), its process ended and forgotten — the
// process whatever became of the record.
async function endAgent(ctx, live) {
  try {
    const cost = costArgs(live);
    await ctx.cli(['assignments:remove', live.name, ...cost, ...memoryArgs(live.agent.dir)]);
    ctx.log(PHASE, `${live.name} ended${live.result ? '' : ' without a result'}${costText(cost)}`);
    await releaseWorkspace(ctx, PHASE, live.record);
  } catch (error) {
    ctx.log('error', `${PHASE} ${live.name}: ${error.message}`);
  } finally {
    live.agent.stop();
    ctx.agents.delete(live.name);
    forgetPending(ctx, live.name);
  }
}

// forgetPending(ctx, name) — the pending-work warned keys (ASS-334) are per
// span; drop the agent's once it is gone (endAgent, endUnassigned), so
// ctx.memory.warned does not keep one for every span.
function forgetPending(ctx, name) {
  for (const key of ctx.memory.warned) if (key.startsWith(`pending/${name}/`)) ctx.memory.warned.delete(key);
}

// Where the record's step is: { kind: 'ticket', project, ticket, variation,
// engine, step, changes } — a backlog ticket's in its refinement engine (moves.js found, ASS-144) — or { kind: 'run', run, engine, step, changes, and
// the project, ticket and variation the run works for (contextOf) when it
// works for one, so its exits read their facts as a ticket step's do } —
// `changes` the history its exits' max-visits count over: the variation's
// top level, or the run's own state-changes (ASS-66); null, logged,
// when the ticket is no longer at the record's state or the run is gone.
function placeOf(ctx, state, record) {
  if (record['transient-state-engine']) {
    const run = state.transient.find(r => r.id === record['transient-state-engine']);
    const engine = run && engineSteps(enginesFor(state, run.project), run['state-engine']);
    if (!run || run.state !== record.state) { ctx.log(PHASE, `${record['agent-name']}: its run is gone or elsewhere; nothing to move`); return null; }
    const { workItem, variation: name } = contextOf(run, state.transient);
    const { project, ticket, variation, backlog } = found(state, { project: run.project, 'work-item': workItem, variation: name });
    return { kind: 'run', run, engine, step: stepOf(engine, run.state), changes: run['state-changes'] ?? [], project, ticket, variation, backlog };
  }
  const { project, ticket, variation, engine, backlog } = found(state, record);
  if (!variation || variation['harness-status']?.state !== record.state) { ctx.log(PHASE, `${record['agent-name']}: ${record['work-item']} ${record.variation} is no longer at ${record.state}; nothing to move`); return null; }
  return { kind: 'ticket', project, ticket, variation, engine, step: stepOf(engine, record.state), changes: levelChanges(variation), backlog };
}

// holdForRateLimit(ctx, state, live) — the agent printed a rejected
// rate_limit_event (live.rateLimit, Claude's rate_limit_info): its reset time
// is recorded against the agent's credential kind (live.kind, ASS-215; claude
// when unknown) in its own project's rate-limit.json (project:set-rate-limit,
// which the dashboard shows as RATE LIMITED) unless one at or after it already
// holds that kind, and control dispatches none of that kind's agents of the
// project until then (dispatch.js).
async function holdForRateLimit(ctx, state, live) {
  const info = live.rateLimit, kind = live.kind ?? 'claude';
  const resetsAt = new Date(info.resetsAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const type = info.rateLimitType ?? 'unknown';
  ctx.log(PHASE, `${live.name}: rate limited (${type}) on ${live.project}'s ${kind} credential; its ${kind} agents are held until ${resetsAt}`);
  const held = state.projects.find(p => p.id === live.project)?.rateLimit?.[kind]?.['resets-at'];
  if (held && Date.parse(held) >= Date.parse(resetsAt)) return;
  await ctx.cli(['project:set-rate-limit', live.project, kind, type, resetsAt]);
}

// finishEnded(ctx, state) — first, the session id of each live agent whose
// process has said it since is recorded (assignments:set-process again).
// Then, for each live agent with a result or an exit: one that hit a rate
// limit (rateLimit) is ended with its group, the turn uncounted, and control
// holds its project's agents of its credential kind (holdForRateLimit);
// one whose assignment is gone is ended, its cost recorded on its dispatch all
// the same (endUnassigned); one paused or shutting down, or that exited
// without a result, is just ended (the step runs again), with what it cost;
// a group whose any live member's last turn left background work pending
// (ASS-334) is held — nothing of it ended — up to pendingWaitMs, logged once
// per span, then finished anyway with a timeout line (also once per span)
// once that passes; else,
// once the assignment's turn is complete (turnComplete), the step's exits are
// evaluated with turn-complete, the result's structured_output, the ticket's
// facts and files written since the turn began — then, in this order, every
// agent of the assignment is ended (assignments:remove with its cost, the
// process signalled) and the work moved (moveTicket or moveRun). No exit
// matching, or one whose target cannot be told, is logged; the assignment is
// removed all the same and the step runs again. Each turn ended is counted
// for the self-healing trigger (see triggers.js).
export async function finishEnded(ctx, state) {
  for (const live of ctx.agents.values()) {
    if (live.sessionRecorded || !live.agent.sessionId || !state.assignments.some(a => a['agent-name'] === live.name)) continue;
    await ctx.attempt(PHASE, live.name, async () => {
      await ctx.cli(['assignments:set-process', live.name, String(live.agent.pid), live.agent.sessionId]);
      live.sessionRecorded = true;
    });
  }
  for (const live of [...ctx.agents.values()]) {
    if (!live.result && !live.exited) continue;
    if (!ctx.agents.has(live.name)) continue;   // ended with an earlier assignment this tick
    await ctx.attempt(PHASE, live.name, () => finishOne(ctx, ctx.load(), live));
  }
}

// endUnassigned(ctx, live) — an agent whose assignment another hand removed
// (ticket:delete, the operator): what it cost (costArgs) recorded on the
// dispatch it was logged on (assignments:record-spend, ASS-268), its process
// ended and forgotten whether or not that could be recorded — a ticket gone
// has no dispatch to record it on, and the failure is logged.
async function endUnassigned(ctx, live) {
  ctx.log(PHASE, `${live.name}: no assignment any more; ending its process`);
  const { project, 'work-item': work, variation, 'start-time': started } = live.record ?? {};
  const cost = costArgs(live);
  if (work && variation && /^\d/.test(cost[0] ?? '')) await ctx.attempt(PHASE, live.name, () => ctx.cli(['assignments:record-spend', project, work, variation, live.name, started, ...cost]));
  live.agent.stop();
  ctx.agents.delete(live.name);
  forgetPending(ctx, live.name);
}

// One ended agent (see finishEnded).
async function finishOne(ctx, state, live) {
  const record = state.assignments.find(a => a['agent-name'] === live.name);
  if (!record) return endUnassigned(ctx, live);
  const group = state.assignments.filter(a => a['assignment-id'] != null && a['assignment-id'] === record['assignment-id']);
  if (!group.length) group.push(record);
  const lives = group.map(a => ctx.agents.get(a['agent-name'])).filter(Boolean);
  if (live.rateLimit) {
    await holdForRateLimit(ctx, state, live);
    for (const l of lives) await endAgent(ctx, l);
    return;
  }
  if (isPaused(state, record.project, record['work-item'], record.variation, record['transient-state-engine']) || ['Shutting Down', 'Killed'].includes(record.status)) return endAgent(ctx, live);
  // A failure: the step is tried again once its hold is over (backoff.js), longer each time.
  counted(ctx.memory, recordKey(record), live.agent, live.result);   // a failed start, or not (ASS-167)
  const retry = what => { const { until } = failed(ctx.memory, recordKey(record), ctx.now().getTime(), what); ctx.log(PHASE, `${what}; tried again in ${held(until - ctx.now().getTime())}`); };
  if (!live.result) {
    retry(`${live.name} exited without ending its turn`);
    for (const l of lives) await endAgent(ctx, l);
    return;
  }
  // Hold the whole group while any live member's last turn left background work
  // pending, bounded by pendingWaitMs (ASS-334). Checked over `lives`, not the
  // single `live` whose result triggered finishOne: finishOne ends every member
  // once turnComplete, so a per-live check would SIGTERM a paired agent still
  // waiting on its own pending work. Past the bound, finish anyway and log a
  // timeout, so work that never completes still releases the agent.
  const wait = pendingWaitMs(state), now = ctx.now().getTime();
  const pending = lives.filter(l => l.pending && l.result && !l.exited);
  const within = pending.filter(l => now - l.pending.at < wait);
  if (within.length) {
    for (const l of within) {
      const key = `pending/${l.name}/${l.pending.at}`;
      if (ctx.memory.warned.has(key)) continue;
      ctx.memory.warned.add(key);
      ctx.log(PHASE, `${l.name}: turn ended with pending background work; waiting up to ${held(wait)} before finishing`);
    }
    return;
  }
  for (const l of pending) {
    // Once per span too: a pair member past the bound while the pen-holder's
    // turn is still running returns below each tick until the pen's ends.
    const key = `pending/${l.name}/${l.pending.at}/timeout`;
    if (ctx.memory.warned.has(key)) continue;
    ctx.memory.warned.add(key);
    ctx.log(PHASE, `${l.name}: pending background work still outstanding after ${held(wait)}; finishing anyway (timeout)`);
  }
  const pen = group.find(a => a['agent-name'] === a['pen-holder']) ?? group[0];
  const penLive = ctx.agents.get(pen['agent-name']);
  if (!penLive?.result || !turnComplete(group, pen)) return;   // a pair agent done, or approvals still to come
  if (penLive.result.is_error) {
    retry(`${pen['agent-name']} ended its turn in an error (${penLive.result.subtype ?? 'error'})`);
    for (const l of lives) await endAgent(ctx, l);
    return;
  }
  const place = placeOf(ctx, state, pen);
  const facts = { turnComplete: true, structuredOutput: penLive.result.structured_output, ...(place?.variation ? ticketFacts(ctx, place.project, place.ticket, place.variation, penLive.startedAt.getTime(), runsInVm(place.step) ? place.variation.vm?.name : undefined) : {}) };
  const next = place?.step ? nextState(place.step, place.engine, facts, place.changes) : null;
  for (const l of lives) await endAgent(ctx, l);
  if (!place) return;
  // A step in each repository (ASS-119) whose run passed, with another repository's run to come: it stays, and that run is dispatched.
  const following = next && anotherRepository(ctx.memory, place.step, place.variation, visitOf(place), penLive.repository, next.exit);
  if (following) { ctx.log(PHASE, `${pen['agent-name']}: ${pen.state} in ${penLive.repository} passed; ${following} next`); return; }
  // No exit matching is no failure: the work may just need more turns, so the step runs again at once.
  if (next?.to == null) { ctx.log(PHASE, `${pen['agent-name']}: no exit of ${pen.state} matched${next ? ' (target unresolved)' : ''}; the step runs again`); return; }
  // Stamped with when the groom started, so what arrived during it makes the ticket due again (ASS-213).
  if (place.kind === 'ticket' && place.backlog && place.step?.id === firstStepId(place.engine)) await ctx.cli(['ticket:refined', place.project.id, place.ticket.key, penLive.startedAt.toISOString().replace(/\.\d+Z$/, 'Z')]);
  if (place.kind === 'ticket') await moveTicket(ctx, PHASE, place.project, place.ticket, place.variation, next.to, next.reason === 'max-visits' ? 'max-visits' : undefined);
  else await moveRun(ctx, PHASE, place.run, next.to, facts.structuredOutput, next.reason === 'max-visits' ? 'max-visits' : undefined);
}
