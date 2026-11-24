// The Anthropic API cost check (ASS-153), a phase beside the Claude usage
// check (usage.js): what an API organization has spent this UTC month — what
// Hindsight's API key (ASS-62), and any other, costs — for the dashboard's
// footer (its third line since ASS-566; the models box before).
import { isHarnessProject } from './harness-project.js';
import { backgroundCheck, settled } from './background-checks.js';

// checkApiCost(ctx, state) — every API_COST_EVERY (the first tick at once):
// the month-to-date spend (ctx.apiCost(now, service) → { month, usd }, see
// src/agents/api-cost.js; tests replace it; null, the check is off) of each
// org there is an admin key for. The harness org's (the default keychain
// item) is recorded by harness:set-api-cost in data/api-cost.json; it is the
// whole organization's, so a control of one project reads it only for the
// harness project; the all-projects control always. A project whose
// project.json names its own org's admin key (api-cost-admin-keychain-service,
// ASS-221) has that org's read with it, recorded by project:set-api-cost in
// its api-cost.json — by its own control, or the all-projects control. A
// reading that fails — no admin key, refused, unavailable, unreachable —
// writes nothing, so the last value stays, and is logged once per failure
// streak (the first failure after a success, or ever); it is tried again an
// API_COST_EVERY later.
// ASS-497: each due org's reading and its recording run as a background job
// the tick does not await (background-checks.js), at most one per org; the
// dashboard's footer shows the last one recorded. Returns at once, with a promise of
// the jobs it started.
const API_COST_EVERY = 60 * 60e3;
export function checkApiCost(ctx, state) {
  if (!ctx.apiCost) return settled([]);
  const jobs = [];
  if (!ctx.project || isHarnessProject(state.harness, ctx.project)) {
    jobs.push(check(ctx, 'harness', undefined, '', reading => ['harness:set-api-cost', reading.month, String(reading.usd)]));
  }
  for (const project of state.projects) {
    const service = project.json?.['api-cost-admin-keychain-service'];
    if (!service || (ctx.project && ctx.project !== project.id)) continue;
    jobs.push(check(ctx, project.id, service, `${project.id}: `, reading => ['project:set-api-cost', project.id, reading.month, String(reading.usd)]));
  }
  return settled(jobs);
}

// One org's reading, `key` its place in memory, `service` its admin key's
// keychain item (undefined, the harness org's), `command` the cli call that
// records it; its background job (null when not due or one still runs).
function check(ctx, key, service, prefix, command) {
  const now = ctx.now();
  const memory = (ctx.memory.apiCost ??= new Map());
  const last = memory.get(key);
  if (last && now.getTime() - last.at < API_COST_EVERY) return null;
  const job = backgroundCheck(ctx, `checkApiCost/${key}`, job => read(job, key, service, prefix, command, now));
  if (job) memory.set(key, { at: now.getTime(), failing: last?.failing ?? false });
  return job;
}

// read(ctx, …) — the reading and its recording, in the background (ctx the job's context).
async function read(ctx, key, service, prefix, command, now) {
  const memory = ctx.memory.apiCost;
  let reading;
  try {
    reading = await ctx.apiCost(now, service);
  } catch (error) {
    if (!memory.get(key).failing) ctx.log('api-cost', `${prefix}the Anthropic API cost cannot be read (${error.message}); the last value stays`);
    memory.get(key).failing = true;
    return;
  }
  memory.get(key).failing = false;
  await ctx.attempt('api-cost', `${prefix}${reading.month}`, () => ctx.cli(command(reading)));
}
