#!/usr/bin/env bash
# Description: Record that a project's Claude usage could not be read, keeping the last good figures — project:set-claude-usage-failure <project> <why> [<email|-> <auth-method|-> <org|->].
set -euo pipefail

# ASS-571. Sets `failure: { why, at }` in data/projects/<project>/claude-usage.json
# (PROJECTS_DIR overrides the projects folder), leaving its session, weekly and
# as-of — the last good reading and when it was taken — as they are, so the
# dashboard can show them as stale and say why (the footer's red "usage
# unreadable (…)") and project:credentials-status can list the login as a
# warning. `at` is when this cause was first recorded: kept while `why` stays
# the same, now when it changes. With the account given (claude auth status's
# email, authMethod and orgName, `-` for none) it is recorded too; without, the
# file's is kept. A file not there yet is created with the session and weekly
# null and no as-of: there never was a reading. The next good reading
# (project:set-claude-usage, a plain overwrite) clears the failure. `why` is
# control's (src/control/usage.js): never a token, only what went wrong. Fails,
# writing nothing, unless the project has a project.json and why is not empty.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

usage="usage: project:set-claude-usage-failure <project> <why> [<email|-> <auth-method|-> <org|->]"
[[ $# -eq 2 || $# -eq 5 ]] || { echo "$usage" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:set-claude-usage-failure: invalid project '$1'" >&2; exit 1; }
[[ -n "$2" ]] || { echo "$usage" >&2; exit 1; }
[[ -f "$projects/$1/project.json" ]] || { echo "project:set-claude-usage-failure: no project $1" >&2; exit 1; }

account='null'
if [[ $# -eq 5 ]]; then
  account="$(jq -cn --arg e "$3" --arg m "$4" --arg o "$5" '{ email: $e, "auth-method": $m, org: $o } | map_values(if . == "-" then null else . end)')"
fi
update_json --create "$projects/$1/claude-usage.json" --arg why "$2" --argjson account "$account" '
  . as $was
  | (if $account == null then {} else $account end) as $a
  | { email: null, session: { percent: null, "resets-at": null }, weekly: null, "auth-method": null, org: null } + $was + $a
  | .failure = { why: $why, at: (if $was.failure.why == $why and $was.failure.at != null then $was.failure.at else (now | floor | todate) end) }'
