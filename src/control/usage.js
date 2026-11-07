// The Claude usage check (ASS-47), a phase beside the gcloud and glab login
// checks: how much of each project's Claude session and week (ASS-65) its
// login has used, and which account that is, for the dashboard's models box.
import { accountOf, kindOfAccount } from '../agents/account.js';
import { configDir } from './dispatch.js';

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
const USAGE_EVERY = 2 * 60e3;
export async function checkUsage(ctx, state) {
  if (!ctx.usage) return;
  const now = ctx.now().getTime();
  const last = (ctx.memory.usage ??= new Map());
  for (const project of state.projects) {
    const seen = last.get(project.id);
    if (seen && now - seen.at < USAGE_EVERY) continue;
    last.set(project.id, { at: now, failure: seen?.failure });
    const recorded = project.claudeUsage;
    const dir = configDir(ctx, project);
    let email = recorded?.email ?? null, authMethod = recorded?.['auth-method'] ?? null, org = recorded?.org ?? null;
    try {
      const account = await accountOf({ command: ctx.command, configDir: dir, env: ctx.env });
      if (!account.loggedIn) {
        await ctx.attempt('usage', project.id, () => ctx.cli(['project:set-claude-usage', project.id, '-', '-', '-', '-', '-', '-', '-']));
        continue;
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
        if (recorded && recorded.email === email && recorded['auth-method'] === authMethod && recorded.org === org) continue;
        session = recorded?.session ?? {};
        weekly = recorded?.weekly;
      }
    }
    weekly ??= {};
    const arg = value => (value == null ? '-' : String(value));
    await ctx.attempt('usage', project.id, () => ctx.cli(['project:set-claude-usage', project.id, arg(email), arg(session.percent), arg(session['resets-at']), arg(weekly.percent), arg(weekly['resets-at']), arg(authMethod), arg(org)]));
  }
}
