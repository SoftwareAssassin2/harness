#!/usr/bin/env bash
# Description: Record whether Jira takes a project's analytics API token — analytics:record-sign-in <project> <json-file>.
set -euo pipefail

# ASS-475: the downloader's analytics sign-in check (GET /rest/api/3/myself,
# src/downloader/jira-rest.js checkSignIn), as the dashboard shows it. Jira's
# search answers a rejected token as an anonymous user with no issues, so
# without this a project's analytics would go stale with nothing said.
# <json-file> holds { "signed-in": true } once a round signs in — then
# data/projects/<project>/jira-token-rejected.json is removed (nothing when it
# is not there) — or { "signed-in": false, "status": <HTTP status>, "problem":
# "<text>", "work-source": "<name>" } when Jira rejects the token — then that
# file becomes { since, status, problem, work-source }, `since` kept from the
# record already there (the first rejection's time, UTC), else now. The
# dashboard (src/tui/load.js jiraTokenRejected) shows a header warning and a
# line on the Performance screen while the file is there. Nothing else is
# touched: tickets.json and its fetched-through stay as they were. Prints
# `signed in` or `token rejected since <since>`. Fails, writing nothing, on a
# bad or missing project, a missing file, or one not of that shape.
# PROJECTS_DIR overrides the projects folder, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"
command=analytics:record-sign-in

[[ $# -eq 2 ]] || { echo "usage: $command <project> <json-file>" >&2; exit 1; }
project="$1" answer="$2"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; exit 1; }
[[ -f "$projects/$project/project.json" ]] || { echo "$command: no project $project" >&2; exit 1; }
[[ -f "$answer" ]] || { echo "$command: no file $answer" >&2; exit 1; }
jq -e '(."signed-in" == true) or (."signed-in" == false and (.status | type == "number") and (.problem | type == "string"))' "$answer" >/dev/null 2>&1 \
  || { echo "$command: $answer is not { signed-in: true } or { signed-in: false, status, problem, work-source? }" >&2; exit 1; }

record="$projects/$project/jira-token-rejected.json"
if jq -e '."signed-in"' "$answer" >/dev/null; then
  if [[ -e "$record" ]]; then
    lock_on 9 "$record.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}"
    rm -f "$record"
    exec 9>&-
  fi
  echo 'signed in'
  exit 0
fi
update_json --create "$record" --slurpfile a "$answer" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  { since: (.since // $now), status: $a[0].status, problem: $a[0].problem, "work-source": ($a[0]."work-source" // null) }'
jq -r '"token rejected since \(.since)"' "$record"
