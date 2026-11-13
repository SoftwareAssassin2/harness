// Every merged merge request (GitLab) or pull request (GitHub) of a project's
// repositories, for analytics (ASS-408): a growing history, whoever authored
// it, so the harness can count each developer's merge requests and the
// repositories they work in. The sprint's merge-request scan
// (merge-requests.js, gitlab.js, github.js) is not this: it reads only the
// newest 100 and keeps only the sprint tickets'.
//
// Two readers beside gitlab.js and github.js; `run(cmd, args)` runs a command
// and resolves to its stdout (the downloader passes execFile, tests a fake).
// Both read page by page, 100 a page:
//   glab api [--hostname <host>] "projects/<url-encoded group/project>/merge_requests?state=merged[&updated_after=<ISO>]&per_page=100&page=<n>"
//     until a page has fewer than 100;
//   gh api "repos/<owner/repo>/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=<n>"
//     until a page has fewer than 100 or reaches one updated before `since`
//     (GitHub's list has no updated_after), and for each author login not
//     already known, `gh api users/<login>` for the profile name.
//
// syncMergedMergeRequests is the downloader cycle's step (cycle.js, 5b).
import { repoPath } from './gitlab.js';

const PER_PAGE = 100;
// A guard, not a limit anyone should reach: 1000 pages are 100,000 merge requests.
const MAX_PAGES = 1000;
// The read starts this long before the last read's time (AC1), so a merge
// request updated while the last read was under way is not missed.
export const OVERLAP_MS = 5 * 60_000;

// forgeOf(url) → "github" for github.com, "gitlab" for gitlab.com or a host
// named gitlab.<…> (self-hosted), else null: not read (ASS-408 scope).
export function forgeOf(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com' || /^gitlab\./.test(host)) return 'gitlab';
  return null;
}

// fetchMergedMergeRequests({ repoUrl, since }, run) → [ { repo, host:
// "gitlab", iid, title, branch, author: { username, name }, "merged-at" } ]:
// the GitLab repository's merged merge requests updated since `since` (an ISO
// time; none: all of them). One without a merged_at (GitLab gives some merged
// ones none) is left out. Rejects when glab fails or prints no list.
export async function fetchMergedMergeRequests({ repoUrl, since }, run) {
  const repo = repoPath(repoUrl), host = new URL(repoUrl).hostname;
  const found = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = `projects/${encodeURIComponent(repo)}/merge_requests?state=merged${since ? `&updated_after=${since}` : ''}&per_page=${PER_PAGE}&page=${page}`;
    const batch = list(await run('glab', ['api', ...(host === 'gitlab.com' ? [] : ['--hostname', host]), query]), 'glab');
    found.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return found.filter(mr => mr?.merged_at).map(mr => ({
    repo,
    host: 'gitlab',
    iid: mr.iid,
    title: mr.title ?? '',
    branch: mr.source_branch ?? null,
    author: { username: mr.author?.username ?? null, name: mr.author?.name ?? null },
    'merged-at': mr.merged_at,
  }));
}

// fetchMergedPullRequests({ repoUrl, since, names }, run) → the GitHub
// repository's merged pull requests updated since `since` (none: all), in the
// same shape with host "github", iid the pull request's number, branch its
// head ref. A closed one without a merged_at (closed unmerged) is left out.
// author.name is the login's profile name: names (a Map, login → name) holds
// those already known; any other login is read once (`gh api users/<login>`)
// and added to it — no profile name, or a read that fails, gives the login.
// Rejects when the list cannot be read.
export async function fetchMergedPullRequests({ repoUrl, since, names = new Map() }, run) {
  const repo = repoPath(repoUrl), after = since ? Date.parse(since) : null;
  const found = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = list(await run('gh', ['api', `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`]), 'gh');
    const recent = after === null ? batch : batch.filter(pr => !(Date.parse(pr?.updated_at) < after));
    found.push(...recent);
    if (batch.length < PER_PAGE || recent.length < batch.length) break;   // the last page, or one reaching the last read
  }
  const merged = found.filter(pr => pr?.merged_at);
  for (const login of new Set(merged.map(pr => pr.user?.login).filter(Boolean))) {
    if (names.has(login)) continue;
    let name = null;
    try { name = JSON.parse(await run('gh', ['api', `users/${login}`]))?.name; } catch { /* the login stands for the name */ }
    names.set(login, typeof name === 'string' && name.trim() ? name : login);
  }
  return merged.map(pr => ({
    repo,
    host: 'github',
    iid: pr.number,
    title: pr.title ?? '',
    branch: pr.head?.ref ?? null,
    author: { username: pr.user?.login ?? null, name: names.get(pr.user?.login) ?? pr.user?.login ?? null },
    'merged-at': pr.merged_at,
  }));
}

function list(out, cli) {
  if (out.trim() === '') return [];
  let data;
  try { data = JSON.parse(out); } catch { throw new Error(`${cli} did not print JSON: ${out.slice(0, 200)}`); }
  if (!Array.isArray(data)) throw new Error(`${cli} printed no merge requests: ${out.slice(0, 200)}`);
  return data;
}

// The last thing logged for a repository, by projects folder, project and
// repository url: one on another host, or a read that fails, logged once
// until that changes (AC4).
const notes = new Map();

// syncMergedMergeRequests({ key, project, repositories, recorded, call,
// readers, run, log }) — the cycle's step (ASS-408). repositories: project.json's
// `repositories`, every one with a url whatever its status (an archived one's
// history counts too); recorded: merge-requests.json as it stands ({} when
// missing) — its "fetched-through", by repository url, and the GitHub
// authors' names already read; readers { gitlab: fetchMergedMergeRequests,
// github: fetchMergedPullRequests } (or fakes). Each GitLab or GitHub
// repository is read from its fetched-through less OVERLAP_MS (all of it the
// first time), its fetched-through becoming the time just before its read;
// one on another host is skipped. One that fails is left out, so its
// fetched-through stays where it was, and the others are still read. Then one
// `analytics:sync-merge-requests <project> <file>` with { "fetched-through":
// { <url>: <ISO> }, "merge-requests": [ … ] } for those read — none read, no
// call. A failed call is logged; the cycle goes on.
export async function syncMergedMergeRequests({ key, project, repositories = [], recorded = {}, call, readers, run, log }) {
  const note = (url, text) => { const k = `${key}\n${url}`; if (notes.get(k) !== text) log(text); notes.set(k, text); };
  const fetchedThrough = recorded['fetched-through'] ?? {};
  // The GitHub logins whose names an earlier read found, so each is asked for once.
  const names = new Map(Object.values(recorded['merge-requests'] ?? {}).filter(m => m?.host === 'github' && m.author?.username)
    .map(m => [m.author.username, m.author.name ?? m.author.username]));
  const through = {}, mrs = [];
  for (const url of [...new Set(repositories.filter(r => r?.url).map(r => r.url))]) {
    const forge = forgeOf(url);
    if (!forge || !readers[forge]) { note(url, `${url}: neither GitLab nor GitHub; its merge requests are not read for analytics`); continue; }
    const last = Date.parse(fetchedThrough[url] ?? '');
    const since = Number.isNaN(last) ? undefined : new Date(last - OVERLAP_MS).toISOString();
    const startedAt = new Date().toISOString();
    try {
      mrs.push(...await readers[forge]({ repoUrl: url, since, names }, run));
      through[url] = startedAt;
      notes.delete(`${key}\n${url}`);
    } catch (err) {
      note(url, `${url}: merged merge requests could not be read; read again next cycle: ${String(err.message ?? err).split('\n')[0]}`);
    }
  }
  if (!Object.keys(through).length) return;
  try {
    await call(['analytics:sync-merge-requests', project], { 'fetched-through': through, 'merge-requests': mrs });
    log(`analytics: ${mrs.length} merged merge requests from ${Object.keys(through).length} repositories`);
  } catch (err) {
    log(`analytics: merged merge requests not kept: ${String(err.message ?? err).split('\n')[0]}`);
  }
}
