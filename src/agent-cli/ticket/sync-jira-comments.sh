#!/usr/bin/env bash
# Description: Keep a Jira ticket's comments, as fetched, in its work folder — ticket:sync-jira-comments <project> <ticket-key> <json-file>.
set -euo pipefail

# The downloader's write of a Jira ticket's comments (ASS-37). <json-file>
# holds { "comments": [ { id, author, created, updated, body }… ] }, merged,
# in one locked write, into data/projects/<project>/work/<ticket-key>/
# jira-comments.json — { "<id>": { author, created, updated, body } }, made,
# folder and all, when missing: a new id is added, one already there replaced
# (an edit changes its updated), and an id not in the fetch (deleted in Jira)
# kept. Prints `synced <n> comments (<new> new)`. Fails, writing nothing, on
# a bad or missing project, a bad ticket key, a missing file, or one that is
# not { comments } with an id on each. PROJECTS_DIR overrides the projects
# folder, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 3 ]] || { echo "usage: ticket:sync-jira-comments <project> <ticket-key> <json-file>" >&2; exit 1; }
project="$1" ticket="$2" fetched="$3"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:sync-jira-comments: invalid project '$project'" >&2; exit 1; }
[[ "$ticket" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:sync-jira-comments: invalid ticket '$ticket'" >&2; exit 1; }
[[ -d "$projects/$project" ]] || { echo "ticket:sync-jira-comments: no project $project" >&2; exit 1; }
[[ -f "$fetched" ]] || { echo "ticket:sync-jira-comments: no file $fetched" >&2; exit 1; }
jq -e '.comments | type == "array" and all(type == "object" and (.id | type == "string" or type == "number"))' "$fetched" >/dev/null 2>&1 \
  || { echo "ticket:sync-jira-comments: $fetched is not { comments: [{ id, … }] }" >&2; exit 1; }

dir="$projects/$project/work/$ticket"
mkdir -p "$dir"
( set -o noclobber; echo '{}' > "$dir/jira-comments.json" ) 2>/dev/null || true
before="$(jq -c 'keys' "$dir/jira-comments.json")"
update_json "$dir/jira-comments.json" --slurpfile f "$fetched" \
  'reduce $f[0].comments[] as $c (.; .[$c.id | tostring] = { author: $c.author, created: $c.created, updated: $c.updated, body: $c.body })'
jq -r --argjson before "$before" '"synced \(.comments | length) comments (\([.comments[].id | tostring] - $before | length) new)"' "$fetched"
