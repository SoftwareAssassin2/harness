// Phases 4–6: the state engine runs control starts of its own accord — on a
// gap between a ticket's statuses, on a timer, on a sample of state changes.
// At most one run of each kind goes at a time per
// project — per ticket for gap resolution, ticket health and appeal (plan.js
// triggerAllowed); such runs count toward max-agents, never max-tickets-in-progress.
import { pairedStatus, waitsOnHuman, stepOf, isHumanStep, isDoneStep, isHeld, isManual, answersGap } from './engine.js';
import { triggerAllowed } from './plan.js';
import { firstStepId, isPaused, BACKGROUND, backgroundOff, weeklyHeld, found, moveTicket } from './moves.js';
import { rankBacklog } from './rank.js';
import { isHarnessProject } from './harness-project.js';

// A run of the engine's `<kind>-steps` list started for `parent`, when the
// list exists and no such run is going — and, for background work, the
// project it runs on has it on (backgroundOff) and is not held for its weekly
// usage (weeklyHeld, ASS-232); whether it was. Also
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
// answers (engine.js answersGap, ASS-224): the engine's gap-resolution-steps
// started with { trigger: "gap-resolution", work-item, variation }.
export async function detectGaps(ctx, state) {
  for (const project of state.projects) {
    if (!project.engine) continue;
    for (const ticket of project.tickets) for (const v of ticket.variations ?? []) {
      if (v['is-deleted'] || isHeld(ticket, v) || waitsOnHuman(project.engine, v, project.engines ?? state.engines)) continue;
      const paired = pairedStatus(project.engine, v['harness-status']?.state);
      const status = ticket['ticket-system-status'];
      if (paired == null || status == null || status === paired || answersGap(project.engine, v, status, project.engines ?? state.engines)) continue;
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

// sampleHealth(ctx, state) — health is the harness project's to check
// (harness.json harness-project): every check-ticket-health-sample-every'th
// state change of any project (its engine's setting; moves.js hands each
// over) starts its check-ticket-health-steps, a run of the harness project,
// with { trigger: "check-ticket-health", work-item, variation,
// ticket-project } — the ticket's own project; none for a ticket worked by
// hand (isManual, ASS-166). Without a harness project, or
// one whose engine samples nothing, the changes are dropped.
export async function sampleHealth(ctx, state) {
  const harness = (state.allProjects ?? state.projects).find(p => isHarnessProject(state.harness, p.id));
  const every = harness?.engine?.['check-ticket-health-sample-every'];
  for (const sample of ctx.memory.health.splice(0)) {
    const count = (ctx.memory.changes.get('all') ?? 0) + 1;
    ctx.memory.changes.set('all', count);
    if (!(every > 0) || count % every !== 0 || isManual(found(state, sample).ticket)) continue;
    if (await startTrigger(ctx, state, 'health', harness, 'check-ticket-health', { 'work-item': sample['work-item'], variation: sample.variation, 'ticket-project': sample.project })) state = ctx.load();
  }
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
// 'live', 'expired', or 'unavailable' when the tool cannot run), kept as the
// project's <tool>-requires-reauthentication file (loadState's
// <tool>RequiresReauthentication, ASS-58) for the dashboard's warning;
// written and logged when it changes. One that cannot run leaves the flag as
// it is, logged once until it runs again. Each tool keeps its own clock.
const LOGIN_EVERY = 2 * 60e3;
const loginCheck = tool => async function (ctx, state) {
  const now = ctx.now().getTime();
  const last = (ctx.memory[tool] ??= new Map());
  for (const project of state.projects) {
    if (project.json[`check-for-expired-${tool}-auth`] !== true) continue;
    const seen = last.get(project.id);
    if (seen && now - seen.at < LOGIN_EVERY) continue;
    const login = await ctx[tool]();
    last.set(project.id, { at: now, login });
    if (login === 'unavailable') {
      if (seen?.login !== 'unavailable') ctx.log(tool, `${project.id}: ${tool} cannot be run; the warning stays as it is`);
      continue;
    }
    const expired = login === 'expired';
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
