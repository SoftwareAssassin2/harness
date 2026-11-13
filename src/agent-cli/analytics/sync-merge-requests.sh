#!/usr/bin/env bash
# Description: Keep every merged merge request or pull request of a project's GitLab and GitHub repositories, for analytics — analytics:sync-merge-requests <project> <json-file>.
set -euo pipefail

# The downloader's write of the merged merge requests (GitLab) and pull
# requests (GitHub) it read this cycle (ASS-408; src/downloader/
# merged-merge-requests.js). <json-file> holds { "fetched-through": {
# "<repository url>": "<ISO time>" }, "merge-requests": [ { repo, host:
# "gitlab"|"github", iid (GitHub: the number), title, branch, author:
# { username, name }, merged-at }… ] }.
# In one locked write (update_json: written beside and renamed over, so a
# reader never sees half of it) data/projects/<project>/analytics/
# merge-requests.json becomes
#   { "fetched-through": { "<repository url>": "<ISO time>" },
#     "merge-requests": { "<group/project>!<iid>" (GitLab) or
#       "<owner/repo>#<number>" (GitHub): { repo, host, iid, title, branch,
#       author: { username, name }, merged-at } } }
# — each read repository's fetched-through set (one not in the payload, a read
# that failed, keeps its own), each merge request read replacing its entry,
# every other entry kept, so the history only grows. One without a merged-at
# is skipped. The file and its folder are made when missing. Prints `synced
# <n> merged merge requests (<total> kept)`. Fails, writing nothing, on a bad
# or missing project, a missing file, or one not of that shape. PROJECTS_DIR
# overrides the projects folder, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 2 ]] || { echo "usage: analytics:sync-merge-requests <project> <json-file>" >&2; exit 1; }
project="$1" fetched="$2"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "analytics:sync-merge-requests: invalid project '$project'" >&2; exit 1; }
[[ -f "$projects/$project/project.json" ]] || { echo "analytics:sync-merge-requests: no project $project" >&2; exit 1; }
[[ -f "$fetched" ]] || { echo "analytics:sync-merge-requests: no file $fetched" >&2; exit 1; }
jq -e '(."fetched-through" | type == "object" and all(.[]; type == "string"))
  and (."merge-requests" | type == "array" and all(.[]; type == "object" and (.repo | type == "string" and length > 0) and (.host == "gitlab" or .host == "github") and (.iid | type == "number")))' "$fetched" >/dev/null 2>&1 \
  || { echo "analytics:sync-merge-requests: $fetched is not { fetched-through: { <url>: <time> }, merge-requests: [{ repo, host, iid, … }] }" >&2; exit 1; }

mkdir -p "$projects/$project/analytics"
file="$projects/$project/analytics/merge-requests.json"
# merged: the payload's merge requests that have a merged-at (AC2: one without is skipped).
update_json --create "$file" --slurpfile f "$fetched" '
  ($f[0]."merge-requests" | map(select((."merged-at" // "") != "")
      | { key: "\(.repo)\(if .host == "github" then "#" else "!" end)\(.iid)", value: { repo, host, iid, title: (.title // ""), branch: (.branch // null),
          author: { username: (.author.username // null), name: (.author.name // null) }, "merged-at": ."merged-at" } })
    | from_entries) as $new
  | { "fetched-through": ((."fetched-through" // {}) + $f[0]."fetched-through"),
      "merge-requests": ((."merge-requests" // {}) + $new) }'
n="$(jq '[."merge-requests"[] | select((."merged-at" // "") != "")] | length' "$fetched")"
jq -r --arg n "$n" '"synced \($n) merged merge requests (\(."merge-requests" | length) kept)"' "$file"
