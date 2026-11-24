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
// reading that fails — no token, expired, refused, unreachable — keeps the
// last session, weekly and as-of, and records why (ASS-571, below); logged once per cause. A login not logged in is
// recorded as all `-`, its usage never asked. A claude auth status that
// cannot run keeps the last email. Its auth method and org are recorded with
// it (ASS-221); an api_key login (kindOfAccount 'anthropic') bills to that
// org's API key, not a subscription, so its usage is never asked: session and
// weekly are recorded as `-`.
// ASS-571: before reading, an expiring or expired token is renewed (keepFresh); a failed reading is recorded as
// claude-usage.json's `failure` (project:set-claude-usage-failure) rather than nothing written, and the next good one
// clears it — so the dashboard and project:credentials-status can say the figures are stale and why.
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
// ASS-571: a claude.ai login's token is first kept fresh (keepFresh); a reading that then fails is recorded
// (project:set-claude-usage-failure: `failure: { why, at }`, the last good figures and their as-of kept) whenever
// its cause or the account changed, and a good one clears it (project:set-claude-usage overwrites).
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
  const arg = value => (value == null ? '-' : String(value));
  let session = {}, weekly;
  if (kindOfAccount({ authMethod }) !== 'anthropic') {
    const refresh = await keepFresh(ctx, project, dir);
    try {
      const reading = await ctx.usage(dir);
      session = { percent: reading.percent, 'resets-at': reading.resetsAt };
      weekly = reading.weekly && { percent: reading.weekly.percent, 'resets-at': reading.weekly.resetsAt };
      last.get(project.id).failure = null;
    } catch (error) {
      const why = refresh ? `${error.message}; ${refresh}` : error.message;
      if (seen?.failure !== why) ctx.log('usage', `${project.id}: the Claude session usage cannot be read (${why}); the last reading stays`);
      last.get(project.id).failure = why;
      if (recorded?.failure?.why === why && recorded.email === email && recorded['auth-method'] === authMethod && recorded.org === org) return;
      await ctx.attempt('usage', project.id, () => ctx.cli(['project:set-claude-usage-failure', project.id, why, arg(email), arg(authMethod), arg(org)]));
      return;
    }
  }
  weekly ??= {};
  await ctx.attempt('usage', project.id, () => ctx.cli(['project:set-claude-usage', project.id, arg(email), arg(session.percent), arg(session['resets-at']), arg(weekly.percent), arg(weekly['resets-at']), arg(authMethod), arg(org)]));
}

// keepFresh(ctx, project, dir) — ASS-571: Claude Code renews a login's token only when it runs for that config dir,
// so a project whose agents all run on remote machines or in sandboxes let it lapse and its usage went unread for
// days. When the login's token (ctx.loginExpiry, src/agents/usage.js) expires within REFRESH_AHEAD_MS, or has
// expired, control has Claude Code renew it (ctx.refreshLogin: one minimal `claude -p` turn with that config dir,
// which writes the renewed credentials back to the same keychain item itself — Claude Code's documented renewal; no
// refresh of our own), then reads the expiry again: later, it logs "refreshed its Claude login token (expired <when>)"
// once and returns null. A login it could not renew — the command failed, or the token is still expired (its refresh
// token revoked, the login ended: /login needed) — returns why, for readUsage's failure; one still valid but due is
// left to be read. Not tried again for the same token for REFRESH_RETRY_MS, unless it has expired since (a try ahead
// of expiry that Claude Code turned down, as a token still valid may be). Never a token in a log or a file: only its
// expiry time is read here. null too with no ctx.loginExpiry/refreshLogin, no token, or no expiry recorded.
const REFRESH_AHEAD_MS = 10 * 60e3, REFRESH_RETRY_MS = 30 * 60e3;
async function keepFresh(ctx, project, dir) {
  if (!ctx.loginExpiry || !ctx.refreshLogin) return null;
  let expires;
  try { expires = await ctx.loginExpiry(dir); } catch { return null; }
  const now = ctx.now().getTime();
  if (typeof expires !== 'number' || expires - now > REFRESH_AHEAD_MS) return null;
  const tries = (ctx.memory.loginRefreshes ??= new Map());
  const tried = tries.get(project.id);
  const expired = expires <= now;
  if (tried?.expires === expires && now - tried.at < REFRESH_RETRY_MS && !(expired && !tried.expired)) return expired ? tried.why : null;
  let failed = null;
  try { await ctx.refreshLogin(dir); } catch (error) { failed = error.message; }
  let after = expires;
  try { after = await ctx.loginExpiry(dir); } catch { /* as it was */ }
  if (typeof after === 'number' && after > expires && after > ctx.now().getTime()) {
    tries.delete(project.id);
    ctx.log('usage', `${project.id}: refreshed its Claude login token (${expired ? 'expired' : 'expiring'} ${new Date(expires).toISOString().replace(/\.\d{3}Z$/, 'Z')})`);
    return null;
  }
  const why = `Claude Code could not refresh it (${failed ?? 'the token was not renewed: sign in again'})`;
  tries.set(project.id, { at: now, expires, expired, why });
  if (tried?.why !== why) ctx.log('usage', `${project.id}: its Claude login token ${expired ? 'expired' : 'expires'} ${new Date(expires).toISOString().replace(/\.\d{3}Z$/, 'Z')}, and ${why}`);
  return expired ? why : null;
}
