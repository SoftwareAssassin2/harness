// Phase 7: the agents under way — asked for a status update when quiet too
// long, and when their work is paused — by the
// assignment, by the ticket, or by a self-healing fix — or past a cap or
// spending limit, sent agent:shut-down,
// then agent:kill once agent-graceful-shut-down-delay-in-seconds has passed
// and they are still alive.
import { isPaused, releaseWorkspace, found } from './moves.js';
import { TICKET_FOLDER, runsInVm } from './vm.js';
import { stepOf, engineSteps } from './engine.js';
import { isHarnessProject } from './harness-project.js';
import { loadCollaborations, loadChatSpend, loadMemorySpend, enginesFor } from './state.js';
import { spendRecords, apiCapReached, spendText, overSpent, runningOn } from './spend.js';
import { flattenSprint } from './rank.js';
import { costArgs, memoryArgs, sessionSpend, spentSoFar } from './finish.js';
import { join } from 'node:path';

const PHASE = 'agents';

// statusSeconds(state, record) — the record's engine's
// ask-for-status-update-given-none-was-provided-for-seconds, else its
// project's execution engine's; undefined when neither has it.
export function statusSeconds(state, record) {
  const key = 'ask-for-status-update-given-none-was-provided-for-seconds';
  return enginesFor(state, record.project)[record['state-engine']?.split('/')[0]]?.[key] ?? state.projects.find(p => p.id === record.project)?.engine?.[key];
}

// nagDue(memory, record, seconds, now) — the agent has given no status update
// for `seconds` (since its last, or its start) and has not been asked since
// that moment; remembers the ask.
export function nagDue(memory, record, seconds, now) {
  const since = record['last-ai-status-update'] ?? record['start-time'];
  if (!(seconds > 0) || now - Date.parse(since) < seconds * 1000 || memory.nagged.get(record['agent-name']) === since) return false;
  memory.nagged.set(record['agent-name'], since);
  return true;
}

// superviseAgents(ctx, state) — for each assignment: while the agents are
// paused, or its ticket or variation is, one not yet Shutting Down is asked to
// (agent:shut-down); one Shutting Down for longer than harness.json's
// agent-graceful-shut-down-delay-in-seconds is killed (agent:kill) and
// removed (assignments:remove) with what it cost (killedSpend). Otherwise a Running agent quiet for its
// engine's status-update seconds is asked for an update
// (agent:request-status-update), once per silence. First, an AI pause past
// its eta is released. Each agent running on its project's API key (payment-method
// api, ASS-217) is shut down the same way while an API cap of its project holds (capHolds),
// and each agent on a ticket at its spending limit (spend.js overSpent, ASS-270:
// its running agents' spend so far counted — load's `running` — so one long
// turn reaching it is stopped mid-way); steps.js stopAtSpendingLimit moves the
// ticket to Blocked for Human once they are gone.
export async function superviseAgents(ctx, state) {
  const now = ctx.now().getTime();
  // An AI pause past its eta is released (assignments:pause): the health check that took it may have died.
  // Each control its own project's; all agents' the harness project's control (or a control of every project).
  const mine = scope => state.projects.some(p => p.id === scope) || (scope === 'all' && (!ctx.project || isHarnessProject(state.harness, ctx.project)));
  for (const [scope, pause] of Object.entries(state.pauses)) {
    if (!mine(scope) || !pause.ai || !(Date.parse(pause.ai.eta) <= now)) continue;
    await ctx.attempt(PHASE, `pause ${scope}`, async () => {
      await ctx.cli(['assignments:start', scope, 'ai']);
      ctx.log(PHASE, `the AI pause on ${scope} (${pause.ai.reason}, ${pause.ai.agent}) is past its eta: released`);
    });
  }
  const capped = new Set();
  for (const project of state.projects) await ctx.attempt(PHASE, `${project.id}'s API caps`, async () => { if (await capHolds(ctx, project)) capped.add(project.id); });
  const delay = (state.harness['agent-graceful-shut-down-delay-in-seconds'] ?? 120) * 1000;
  const records = state.assignments.filter(a => state.projects.some(p => p.id === a.project));
  for (const record of records) await ctx.attempt(PHASE, record['agent-name'], () => superviseOne(ctx, state, record, now, delay, capped, atLimit(state, record)));
}

// atLimit(state, record) — overSpent's { spend, limit } for the ticket the
// record's agent works on (ASS-270), its running agents' spend so far
// counted (spend.js runningOn of load's `running`); null under its limit, with
// none, or for an agent on no ticket.
function atLimit(state, record) {
  if (record['work-item'] == null) return null;
  const { project, ticket } = found(state, record);
  return ticket ? overSpent(ticket, state.harness, project.json, runningOn(state.running, record.project, record['work-item'])) : null;
}

// capHolds(ctx, project) — whether an API cap of the project holds (ASS-217:
// spend.js apiCapReached over its sprint's and backlog's dispatches, its
// ticket chats' turns, its chat-screen turns (ASS-271) and its Hindsight's
// Claude spend (ASS-269), plus what this control's agents on its API key have cost so
// far — finish.js spentSoFar: their finished turns and usage.json's estimate of
// the one under way, ASS-270, so a single long turn reaches a cap mid-way); recorded in project.json (project:set-api-cap-hold, cleared with -
// once none holds) for dispatch and the dashboard — rewritten as its cap, spend
// or limit moves (a running agent's spend now moves it mid-turn) — and logged when it changes.
// A project with no cap set is never read.
async function capHolds(ctx, project) {
  const json = project.json ?? {};
  if (json['max-api-spend-per-day-usd'] == null && json['max-api-spend-per-sprint-usd'] == null && !json['api-cap-hold']) return false;
  const dir = join(ctx.paths.projects, project.id);
  const records = spendRecords([...flattenSprint(project.sprint ?? {}), ...(project.backlog ?? [])], loadCollaborations(dir), loadChatSpend(dir), loadMemorySpend(dir));
  const running = [...ctx.agents.values()].filter(l => l.project === project.id && l.payment === 'api').reduce((sum, l) => sum + spentSoFar(l), 0);
  const hold = apiCapReached(records, json, project.sprint, ctx.now(), running), was = json['api-cap-hold'];
  if (hold && (was?.cap !== hold.cap || was['spend-usd'] !== round(hold.spend) || was['limit-usd'] !== hold.limit)) {
    await ctx.cli(['project:set-api-cap-hold', project.id, hold.cap, String(round(hold.spend)), String(hold.limit)]);
    if (was?.cap !== hold.cap) ctx.log(PHASE, `${project.id}'s API ${hold.cap} cap is reached (${spendText(hold.spend, hold.limit)}): none of its agents starts on the API key, and those running there are shut down`);
  } else if (!hold && was) {
    await ctx.cli(['project:set-api-cap-hold', project.id, '-']);
    ctx.log(PHASE, `${project.id} is under its API caps again: its agents may start on the API key`);
  }
  return Boolean(hold);
}
const round = usd => Math.round(usd * 100) / 100;

// killedSpend(ctx, record) — what an agent killed after the shut-down delay
// cost, and how it used its memory, as assignments:remove takes them (ASS-268):
// its live process's costArgs — its finished turns and usage.json's estimate
// of the one cut short — or, one this control does not hold, its session's
// usage.json alone (sessionSpend). Recorded with its removal, so an agent killed
// for an API cap is in the records the cap is next evaluated over (capHolds):
// the kill never lifts it.
function killedSpend(ctx, record) {
  const live = ctx.agents.get(record['agent-name']);
  return live ? [...costArgs(live), ...memoryArgs(live.agent.dir)] : sessionSpend(ctx, record);
}

// One assignment (see superviseAgents); `over` its ticket's atLimit.
async function superviseOne(ctx, state, record, now, delay, capped, over) {
  const name = record['agent-name'];
  if (isPaused(state, record.project, record['work-item'], record.variation, record['transient-state-engine']) || (record['payment-method'] === 'api' && capped.has(record.project)) || over) {
    if (record.status === 'Shutting Down' || record.status === 'Killed') {
      if (record.status === 'Shutting Down' && now - Date.parse(record['shut-down-requested'] ?? record['start-time']) < delay) return;
      await ctx.cli(['agent:kill', name]);
      await ctx.cli(['assignments:remove', name, ...killedSpend(ctx, record)]);
      ctx.agents.get(name)?.agent.stop();
      ctx.agents.delete(name);
      ctx.log(PHASE, `${name} killed after the shut-down delay${record['working-in-dev-container'] ? ' (its process in the dev container may linger)' : ''}`);
      await releaseWorkspace(ctx, PHASE, record);
    } else {
      // An agent on a step in its variation's VM is told the VM's ticket folder and agent.sh, as its dispatch was (ASS-181):
      // by the step's run-location (ASS-182), as dispatch.js vmFor decides, not by the variation having a VM.
      const step = stepOf(engineSteps(enginesFor(state, record.project), record['state-engine'] ?? ''), record.state);
      const inVm = runsInVm(step) && Boolean(found(state, record).variation?.vm?.name);
      await ctx.cli(['agent:shut-down', name, ...(inVm ? [`ticket-folder=${TICKET_FOLDER}`, 'agent-sh=agent.sh'] : [])]);
      ctx.log(PHASE, `${name} asked to shut down${over ? ` (${record['work-item']} is at its spending limit: ${spendText(over.spend, over.limit)})` : ''}`);
    }
    return;
  }
  if (record.status !== 'Running' || !nagDue(ctx.memory, record, statusSeconds(state, record), now)) return;
  await ctx.cli(['agent:request-status-update', name]);
  ctx.log(PHASE, `${name} asked for a status update`);
}
