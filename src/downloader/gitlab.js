// The GitLab adapter: a repository's merge requests, fetched with glab
// (GitLab's CLI, signed in on this machine), in the sprint's variation
// merge-request shape. Which ticket each belongs to is the scan's
// (merge-requests.js). `run(cmd, args)` runs a command and resolves to its
// stdout; the downloader passes execFile, tests a fake.
//
// One list per repository a cycle (the newest 100), and, for a sprint ticket
// it finds nothing for, a lookup by branch or a search (ASS-98):
//   glab mr list --repo <group/project> --all --per-page 100 [--source-branch <b> | --search <s>] -F json
// and, for a recorded merge request no list showed, a read of it (ASS-122):
//   glab mr view <iid> --repo <group/project> -F json

const BUILD_STATUS = { success: 'Passed', failed: 'Failed', running: 'Running' };
const STATUS = { merged: 'Merged', closed: 'Closed' };

// repoPath(url) → "group/project" from a GitLab project url, for --repo.
export function repoPath(url) {
  return new URL(url).pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
}

// fetchMergeRequests({ repoUrl, branch, search }, run) → [ { key: "!<iid>",
// "build-status", url, status, branch, title } ], in glab's order: the newest
// 100; given branch, those from that source branch; given search, those with
// it in their title or description. build-status: Merged when merged, else the
// pipeline's success → Passed, failed → Failed, running → Running, anything
// else (none included) → Pending. status (ASS-80): Merged, Closed, else Open.
export async function fetchMergeRequests({ repoUrl, branch, search }, run) {
  const out = await run('glab', ['mr', 'list', '--repo', repoPath(repoUrl), '--all', '--per-page', '100',
    ...(branch ? ['--source-branch', branch] : []), ...(search ? ['--search', search] : []), '-F', 'json']);
  return mergeRequests(out).map(shaped);
}

// fetchMergeRequest({ url }, run) → the merge request at that url
// (https://<host>/<group/project>/-/merge_requests/<iid>), shaped as
// fetchMergeRequests's; rejects when glab cannot read it.
export async function fetchMergeRequest({ url }, run) {
  const [, repo, iid] = new URL(url).pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)\/?$/) ?? [];
  if (!iid) throw new Error(`not a merge request url: ${url}`);
  const out = await run('glab', ['mr', 'view', iid, '--repo', repo, '-F', 'json']);
  let mr;
  try { mr = JSON.parse(out); } catch { /* below */ }
  if (!mr || typeof mr !== 'object' || Array.isArray(mr)) throw new Error(`glab printed no merge request: ${out.slice(0, 200)}`);
  return shaped(mr);
}

const shaped = mr => ({
  key: `!${mr.iid}`,
  'build-status': mr.state === 'merged' ? 'Merged' : BUILD_STATUS[(mr.head_pipeline ?? mr.pipeline)?.status] ?? 'Pending',
  url: mr.web_url,
  status: STATUS[mr.state] ?? 'Open',
  branch: mr.source_branch,
  title: mr.title,
});

function mergeRequests(out) {
  if (out.trim() === '') return [];
  let data;
  try { data = JSON.parse(out); } catch { throw new Error(`glab did not print JSON: ${out.slice(0, 200)}`); }
  if (!Array.isArray(data)) throw new Error(`glab printed no merge requests: ${out.slice(0, 200)}`);
  return data;
}
