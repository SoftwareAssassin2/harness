// ASS-558: every commit made for a ticket variation, across all of its
// project's repositories, gathered for the ticket screen's Commits tab. The
// dashboard only reads files, so the list is kept in the ticket's work folder,
// work/<KEY>/commits-<variation>.json (COMMITS_FILE), written whole by
// `agent.sh ticket:refresh-commits` (src/agent-cli/ticket/refresh-commits.js)
// — which control runs periodically and after each step that commits
// (commit-refresh.js) — and read by src/tui/load.js loadCommits:
//   { key, variation, "refreshed-at", since, sources: [{ source, repository, ok, error? }],
//     commits: [{ repository, sha, short, date, author, subject, branch, mr, "mr-url", state, url }] }
//
// Where commits are found, in order of preference (the ticket's Context):
// 1. The forge, read only, with the host's own glab / gh logins (as reverts.js
//    reads it; never a VM token): for each repository, its branches named for
//    the variation (change/<KEY>[-…] for A, change/<KEY>.<var>[-…] for
//    another: code.bash branch_name, the merge-request plan's
//    change/<KEY>.<var>-<id>) and their commits ahead of the default branch;
//    each opened merge request's own commits (merge-request:* reads them the
//    same way, merge-requests.bash open_questions); and the default branch's
//    commits since the variation began that reference the key (referencesKey:
//    a "<KEY>:" subject, a squash or merge commit naming change/<KEY>…, or a
//    subject naming the key itself).
// 2. The harness's clones on the Mac: the project's local-pc checkout and the
//    harness's own clones under data/projects/<p>/checkouts/ (ASS-553), read
//    with plain `git log` / `for-each-ref` — never fetched, nothing written:
//    the operator's checkout is left as it is. Only a clone shows commits not
//    pushed yet (local only).
// 3. The ticket's machine is not read. A step's end pushes its branch (vm:step-
//    end, workstation:release, code:hand-over), so what a machine holds beyond
//    the forge is only the step in progress; and gathering must never start or
//    connect to a machine (AC3), so nothing here runs limactl, ssh, gcloud or
//    kubectl — only glab, gh and git (the tests check it).
//
// Each commit's state is the furthest any source saw it get (STATES, in
// order): local only (a clone's local branch, on no remote branch) < pushed
// (a branch on the forge, or a merge request closed unmerged) < in an open MR
// < merged to the default branch (on it, or in a merged merge request — a
// squashed one's own commits included). A SHA seen by several sources is
// listed once (AC2), with the most it is known by (its merge request, its branch).

export const COMMITS_FILE = variation => `commits-${variation}.json`;
export const STATES = ['local', 'pushed', 'open-mr', 'merged'];
const RANK = Object.fromEntries(STATES.map((s, i) => [s, i]));
// How many pages of 100 default-branch commits a repository is read for (since the variation began).
export const DEFAULT_PAGES = 3;
// A guard on one clone's log: no ticket has more.
const LOG_LIMIT = 500;

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const upper = s => String(s ?? '').toUpperCase();

// variationOfBranch(branch, key) — the variation a branch is named for — 'A' for change/<KEY> or change/<KEY>-…,
// '<var>' for change/<KEY>.<var> or change/<KEY>.<var>-… (in any case) — or null for a branch of none
// (change/<KEY>0, another ticket's). ABC-1's never matches ABC-10's.
export function variationOfBranch(branch, key) {
  const m = new RegExp(`^(?:refs/heads/|refs/remotes/origin/|origin/)?change/${esc(upper(key))}(?:\\.([A-Za-z]+))?(?:-[\\w.-]+)?$`, 'i').exec(String(branch ?? ''));
  return m ? (m[1] ? upper(m[1]) : 'A') : null;
}

// referencesKey(message, key) — whether a default-branch commit is the ticket's, and the variation it names:
// { variation } ('A', '<var>', or null when it names none), or null when it is not the ticket's. It is when
// its subject starts "<KEY>:" (every harness commit), when its message names a branch of the ticket
// (change/<KEY>…: a merge commit, GitLab's or GitHub's squash with the branch in its body), or when its subject
// names the key as a whole word (a squash titled by its merge request) — unless it starts with another
// ticket's "<KEY>:" (a follow-up citing this one) or is a revert.
export function referencesKey(message, key) {
  const text = String(message ?? ''), subject = text.split('\n')[0], k = upper(key);
  if (/^Revert "/.test(subject)) return null;
  const branch = new RegExp(`change/${esc(k)}(?:\\.([A-Za-z]+))?(?![0-9A-Za-z])`, 'i').exec(text);
  const variation = branch ? (branch[1] ? upper(branch[1]) : 'A') : null;
  if (subject.startsWith(`${k}:`)) return { variation };
  if (branch) return { variation };
  const other = /^([A-Za-z][A-Za-z0-9]*-\d+):/.exec(subject);
  if (other && upper(other[1]) !== k) return null;
  return new RegExp(`(?<![A-Za-z0-9-])${esc(k)}(?![0-9])`, 'i').test(subject) ? { variation: null } : null;
}

// repoUrlOf(url) — a git remote or repository url as https://host/path, lower-cased, no .git or trailing slash: two
// spellings of one repository compare equal. null for one that does not parse.
export function repoUrlOf(url) {
  let s = String(url ?? '').trim();
  const scp = /^(?:ssh:\/\/)?[^@/]+@([^:/]+)[:/](.+)$/.exec(s);
  if (scp) s = `https://${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(s);
    return `https://${u.hostname}${u.pathname.replace(/\.git$|\/+$/g, '').replace(/\.git$/, '')}`.toLowerCase();
  } catch { return null; }
}
const repoName = url => String(url ?? '').replace(/\.git$|\/+$/g, '').split('/').pop() || '?';
const pathOf = url => new URL(url).pathname.replace(/^\/+|\.git$|\/+$/g, '');
const onGithub = url => new URL(url).hostname === 'github.com';

// mrRepository(mr) — the repository url a merge request record is in: its own `repository`, else read off its url
// (GitLab's …/<path>/-/merge_requests/<iid>, GitHub's …/<owner>/<repo>/pull/<n>); null when neither says.
export function mrRepository(mr) {
  if (mr?.repository) return mr.repository;
  try {
    const u = new URL(mr.url);
    const gl = /^\/(.+?)\/-\/merge_requests\/\d+/.exec(u.pathname), gh = /^\/([^/]+\/[^/]+)\/pull\/\d+/.exec(u.pathname);
    return gl || gh ? `https://${u.hostname}/${(gl ?? gh)[1]}` : null;
  } catch { return null; }
}
// commitUrl(repoUrl, sha) — the commit's page on its forge (GitHub's …/commit/<sha>, GitLab's …/-/commit/<sha>); null without a repository.
export function commitUrl(repoUrl, sha) {
  try {
    const u = String(repoUrl).replace(/\.git$|\/+$/g, '');
    return new URL(u).hostname === 'github.com' ? `${u}/commit/${sha}` : `${u}/-/commit/${sha}`;
  } catch { return null; }
}
const opened = mr => Boolean(mr?.url && mr?.key);
const mrState = mr => (mr.status === 'Merged' || mr['build-status'] === 'Merged' ? 'merged' : mr.status === 'Open' ? 'open-mr' : 'pushed');

// ===== The forge, read only (glab / gh; `run(cmd, args)` resolves to stdout) =====
const json = async (run, cmd, args) => {
  const out = await run(cmd, args);
  try { return JSON.parse(out); } catch { throw new Error(`${cmd} ${args.join(' ')}: not JSON`); }
};
const gl = (run, url, endpoint) => json(run, 'glab', ['api', `projects/${encodeURIComponent(pathOf(url))}${endpoint}`, '--hostname', new URL(url).hostname]);
const gh = (run, url, endpoint) => json(run, 'gh', ['api', `repos/${pathOf(url)}${endpoint}`]);
// One commit as every source gives it: { sha, subject, message, author, date }.
const fromGitlab = c => ({ sha: c.id, message: c.message ?? c.title ?? '', subject: c.title ?? String(c.message ?? '').split('\n')[0], author: c.author_name ?? null, date: c.authored_date ?? c.created_at ?? null });
const fromGithub = c => ({ sha: c.sha, message: c.commit?.message ?? '', subject: String(c.commit?.message ?? '').split('\n')[0], author: c.commit?.author?.name ?? c.author?.login ?? null, date: c.commit?.author?.date ?? null });

export function forgeReader(run) {
  return {
    // defaultBranch(url) — the repository's default branch.
    defaultBranch: async url => (onGithub(url) ? (await gh(run, url, '')).default_branch : (await gl(run, url, '')).default_branch),
    // branches(url, prefix) — the names of its branches starting `prefix`.
    branches: async (url, prefix) => (onGithub(url)
      ? (await gh(run, url, `/git/matching-refs/heads/${prefix}`)).map(r => r.ref.replace(/^refs\/heads\//, ''))
      : (await gl(run, url, `/repository/branches?search=${encodeURIComponent(`^${prefix}`)}&per_page=100`)).map(b => b.name)),
    // ahead(url, base, head) — the commits on `head` not on `base`.
    ahead: async (url, base, head) => (onGithub(url)
      ? ((await gh(run, url, `/compare/${base}...${head}`)).commits ?? []).map(fromGithub)
      : ((await gl(run, url, `/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`)).commits ?? []).map(fromGitlab)),
    // mrCommits(mr) — an opened merge request's commits.
    mrCommits: async mr => {
      const url = mrRepository(mr), number = String(mr.key).replace(/^[!#]/, '');
      return onGithub(url) ? (await gh(run, url, `/pulls/${number}/commits?per_page=100`)).map(fromGithub)
        : (await gl(run, url, `/merge_requests/${number}/commits?per_page=100`)).map(fromGitlab);
    },
    // onDefault(url, since) — the default branch's commits since `since`, newest first, up to DEFAULT_PAGES pages.
    onDefault: async (url, since) => {
      const found = [];
      for (let page = 1; page <= DEFAULT_PAGES; page++) {
        const q = `/${onGithub(url) ? '' : 'repository/'}commits?since=${encodeURIComponent(since)}&per_page=100&page=${page}`;
        const batch = onGithub(url) ? (await gh(run, url, q)).map(fromGithub) : (await gl(run, url, q)).map(fromGitlab);
        found.push(...batch);
        if (batch.length < 100) break;
      }
      return found;
    },
  };
}

// ===== A clone on the Mac, read only (git; `run('git', args)` resolves to stdout) =====
const FIELD = '\x1f', RECORD = '\x1e';
const LOG_FORMAT = `--format=%H${FIELD}%an${FIELD}%aI${FIELD}%B${RECORD}`;
const parseLog = out => String(out ?? '').split(RECORD).map(r => r.replace(/^\n+/, '')).filter(r => r.trim()).map(r => {
  const [sha, author, date, message = ''] = r.split(FIELD);
  return { sha: sha.trim(), author, date, message: message.trimEnd(), subject: message.split('\n')[0] };
});

export function gitReader(run) {
  const git = (dir, args) => run('git', ['-C', dir, ...args]);
  return {
    origin: async dir => (await git(dir, ['remote', 'get-url', 'origin'])).trim(),
    // defaultBranch(dir) — origin's default branch (origin/HEAD), else main or master, whichever origin has.
    defaultBranch: async dir => {
      try { return (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, ''); } catch { /* none set */ }
      for (const b of ['main', 'master']) {
        try { await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]); return b; } catch { /* not this one */ }
      }
      return 'master';
    },
    // refs(dir) — its branches under change/, local (refs/heads/…) and origin's (refs/remotes/origin/…).
    refs: async dir => (await git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads/change/', 'refs/remotes/origin/change/'])).split('\n').filter(Boolean),
    // log(dir, args) — the commits `git log <args>` lists.
    log: async (dir, args) => parseLog(await git(dir, ['log', `--max-count=${LOG_LIMIT}`, LOG_FORMAT, ...args])),
  };
}

// ===== Gathering =====

// gatherCommits(input, { forge, git }) → { commits, sources }. input: { key, variation (its name), variations (the
// ticket's live variations' names), mrs (the variation's merge-request records), branch (its build.branch),
// mergedVariations (the live variations with a merged merge request), repositories (project.json's, { url, status }),
// clones (folders on the Mac), since (ISO: the default branches are read from then) }. forge: forgeReader's shape, git:
// gitReader's; either may be null (not read). A source that fails is recorded in `sources` with its error, the rest
// still read.
export async function gatherCommits(input, { forge, git }) {
  const { key, variation, variations = [variation], mrs = [], branch = null, mergedVariations = [], repositories = [], clones = [], since } = input;
  const found = new Map(), sources = [];
  const mine = name => variationOfBranch(name, key) === variation || (branch && upper(name) === upper(branch)) || mrs.some(m => m.branch && upper(m.branch) === upper(name));
  // A default-branch commit naming no variation is this one's when it is the ticket's only one, the one merged, or —
  // none merged — the first.
  const unnamedIsMine = variations.length <= 1 || mergedVariations.includes(variation) || (!mergedVariations.length && variations[0] === variation);
  const onDefaultIsMine = c => { const r = referencesKey(c.message ?? c.subject, key); return r && (r.variation ? r.variation === variation : unnamedIsMine); };
  const add = (repository, c, how) => {
    if (!c?.sha) return;
    const sha = c.sha.toLowerCase(), was = found.get(sha);
    const next = {
      repository, sha, short: sha.slice(0, 8), date: c.date ?? null, author: c.author ?? null, subject: c.subject ?? '',
      branch: how.branch ?? null, mr: how.mr ?? null, 'mr-url': how.mrUrl ?? null, state: how.state, url: how.state === 'local' ? null : commitUrl(how.repoUrl, sha),   // a local-only one has no page
    };
    if (!was) { found.set(sha, next); return; }
    const better = RANK[next.state] > RANK[was.state];
    found.set(sha, {
      ...was,
      state: better ? next.state : was.state,
      date: was.date ?? next.date, author: was.author ?? next.author, subject: was.subject || next.subject,
      branch: was.branch ?? next.branch,
      mr: was.mr ?? next.mr, 'mr-url': was['mr-url'] ?? next['mr-url'], url: was.url ?? next.url,
    });
  };
  const attempt = async (source, repository, fn) => {
    try { await fn(); sources.push({ source, repository, ok: true }); } catch (error) {
      sources.push({ source, repository, ok: false, error: String(error?.message ?? error).split('\n')[0].slice(0, 300) });
    }
  };

  // The repositories: project.json's Active ones and any a merge request record is in.
  const urls = new Map();
  for (const r of repositories) if (r?.url && (r.status ?? 'Active') === 'Active' && repoUrlOf(r.url)) urls.set(repoUrlOf(r.url), r.url);
  for (const m of mrs) { const u = mrRepository(m); if (u && repoUrlOf(u) && !urls.has(repoUrlOf(u))) urls.set(repoUrlOf(u), u); }

  if (forge) {
    // 1a. Each opened merge request's commits.
    for (const m of mrs.filter(opened)) {
      const repository = repoName(mrRepository(m));
      await attempt('forge-mr', repository, async () => {
        for (const c of await forge.mrCommits(m)) add(repository, c, { state: mrState(m), branch: m.branch ?? null, mr: m.key, mrUrl: m.url, repoUrl: mrRepository(m) });
      });
    }
    // 1b. Each repository's branches of the variation with no opened merge request, and its default branch.
    for (const [norm, url] of urls) {
      const repository = repoName(url);
      await attempt('forge', repository, async () => {
        const base = await forge.defaultBranch(url);
        const withMr = new Set(mrs.filter(m => opened(m) && repoUrlOf(mrRepository(m)) === norm).map(m => upper(m.branch)));
        for (const name of (await forge.branches(url, `change/${upper(key)}`)).filter(mine)) {
          if (withMr.has(upper(name))) continue;
          for (const c of await forge.ahead(url, base, name)) add(repository, c, { state: 'pushed', branch: name, repoUrl: url });
        }
        if (since) for (const c of (await forge.onDefault(url, since)).filter(onDefaultIsMine)) add(repository, c, { state: 'merged', branch: base, repoUrl: url });
      });
    }
  }

  // 2. The clones on the Mac.
  if (git) {
    for (const dir of clones) {
      // Named after its origin's repository (the folder's name without one).
      const origin = await git.origin(dir).catch(() => null);
      const repoUrl = origin ? urls.get(repoUrlOf(origin)) ?? repoUrlOf(origin) : null;
      const repository = repoName(repoUrl ?? dir);
      await attempt('clone', repository, async () => {
        const base = await git.defaultBranch(dir);
        const remoteBase = `refs/remotes/origin/${base}`;
        for (const ref of await git.refs(dir)) {
          const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, '');
          if (!mine(name)) continue;
          if (ref.startsWith('refs/heads/')) {
            for (const c of await git.log(dir, [ref, '--not', '--remotes'])) add(repository, c, { state: 'local', branch: name, repoUrl });
          } else {
            for (const c of await git.log(dir, [ref, '--not', remoteBase])) add(repository, c, { state: 'pushed', branch: name, repoUrl });
          }
        }
        if (since) {
          const sinceArg = `--since=${since}`;
          for (const c of (await git.log(dir, [remoteBase, sinceArg]).catch(() => [])).filter(onDefaultIsMine)) add(repository, c, { state: 'merged', branch: base, repoUrl });
          for (const c of (await git.log(dir, [`refs/heads/${base}`, '--not', '--remotes', sinceArg]).catch(() => [])).filter(onDefaultIsMine)) add(repository, c, { state: 'local', branch: base, repoUrl });
        }
      });
    }
  }

  const commits = [...found.values()].toSorted((a, b) => (Date.parse(b.date ?? 0) || 0) - (Date.parse(a.date ?? 0) || 0) || a.repository.localeCompare(b.repository));
  return { commits, sources };
}

// sinceOf(variation, created, now) — where the default branches are read from: a day before the variation's first move
// (or the ticket's creation), else 30 days back.
export function sinceOf(variation, created, now = new Date()) {
  const first = (variation?.['state-changes'] ?? []).map(c => Date.parse(c.timestamp)).filter(Number.isFinite).toSorted((a, b) => a - b)[0]
    ?? (created ? Date.parse(created) : NaN);
  const at = Number.isFinite(first) ? first - 24 * 3600e3 : now.getTime() - 30 * 24 * 3600e3;
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
