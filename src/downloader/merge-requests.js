// The merge-request scan of a cycle (ASS-92/98/122): what ticket:sync gets as
// a sprint sync's merge-requests — every merge request fetched, each with the
// ticket it belongs to. ticket:sync refreshes the recorded ones by url and adds
// the rest for their tickets; it never removes one, so a scan only has to be
// right about what it returns, not complete.
//
// One list per Active repository (its forge's adapter by host: github.com
// github.js, else gitlab.js). Then, on a lookup cycle:
// 1. each merge request recorded on a sprint ticket (in the sprint file, though
//    the fetch lacks it) that no list showed (one older than its repository's
//    newest 100) is fetched by its url, so its status is kept however old it is
//    (ASS-122);
// 2. each sprint ticket is looked up that has nothing recorded and none in the
//    lists or fetched (ASS-98), or has merge requests recorded but none, of all fetched,
//    on its own branch (one naming its key: a wrong one recorded, ASS-122) — in
//    every repository by its branch, change/<KEY>, and only when that finds
//    none, by its key in titles.
// So the cost stays one list per repository between lookup cycles; a lookup
// cycle adds one call per recorded merge request not listed, and one or two
// per repository for each ticket looked up — a ticket whose merge requests are
// all on other branches is looked up every lookup cycle.
//
// A merge request belongs to the ticket its source branch names (the key
// whole, in any case: K-2 is not K-20), else to the one its title starts with
// (after a "Draft:"), else to none — a title that only mentions a key gives it
// nothing. When any list, fetch or lookup fails, the scan is [] (every record
// kept this cycle, ASS-98 AC2): which repository held a ticket's merge request
// is unknown, so a partial scan is never sent.

// scanMergeRequests({ repos, keys, recorded, lookups, log }, adapters, run) →
// [ { key, "build-status", url, status, branch, ticket } ]: repos the Active
// repositories' urls; keys the fetched sprint tickets'; recorded a Map of each
// sprint-file ticket's lower-cased key to its recorded merge requests' urls; lookups whether this
// is a lookup cycle; adapters { gitlab, github }, each with
// fetchMergeRequests({ repoUrl, branch?, search? }, run) and
// fetchMergeRequest({ url }, run).
export async function scanMergeRequests({ repos, keys, recorded = new Map(), lookups = false, log = () => {} }, adapters, run) {
  let failed = false;
  const adapter = url => new URL(url).hostname === 'github.com' ? adapters.github : adapters.gitlab;
  const attempt = async (what, read, none) => {
    try { return await read(); } catch (err) {
      log(`${what}: ${String(err.message ?? err).split('\n')[0]}`);
      failed = true;
      return none;
    }
  };
  const fetch = (repoUrl, opts = {}) => attempt(`${repoUrl}: merge requests skipped`, () => adapter(repoUrl).fetchMergeRequests({ repoUrl, ...opts }, run), []);
  const everywhere = async opts => (await Promise.all(repos.map(repoUrl => fetch(repoUrl, opts)))).flat();

  const found = [];
  for (const repoUrl of repos) found.push(...await fetch(repoUrl));
  if (lookups && !failed) {
    const mine = keys.map(k => recorded.get(k.toLowerCase()) ?? []);
    const seen = new Set(found.map(mr => ident(mr.url)));
    for (const url of [...recorded.values()].flat()) {
      if (seen.has(ident(url))) continue;
      seen.add(ident(url));
      const mr = await attempt(`${url}: merge request skipped`, () => adapter(url).fetchMergeRequest({ url }, run), null);
      if (failed) break;
      found.push(mr);
    }
    const listed = new Set(found.map(mr => ownerOf(mr, keys)?.toLowerCase()));
    const onItsBranch = key => found.some(mr => branchNames(mr.branch, key));
    const looked = keys.filter((k, i) => mine[i].length ? !onItsBranch(k) : !listed.has(k.toLowerCase()));
    for (const key of failed ? [] : looked) {
      const byBranch = await everywhere({ branch: `change/${key.toUpperCase()}` });
      found.push(...byBranch);
      if (!byBranch.some(mr => ownerOf(mr, keys) === key) && !failed) found.push(...await everywhere({ search: key }));
      if (failed) break;
    }
  }
  if (failed) {
    log('merge requests: a forge could not be read; every record kept this cycle');
    return [];
  }
  const seen = new Set();
  return found.filter(mr => !seen.has(mr.url) && seen.add(mr.url))
    .map(mr => { const { title, ...rest } = mr; return { ...rest, ticket: ownerOf(mr, keys) }; });
}

// The key a merge request belongs to: the first its branch names, else the first its title starts with; null.
function ownerOf(mr, keys) {
  return keys.find(k => branchNames(mr.branch, k))
    ?? keys.find(k => new RegExp(`^(draft:\\s*)?[^A-Za-z0-9]*${escaped(k)}(?![0-9])`, 'i').test(mr.title ?? ''))
    ?? null;
}
const escaped = key => key.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
// Whether a branch names a key, whole and in any case.
const branchNames = (branch, key) => new RegExp(`(^|[^A-Za-z0-9])${escaped(key)}(?![0-9])`, 'i').test(branch ?? '');
// A merge request's identity, as ticket:sync matches it: its url, in any case, without a trailing slash.
const ident = url => String(url ?? '').toLowerCase().replace(/\/+$/, '');
