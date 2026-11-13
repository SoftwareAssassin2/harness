#!/usr/bin/env bash
# Description: Keep the board's sprints for analytics — analytics:sync-sprints <project> <json-file>.
set -euo pipefail

# The downloader's write of a project's Jira board sprints (ASS-406), every
# state (active, closed, future), read through Jira's REST API each cycle.
# <json-file> holds { "sprints": [ { id, name, state, start, end }… ] }
# (start and end ISO times, or null); in one locked write (update_json)
# data/projects/<project>/analytics/sprints.json becomes { "sprints": [ { id,
# name, state, start, end } ] }, by id: each sprint read replaces its entry,
# one not read again (deleted on the board) stays, so the tickets' sprint ids
# still name one. In start order, those without a start (future sprints)
# last, then by id. The analytics folder and the file are made when missing.
# Nothing else is touched. Prints `synced <n> analytics sprints`. Fails,
# writing nothing, on a bad or missing project, a missing file, or one not of
# that shape. PROJECTS_DIR overrides the projects folder, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 2 ]] || { echo "usage: analytics:sync-sprints <project> <json-file>" >&2; exit 1; }
project="$1" fetched="$2"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "analytics:sync-sprints: invalid project '$project'" >&2; exit 1; }
[[ -f "$projects/$project/project.json" ]] || { echo "analytics:sync-sprints: no project $project" >&2; exit 1; }
[[ -f "$fetched" ]] || { echo "analytics:sync-sprints: no file $fetched" >&2; exit 1; }
jq -e '.sprints | type == "array" and all(type == "object" and (.id | type == "number"))' "$fetched" >/dev/null 2>&1 \
  || { echo "analytics:sync-sprints: $fetched is not { sprints: [{ id, … }] }" >&2; exit 1; }

mkdir -p "$projects/$project/analytics"
update_json --create "$projects/$project/analytics/sprints.json" --slurpfile f "$fetched" '
  ($f[0].sprints | map({ id, name: (.name // ""), state: (.state // null), start: (.start // null), end: (.end // null) })) as $read
  | ($read | map(.id)) as $ids
  | { sprints: (((.sprints // []) | map(select(.id as $i | $ids | any(. == $i) | not))) + $read
      | sort_by([(.start == null), (.start // ""), .id])) }'
jq -r '"synced \(.sprints | length) analytics sprints"' "$projects/$project/analytics/sprints.json"
