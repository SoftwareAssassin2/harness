// Phases 4–6: the state engine runs control starts of its own accord — on a
// gap between a ticket's statuses, on a timer. (ASS-450: none on a sample of
// state changes; the ticket health check is removed, endTicketHealthRuns.)
// At most one run of each kind goes at a time per
// project — per ticket for gap resolution and appeal (plan.js
// triggerAllowed); such runs count toward max-agents, never max-tickets-in-progress.
import { pairedStatus, waitsOnHuman, stepOf, isHumanStep, isDoneStep, isHeld, isManual, answersGap, pairedByAnother } from './engine.js';
import { triggerAllowed } from './plan.js';
import { firstStepId, isPaused, BACKGROUND, backgroundOff, weeklyHeld, found, moveTicket, endRun } from './moves.js';
import { rankBacklog } from './rank.js';
import { sessionSpend } from './finish.js';
import { expiredLogins } from './workstation-connection.js';

// A run of the engine's `<kind>-steps` list started for `parent`, when the
// list exists and no such run is going — and, for background work, the
// project it runs on has it on (backgroundOff) and is not held for its weekly
// usage (weeklyHeld, ASS-232; one with an API key is not, its runs' agents
// paid api, ASS-327); whether it was. Also
// reverts.js's (ASS-146).
export async function startTrigger(ctx, state, phase, project, kind, parent) {
  const list = project.engine?.[`${kind}-steps`];
  if (!Array.isArray(list) || !list.length) return false;
  if (BACKGROUND.includes(kind) && (backgroundOff(project) || weeklyHeld(ctx, project))) return false;
  if (!triggerAllowed({ transient: state.transient, kind, project: project.id, workItem: parent['work-item'], variation: parent.variation })) return false;
  const what = `${kind}${parent['work-item'] ? ` for ${parent['work-item']}${parent.variation ? ` ${parent.variation}` : ''}` : ''}`;
  let started = false;
  await ctx.attempt(phase, `${project.id} ${what}`, async () => {
    await ctx.cli(['transient-state-engine:create', project.id, `${project.engineName}/${kind}-steps`, firstStepId({ steps: list }), JSON.stringify({ trigger: kind, ...parent })]);
    ctx.log(phase, `${project.id}: started ${what}`);
    started = true;
  });
  return started;
}

// detectGaps(ctx, state) — for each sprint variation not deleted, held
// (isHeld: paused, or worked by hand, ASS-166) or waiting on a human, whose ticket's ticket-system-status is known and is not
// its step's paired-ticket-system-status, and not one its own sub-engine run
// answers (engine.js answersGap, ASS-224) or another of the ticket's live
// variations' steps pairs with (pairedByAnother, ASS-499): the engine's gap-resolution-steps
// started with { trigger: "gap-resolution", work-item, variation }.
export async function detectGaps(ctx, state) {
  for (const project of state.projects) {
    if (!project.engine) continue;
    for (const ticket of project.tickets) for (const v of ticket.variations ?? []) {
      if (v['is-deleted'] || isHeld(ticket, v) || waitsOnHuman(project.engine, v, project.engines ?? state.engines)) continue;
      const paired = pairedStatus(project.engine, v['harness-status']?.state);
      const status = ticket['ticket-system-status'];
      if (paired == null || status == null || status === paired || answersGap(project.engine, v, status, project.engines ?? state.engines) || pairedByAnother(project.engine, ticket, v, status)) continue;
      if (await startTrigger(ctx, state, 'gap', project, 'gap-resolution', { 'work-item': ticket.key, variation: v.name })) state = ctx.load();
    }
  }
}

// timerDue(memory, key, seconds, now, started) — whether `seconds` have
// passed since the timer `key` last fired (since control `started`, before
// its first); when so the timer is reset to `now`.
export function timerDue(memory, key, seconds, now, started) {
  if (!(seconds > 0)) return false;
  const last = memory.timers.get(key) ?? started;
  if (now - last < seconds * 1000) return false;
  memory.timers.set(key, now);
  return true;
}

// fireTimers(ctx, state) — per project: every check-health-interval-seconds
// of its engine, check-health-steps with { trigger: "check-health" }; every
// check-memory-interval-seconds, check-memory-steps with { trigger:
// "check-memory" } (ASS-62: its memory checked against the project); every
// check-variation-appeal-interval-seconds, check-variation-appeal-steps for
// each ticket with more than one variation not deleted, with its work-item,
// unless it is worked by hand (isManual, ASS-166).
// Self-healing is not fired here: it starts only from check-health's assess
// step, which hands it the reports it found the fault in.
export async function fireTimers(ctx, state) {
  const now = ctx.now().getTime(), started = ctx.started.getTime();
  for (const project of state.projects) {
    if (!project.engine) continue;
    if (timerDue(ctx.memory, `${project.id}/check-health`, project.engine['check-health-interval-seconds'], now, started)) {
      if (await startTrigger(ctx, state, 'timers', project, 'check-health', {})) state = ctx.load();
    }
    if (timerDue(ctx.memory, `${project.id}/check-memory`, project.engine['check-memory-interval-seconds'], now, started)) {
      if (await startTrigger(ctx, state, 'timers', project, 'check-memory', {})) state = ctx.load();
    }
    if (timerDue(ctx.memory, `${project.id}/check-variation-appeal`, project.engine['check-variation-appeal-interval-seconds'], now, started)) {
      for (const ticket of project.tickets) {
        if (isManual(ticket) || (ticket.variations ?? []).filter(v => !v['is-deleted']).length < 2) continue;
        if (await startTrigger(ctx, state, 'timers', project, 'check-variation-appeal', { 'work-item': ticket.key })) state = ctx.load();
      }
    }
  }
}

// endTicketHealthRuns(ctx) — ASS-450: the ticket health check is removed; a
// run of it left in assignments.json by an earlier harness — one at state
// check-ticket-health (a check-ticket-health-steps run, its trigger
// check-ticket-health) or of engine check-ticket-health or
// check-ticket-health-grouped — is ended with the runs under it, the
// deepest first (moves.js endRun, transient-state-engine:remove), each
// logged, and any agent still recorded on one removed with what it cost
// (assignments:remove; at control's start, main.js, its process has
// already been stopped). Called once as control starts, for its project's
// runs alone with --project: none is ever dispatched again.
const HEALTH_ENGINES = ['check-ticket-health', 'check-ticket-health-grouped'];
const isTicketHealthRun = r => r.state === 'check-ticket-health' || r.parent?.trigger === 'check-ticket-health'
  || HEALTH_ENGINES.includes(r['state-engine']) || /\/check-ticket-health-steps$/.test(r['state-engine'] ?? '');
export async function endTicketHealthRuns(ctx) {
  const state = ctx.load();
  const byId = new Map(state.transient.map(r => [r.id, r]));
  const chain = r => { const up = []; for (let x = r, seen = new Set(); x && !seen.has(x.id); x = byId.get(x.parent?.['transient-state-engine'])) { seen.add(x.id); up.push(x); } return up; };
  const runs = state.transient.filter(r => (!ctx.project || r.project === ctx.project) && chain(r).some(isTicketHealthRun))
    .map(r => ({ run: r, depth: chain(r).length })).sort((a, b) => b.depth - a.depth).map(({ run }) => run);
  if (!runs.length) return 0;
  const ids = new Set(runs.map(r => r.id));
  for (const record of state.assignments.filter(a => ids.has(a['transient-state-engine']))) {
    await ctx.attempt('startup', record['agent-name'], async () => {
      await ctx.cli(['assignments:remove', record['agent-name'], ...sessionSpend(ctx, record)]);
      ctx.log('startup', `removed ${record['agent-name']}, the agent of a ticket health check run (removed, ASS-450)`);
    });
  }
  let ended = 0;
  for (const run of runs) await ctx.attempt('startup', `run ${run.id}`, async () => { await endRun(ctx, 'startup', run, 'a ticket health check: removed, ASS-450'); ended++; });
  ctx.log('startup', `${ended} ticket health check run${ended === 1 ? '' : 's'} ended (removed, ASS-450)`);
  return ended;
}

// refineBacklog(ctx, state) — per project with a backlog refinement engine
// (state.js refinementOf; ASS-144: its backlog tickets sit in it, moved by
// steps.js and dispatch.js as sprint tickets are), each backlog ticket's live
// variation not paused (moves.js isPaused, ASS-126) at a resting step of its
// engine — a human step or the done step — goes back to the engine's first
// step when the ticket changed (changed-at) after it was last refined: a
// change made while it was mid-run, which ticket:sync left alone (Q7).
//
// ASS-44: when the execution engine carries the top-level string setting
// ready-tickets-join-sprint-at — a step id — a backlog ticket at its
// refinement engine's done step is joined to the active sprint at that step
// (ticket:join-sprint, which sets the step's paired off-board status); a
// question not accepted has sent it back first (the done step's exit,
// steps.js, an earlier phase). A Jira ticket, or no active sprint, logs
// through ctx.attempt and the ticket is left as it is. Engines without the
// setting (e.g. a flat engine) leave it at its done step.
export async function refineBacklog(ctx, state) {
  for (const project of state.projects) {
    if (!project.refinement) continue;
    const join = project.engine?.['ready-tickets-join-sprint-at'];
    for (const t of rankBacklog(project.backlog ?? [])) {
      const v = t.variations?.find(x => !x['is-deleted']);
      if (!v || isPaused(state, project.id, t.key, v.name)) continue;
      const { ticket, variation, engine } = found(state, { project: project.id, 'work-item': t.key, variation: v.name });
      const at = variation['harness-status']?.state;
      if (!stepOf(engine, at)) continue;
      const resting = isHumanStep(engine, at) || isDoneStep(engine, at), first = firstStepId(engine);
      if (resting && at !== first && (Date.parse(t['changed-at']) || 0) > (Date.parse(t['last-refined']) || 0)) {
        await ctx.attempt('refine', `${project.id} ${t.key}`, () => moveTicket(ctx, 'refine', project, ticket, variation, first, 'changed since it was last refined'));
        continue;
      }
      if (join && isDoneStep(engine, at)) await ctx.attempt('refine', `${project.id} ${t.key}`, async () => {
        await ctx.cli(['ticket:join-sprint', project.id, t.key, join]);
        ctx.log('refine', `${project.id}: ${t.key} is ready; joined the sprint at ${join}`);
      });
    }
  }
}

// loginCheck(tool) — a control phase that, for each project with
// check-for-expired-<tool>-auth, asks every LOGIN_EVERY whether the user's
// <tool> login — the one <tool> auth login renews — is live (ctx[tool]:
// 'live', 'unavailable' when the tool cannot run, or a failure read from its
// output, login.js: { login: 'expired' | 'offline' | 'unknown', output }; a
// bare string is taken as the login), kept as the project's
// <tool>-requires-reauthentication file (loadState's
// <tool>RequiresReauthentication, ASS-58) for the dashboard's warning and
// the credentials hold (credentials.js); written and logged when it changes.
// One that cannot run leaves the flag as it is, logged once until it runs
// again. ASS-429: so does one that only could not reach the tool's server —
// an offline or asleep Mac — logged once per streak as a network problem,
// never as an expiry, so it neither holds the project for credentials nor
// says to run '<tool> auth login'; a failure the tool does not explain is
// logged with its output (login.js shown: trimmed, tokens redacted) each
// time that changes and counted as expired, as before, so a new kind of
// expiry is never missed. Each tool keeps its own clock. ASS-433: the flag
// is gcloud's for the project's workstations too (workstations.js), so a
// live Mac login leaves it set while a workstation's last connect found its
// own login (its gcloud-config) expired.
const LOGIN_EVERY = 2 * 60e3;
const SERVER = { gcloud: 'Google', glab: 'GitLab' };
const loginCheck = tool => async function (ctx, state) {
  const now = ctx.now().getTime();
  const last = (ctx.memory[tool] ??= new Map());
  for (const project of state.projects) {
    if (project.json[`check-for-expired-${tool}-auth`] !== true) continue;
    const seen = last.get(project.id);
    if (seen && now - seen.at < LOGIN_EVERY) continue;
    const answer = await ctx[tool]();
    const { login, output = '' } = typeof answer === 'string' ? { login: answer } : answer;
    last.set(project.id, { at: now, login, output });
    if (login === 'unavailable') {
      if (seen?.login !== 'unavailable') ctx.log(tool, `${project.id}: ${tool} cannot be run; the warning stays as it is`);
      continue;
    }
    if (login === 'offline') {
      if (seen?.login !== 'offline') ctx.log(tool, `${project.id}: ${tool} could not reach ${SERVER[tool] ?? 'its server'}, a network problem, not an expired login; the warning stays as it is${output ? ` (${output})` : ''}`);
      continue;
    }
    if (login === 'unknown' && (seen?.login !== 'unknown' || seen.output !== output)) ctx.log(tool, `${project.id}: ${tool} failed for a reason it does not say is an expiry or a network problem; counted as expired: ${output || '(no output)'}`);
    const expired = login !== 'live' || (tool === 'gcloud' && expiredLogins(project.devEnvironments, project.workstations).length > 0);
    if (project[`${tool}RequiresReauthentication`] === expired) continue;
    await ctx.attempt(tool, project.id, async () => {
      await ctx.cli([`project:set-${tool}-reauthentication`, project.id, String(expired)]);
      ctx.log(tool, `${project.id}: ${expired ? `the ${tool} login has expired; run '${tool} auth login'` : `the ${tool} login is live again`}`);
    });
  }
};
// The gcloud login (ASS-28) and the glab login (ASS-61).
export const checkGcloud = loginCheck('gcloud');
export const checkGlab = loginCheck('glab');
