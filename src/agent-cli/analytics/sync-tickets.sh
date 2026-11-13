#!/usr/bin/env bash
# Description: Keep every ticket's status and assignee history for analytics — analytics:sync-tickets <project> <json-file>.
set -euo pipefail

# The downloader's write of a project's ticket history (ASS-406): every
# ticket of the board's Jira project (sub-tasks left out), whoever holds it,
# read through Jira's REST API with its full changelog — all of them on the
# first read, then those updated since the last. <json-file> holds {
# "fetched-through": <ISO time the read began>, "tickets": [ { key, title,
# type, created, points, assignee, status, sprints, status-changes,
# assignee-changes }… ] }; in one locked write (update_json: written beside
# and renamed over, so a reader never sees half of it)
# data/projects/<project>/analytics/tickets.json becomes { "fetched-through",
# "tickets": { "<KEY>": { … } } }: each ticket read replaces its entry, its
# changes put in time order; one not read again stays as it is, so the
# history only grows. The analytics folder and the file are made when
# missing. Nothing else — the sprint files, backlog.json — is touched. Prints
# `synced <n> analytics tickets, <total> kept`. Fails, writing nothing, on a
# bad or missing project, a missing file, or one not of that shape.
# PROJECTS_DIR overrides the projects folder, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 2 ]] || { echo "usage: analytics:sync-tickets <project> <json-file>" >&2; exit 1; }
project="$1" fetched="$2"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "analytics:sync-tickets: invalid project '$project'" >&2; exit 1; }
[[ -f "$projects/$project/project.json" ]] || { echo "analytics:sync-tickets: no project $project" >&2; exit 1; }
[[ -f "$fetched" ]] || { echo "analytics:sync-tickets: no file $fetched" >&2; exit 1; }
jq -e '(."fetched-through" | type == "string") and (.tickets | type == "array" and all(type == "object" and (.key | type == "string" and length > 0)
        and ((."status-changes" // []) | type == "array") and ((."assignee-changes" // []) | type == "array")))' "$fetched" >/dev/null 2>&1 \
  || { echo "analytics:sync-tickets: $fetched is not { fetched-through, tickets: [{ key, … }] }" >&2; exit 1; }

mkdir -p "$projects/$project/analytics"
update_json --create "$projects/$project/analytics/tickets.json" --slurpfile f "$fetched" '
  ($f[0].tickets | map(."status-changes" = ((."status-changes" // []) | sort_by(.at // ""))
                       | ."assignee-changes" = ((."assignee-changes" // []) | sort_by(.at // ""))
                       | { key: .key, value: . }) | from_entries) as $read
  | { "fetched-through": $f[0]."fetched-through", tickets: ((.tickets // {}) + $read) }'
jq -r --argjson n "$(jq '.tickets | length' "$fetched")" '"synced \($n) analytics tickets, \(.tickets | length) kept"' "$projects/$project/analytics/tickets.json"
