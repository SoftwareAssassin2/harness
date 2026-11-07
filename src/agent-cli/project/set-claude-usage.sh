#!/usr/bin/env bash
# Description: Record a project's Claude session and weekly usage and account — project:set-claude-usage <project> <email|-> <session-percent|-> <resets-at|-> <weekly-percent|-> <weekly-resets-at|-> <auth-method|-> <org|->.
set -euo pipefail

# Writes { email, session: { percent, resets-at }, weekly: { percent,
# resets-at }, as-of } to
# data/projects/<project>/claude-usage.json (PROJECTS_DIR overrides the projects
# folder, used by tests) — live data, kept out of the tracked project.json
# like rate-limit.json (ASS-94): what control last read of the project's
# Claude login every 2 minutes (ASS-47, triggers.js checkUsage), `email` the
# account it is logged in to, `percent` how much of the 5-hour session window
# is used (0–100, as the usage endpoint gives it), `resets-at` when that
# window resets, `weekly` the same of the 7-day window (ASS-65) — null when
# both its arguments are `-`, a plan with no weekly cap — `auth-method` and
# `org` claude auth status's authMethod and orgName (ASS-221: an api_key login
# bills to that org's API key, not a subscription) — `as-of` now. The
# dashboard shows it at the foot of the models box. A plain overwrite: `-`
# leaves that field null, and keeping the last reading when a read fails is
# control's to do, by passing it back. Fails, writing nothing, unless each
# percent is a number from 0 to 100, each time ISO 8601 UTC
# (YYYY-MM-DDTHH:MM:SS[.fff]Z) and the project has a project.json.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

usage="usage: project:set-claude-usage <project> <email|-> <session-percent|-> <resets-at|-> <weekly-percent|-> <weekly-resets-at|-> <auth-method|-> <org|->"
[[ $# -eq 8 ]] || { echo "$usage" >&2; exit 1; }
# The project becomes a path segment, so it may not climb out of the projects folder.
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:set-claude-usage: invalid project '$1'" >&2; exit 1; }
[[ -n "$2" ]] || { echo "$usage" >&2; exit 1; }
percent() { [[ "$2" == - ]] || { [[ "$2" =~ ^[0-9]+(\.[0-9]+)?$ ]] && awk -v p="$2" 'BEGIN { exit !(p <= 100) }'; } \
  || { echo "project:set-claude-usage: the $1 percent must be a number from 0 to 100, got '$2'" >&2; exit 1; }; }
resetsAt() { [[ "$1" == - || "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] \
  || { echo "project:set-claude-usage: the time must be ISO 8601 UTC, like 2026-10-15T13:00:00Z" >&2; exit 1; }; }
percent session "$3"; resetsAt "$4"; percent weekly "$5"; resetsAt "$6"
[[ -f "$projects/$1/project.json" ]] || { echo "project:set-claude-usage: no project $1" >&2; exit 1; }

orNull() { [[ "$1" == - ]] && echo null || echo "$2"; }
update_json --create "$projects/$1/claude-usage.json" \
  --argjson email "$(orNull "$2" "$(jq -n --arg e "$2" '$e')")" \
  --argjson percent "$(orNull "$3" "$3")" \
  --argjson at "$(orNull "$4" "\"$4\"")" \
  --argjson weeklyPercent "$(orNull "$5" "$5")" \
  --argjson weeklyAt "$(orNull "$6" "\"$6\"")" \
  --argjson authMethod "$(orNull "$7" "$(jq -n --arg m "$7" '$m')")" \
  --argjson org "$(orNull "$8" "$(jq -n --arg o "$8" '$o')")" '
  { email: $email, session: { percent: $percent, "resets-at": $at },
    weekly: (if $weeklyPercent == null and $weeklyAt == null then null else { percent: $weeklyPercent, "resets-at": $weeklyAt } end),
    "auth-method": $authMethod, org: $org,
    "as-of": (now | floor | todate) }'
