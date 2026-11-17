// The Claude usage check (ASS-47), a phase beside the gcloud and glab login
// checks: how much of each project's Claude session and week (ASS-65) its
// login has used, and which account that is, for the dashboard's models box.
import { accountOf, kindOfAccount } from '../agents/account.js';
import { configDir } from './dispatch.js';
import { backgroundCheck, settled } from './background-checks.js';

// checkUsage(ctx, state) — for every project (no opt-in), every USAGE_EVERY:
// its login's account (claude auth status, as dispatch asks it, for the
// project's config dir) and its 5-hour session and 7-day weekly usage
// (ctx.usage(configDir) → { percent, resetsAt, weekly: { percent, resetsAt }
// | null }, see src/agents/usage.js; tests replace it; null, the check is
// off; weekly null, a plan with no weekly cap, is passed as `- -`), recorded by project:set-claude-usage in its
// claude-usage.json (loadState's claudeUsage). The command overwrites, so the last reading is kept here: a
// reading that fails — no token, expired, refused, unreachable — passes the
// last session and weekly back (`-` only when there never was one) and writes nothing
// unless the email changed; logged once per cause. A login not logged in is
// recorded as all `-`, its usage never asked. A claude auth status that
// cannot run keeps the last email. Its auth method and org are recorded with
// it (ASS-221); an api_key login (kindOfAccount 'anthropic') bills to that
// org's API key, not a subscription, so its usage is never asked: session and
// weekly are recorded as `-`.
// ASS-497: a due project's reading and its recording run as a background job
// the tick does not await (background-checks.js), at most one per project; the
// tick reads the last one recorded. Returns at once, with a promise of the jobs
// it started.
const USAGE_EVERY = 2 * 60e3;
export function checkUsage(ctx, state) {
  if (!ctx.usage) return settled([]);
  const now = ctx.now().getTime();
  const last = (ctx.memory.usage ??= new Map());
  const jobs = [];
  for (const project of state.projects) {
    const seen = last.get(project.id);
    if (seen && now - seen.at < USAGE_EVERY) continue;
    const job = backgroundCheck(ctx, `checkUsage/${project.id}`, job => readUsage(job, project, seen));   // runs from the next microtask on
    if (!job) continue;
    last.set(project.id, { at: now, failure: seen?.failure });
    jobs.push(job);
  }
  return settled(jobs);
}

// readUsage(ctx, project, seen) — one project's reading, in the background (ctx the job's context).
async function readUsage(ctx, project, seen) {
  const last = ctx.memory.usage;
  const recorded = project.claudeUsage;
  const dir = configDir(ctx, project);
  let email = recorded?.email ?? null, authMethod = recorded?.['auth-method'] ?? null, org = recorded?.org ?? null;
  try {
    const account = await accountOf({ command: ctx.command, configDir: dir, env: ctx.env });
    if (!account.loggedIn) {
      await ctx.attempt('usage', project.id, () => ctx.cli(['project:set-claude-usage', project.id, '-', '-', '-', '-', '-', '-', '-']));
      return;
    }
    ({ email, authMethod, org } = account);
  } catch { /* keeps the last email, auth method and org */ }
  let session = {}, weekly;
  if (kindOfAccount({ authMethod }) !== 'anthropic') {
    try {
      const reading = await ctx.usage(dir);
      session = { percent: reading.percent, 'resets-at': reading.resetsAt };
      weekly = reading.weekly && { percent: reading.weekly.percent, 'resets-at': reading.weekly.resetsAt };
      last.get(project.id).failure = null;
    } catch (error) {
      if (seen?.failure !== error.message) ctx.log('usage', `${project.id}: the Claude session usage cannot be read (${error.message}); the last reading stays`);
      last.get(project.id).failure = error.message;
      if (recorded && recorded.email === email && recorded['auth-method'] === authMethod && recorded.org === org) return;
      session = recorded?.session ?? {};
      weekly = recorded?.weekly;
    }
  }
  weekly ??= {};
  const arg = value => (value == null ? '-' : String(value));
  await ctx.attempt('usage', project.id, () => ctx.cli(['project:set-claude-usage', project.id, arg(email), arg(session.percent), arg(session['resets-at']), arg(weekly.percent), arg(weekly['resets-at']), arg(authMethod), arg(org)]));
}
