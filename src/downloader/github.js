// The GitHub adapter: a repository's pull requests (the harness's own,
// recorded #<number> by merge-request:create), fetched with gh (signed in on
// this machine, read only), in the same merge-request shape as gitlab.js's, so
// a cycle refreshes them the same way (ASS-92). `run(cmd, args)` as there.
//   gh pr list --repo <owner/repo> --state all --limit 100 [--head <b> | --search "<s> in:title"] --json …
//   gh pr view <number> --repo <owner/repo> --json …   (a recorded one no list showed, ASS-122)
import { repoPath } from './gitlab.js';

const FIELDS = 'number,url,state,headRefName,title,statusCheckRollup';
const STATUS = { MERGED: 'Merged', CLOSED: 'Closed' };
const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];

// fetchMergeRequests({ repoUrl, branch, search }, run) → [ { key: "#<number>",
// "build-status", url, status, branch, title } ], in gh's order: the newest
// 100; given branch, those from that head branch; given search, those with it
// in their title. build-status: Merged when merged, else, of its checks
// (statusCheckRollup), one failed → Failed, one not finished → Running, all
// finished → Passed, none → Pending. status: Merged, Closed, else Open.
export async function fetchMergeRequests({ repoUrl, branch, search }, run) {
  const out = await run('gh', ['pr', 'list', '--repo', repoPath(repoUrl), '--state', 'all', '--limit', '100',
    ...(branch ? ['--head', branch] : []), ...(search ? ['--search', `${search} in:title`] : []), '--json', FIELDS]);
  return pullRequests(out).map(shaped);
}

// fetchMergeRequest({ url }, run) → the pull request at that url
// (https://github.com/<owner/repo>/pull/<number>), shaped as
// fetchMergeRequests's; rejects when gh cannot read it.
export async function fetchMergeRequest({ url }, run) {
  const [, repo, number] = new URL(url).pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/) ?? [];
  if (!number) throw new Error(`not a pull request url: ${url}`);
  const out = await run('gh', ['pr', 'view', number, '--repo', repo, '--json', FIELDS]);
  let pr;
  try { pr = JSON.parse(out); } catch { /* below */ }
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) throw new Error(`gh printed no pull request: ${out.slice(0, 200)}`);
  return shaped(pr);
}

const shaped = pr => ({
  key: `#${pr.number}`,
  'build-status': pr.state === 'MERGED' ? 'Merged' : buildStatus(pr.statusCheckRollup ?? []),
  url: pr.url,
  status: STATUS[pr.state] ?? 'Open',
  branch: pr.headRefName,
  title: pr.title,
});

// A check run has status and conclusion; a status context, state.
function buildStatus(checks) {
  const results = checks.map(c => c.conclusion || c.state || '');
  if (results.some(r => FAILED.includes(r))) return 'Failed';
  if (checks.some(c => (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(c.state))) return 'Running';
  return checks.length ? 'Passed' : 'Pending';
}

function pullRequests(out) {
  if (out.trim() === '') return [];
  let data;
  try { data = JSON.parse(out); } catch { throw new Error(`gh did not print JSON: ${out.slice(0, 200)}`); }
  if (!Array.isArray(data)) throw new Error(`gh printed no pull requests: ${out.slice(0, 200)}`);
  return data;
}
