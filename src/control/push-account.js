// The push-account check (ASS-307), a phase: control asks, at start and then
// at most hourly per project, which account the project's VM token for its
// repositories' forge pushes as (ctx.pushAccount — see src/agents/forge.js).
// The reading (or the reason it cannot be told) is recorded by
// project:set-push-account in data/projects/<p>/push-account.json, for the
// control box in the dashboard's footer.
//
// A project with no repositories (or none whose url parses) is skipped: no
// provider, so no push account to look up. A project whose VM credentials
// (~/.harness/vm-credentials.json, declaredCredentials) declare no entry for
// its repositories' provider has 'no token declared' written for it without
// the keychain or the forge being touched: the one point where we know GitHub
// and GitLab are picked apart (AC2: a GitHub project never reads a GitLab
// token or calls GitLab).
import { providerOf } from '../agents/forge.js';
import { declaredCredentials } from './vm-credentials.js';

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

export async function checkPushAccount(ctx, state) {
  if (!ctx.pushAccount) return;
  const memory = (ctx.memory.pushAccount ??= new Map());
  const now = ctx.now().getTime();
  for (const project of state.projects) {
    if (ctx.project && ctx.project !== project.id) continue;
    const url = repoUrl(project);
    if (!url) continue;
    const last = memory.get(project.id);
    if (last && now - last.at < PUSH_ACCOUNT_EVERY) continue;
    memory.set(project.id, { at: now });
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
}
