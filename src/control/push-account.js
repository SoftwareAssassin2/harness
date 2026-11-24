// The push-account check (ASS-307), a phase: control asks, at start and then
// at most hourly per project, which account the project's VM token for its
// repositories' forge pushes as (ctx.pushAccount — see src/agents/forge.js).
// The reading (or the reason it cannot be told) is recorded by
// project:set-push-account in data/projects/<p>/push-account.json, for the
// dashboard's footer (its first line since ASS-566; its control box before).
//
// A project with no repositories (or none whose url parses) is skipped: no
// provider, so no push account to look up. A project whose VM credentials
// (~/.harness/vm-credentials.json, declaredCredentials) declare no entry for
// its repositories' provider has 'no token declared' written for it without
// the keychain or the forge being touched: the one point where we know GitHub
// and GitLab are picked apart (AC2: a GitHub project never reads a GitLab
// token or calls GitLab).
//
// ASS-497: a due project's lookup and its recording run as a background job
// the tick does not await (background-checks.js), at most one per project; the
// footer shows the last one recorded. Returns at once, with a promise of the
// jobs it started.
import { providerOf } from '../agents/forge.js';
import { declaredCredentials } from './vm-credentials.js';
import { backgroundCheck, settled } from './background-checks.js';

const PUSH_ACCOUNT_EVERY = 60 * 60e3;
const KEY_OF = { GitHub: 'github', GitLab: 'gitlab' };

// The first repository url of `project` that parses, or null when there are
// none (or none that parse).
function repoUrl(project) {
  for (const { url } of project.json?.repositories ?? []) {
    try { return new URL(url); } catch { /* malformed, try the next */ }
  }
  return null;
}

export function checkPushAccount(ctx, state) {
  if (!ctx.pushAccount) return settled([]);
  const memory = (ctx.memory.pushAccount ??= new Map());
  const now = ctx.now().getTime();
  const jobs = [];
  for (const project of state.projects) {
    if (ctx.project && ctx.project !== project.id) continue;
    const url = repoUrl(project);
    if (!url) continue;
    const last = memory.get(project.id);
    if (last && now - last.at < PUSH_ACCOUNT_EVERY) continue;
    const job = backgroundCheck(ctx, `checkPushAccount/${project.id}`, job => lookUp(job, project, url));
    if (!job) continue;
    memory.set(project.id, { at: now });
    jobs.push(job);
  }
  return settled(jobs);
}

// lookUp(ctx, project, url) — one project's push account, read and recorded, in the background (ctx the job's context).
async function lookUp(ctx, project, url) {
  const { provider, host } = providerOf(url.href);
  const service = declaredCredentials(ctx.env, project.id)?.[KEY_OF[provider]]?.['keychain-service'];
  let account = null, error = null;
  if (!service) {
    error = 'no token declared';
  } else {
    try { account = await ctx.pushAccount({ provider, host, service }); }
    catch (e) { error = e.message; }
  }
  await ctx.attempt('push-account', project.id, () => ctx.cli(['project:set-push-account', project.id, provider, account ?? '-', error ?? '-']));
}
