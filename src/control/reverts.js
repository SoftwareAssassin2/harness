// A reverted ticket's memories reviewed (ASS-146): what agents learnt working
// a change since undone on main may not hold. Hourly per project, each
// repository of its project.json is asked — read-only, no clone, through the
// forge CLIs whose logins control already watches — for its default branch's
// commits since its last check: GitHub's through `gh api`, any other (GitLab,
// on its own host) through `glab api`. Each commit titled
// `Revert "<KEY>: …"` (git's own revert subject; GitLab's squash title keeps
// it) for a ticket the project knows — its sprint's or backlog's — starts the
// check-memory run scoped to that ticket (triggers.js startTrigger, with the
// ticket as work-item; the clean-memory agent then checks its memories
// alone), one at a time per ticket. The time each repository was last
// checked is kept in data/projects/<id>/revert-checks.json — { <url>: <ISO> },
// control's alone — so a commit is never found twice; a repository not yet
// checked is asked for the hour before. A forge call that fails is logged
// and its last check kept, so the next hour asks again from there. Only for
// a project whose engine has check-memory-steps and whose background work is
// on (moves.js backgroundOff) and not held for its weekly usage (moves.js
// weeklyHeld, ASS-232; with an API key it is not, the review paid api,
// ASS-327): nothing is asked that could start no review, and
// nothing marked checked, so a revert made meanwhile is found once it lifts.
// One page of 100 commits a repository an hour.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { timerDue, startTrigger } from './triggers.js';
import { backgroundOff, weeklyHeld } from './moves.js';

const PHASE = 'reverts';
const HOUR_SECONDS = 3600;
const REVERT = /^Revert "([A-Za-z][A-Za-z0-9]*-\d+): /;
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// The forge CLI's JSON answer to `<tool> <args>`, with control's environment; thrown, naming the call, when it fails.
const forge = (ctx, tool, args) => new Promise((done, fail) => execFile(tool, args, { env: ctx.env, timeout: 60_000 }, (error, stdout, stderr) => {
  if (error) return fail(new Error(`${tool} ${args.join(' ')}: ${(stderr || stdout || error.message).trim()}`));
  try { done(JSON.parse(stdout)); } catch { fail(new Error(`${tool} ${args.join(' ')}: not JSON`)); }
}));

// commitsSince(ctx, url, since) — [{ sha, subject }] of the repository's default-branch commits since `since`.
async function commitsSince(ctx, url, since) {
  const { host, pathname } = new URL(url);
  const path = pathname.replace(/^\/|\.git$|\/$/g, '');
  if (host === 'github.com') {
    return (await forge(ctx, 'gh', ['api', `repos/${path}/commits?since=${since}&per_page=100`])).map(c => ({ sha: c.sha, subject: c.commit.message.split('\n')[0] }));
  }
  return (await forge(ctx, 'glab', ['api', `projects/${encodeURIComponent(path)}/repository/commits?since=${since}&per_page=100`, '--hostname', host])).map(c => ({ sha: c.id, subject: c.title }));
}

// detectReverts(ctx, state) — the control phase; see the module comment.
export async function detectReverts(ctx, state) {
  const now = ctx.now().getTime();
  for (const project of state.projects) {
    if (!project.engine?.['check-memory-steps']?.length || backgroundOff(project) || weeklyHeld(ctx, project)) continue;
    if (!timerDue(ctx.memory, `${project.id}/check-reverts`, HOUR_SECONDS, now, ctx.started.getTime())) continue;
    const file = join(ctx.paths.projects, project.id, 'revert-checks.json');
    const checked = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const known = new Set([...project.tickets, ...(project.backlog ?? [])].map(t => t.key.toUpperCase()));
    for (const { url } of project.json.repositories ?? []) {
      await ctx.attempt(PHASE, `${project.id} ${url}`, async () => {
        const commits = await commitsSince(ctx, url, checked[url] ?? iso(now - HOUR_SECONDS * 1000));
        checked[url] = iso(now);
        writeFileSync(`${file}.tmp`, JSON.stringify(checked, null, 4));
        renameSync(`${file}.tmp`, file);
        for (const { sha, subject } of commits) {
          const key = subject?.match(REVERT)?.[1].toUpperCase();
          if (!key || !known.has(key)) continue;
          ctx.log(PHASE, `${project.id}: ${sha} on ${url} reverts ${key}; its memories are reviewed`);
          if (await startTrigger(ctx, state, PHASE, project, 'check-memory', { 'work-item': key })) state = ctx.load();
        }
      });
    }
  }
}
