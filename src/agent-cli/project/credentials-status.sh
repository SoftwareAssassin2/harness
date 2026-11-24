#!/usr/bin/env bash
# Description: Whether a project's work is held by its credentials, and why — project:credentials-status <project> [--fail-when-held]; prints { held, since, problems[, substrate][, warnings] }.
set -euo pipefail

# ASS-395. Reads data/projects/<project>/credentials-hold.json, which
# project:check-credentials records (control runs it at start and every few
# minutes, src/control/credentials.js), and prints
#   { "held": true, "since": "<UTC>", "problems": [{ credential, problem, fix }, …] }
# or { "held": false, "since": null, "problems": [] } — never a check of its
# own, so it is cheap for a step or an agent to ask (Blocked's Classify: a
# credential cause waits on this hold rather than going to Blocked for Human).
# With --fail-when-held it exits 3 while held, for a script step's exit-code
# condition. PROJECTS_DIR overrides the projects folder. Fails on a bad project.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"
command=project:credentials-status

fail_when_held=0
[[ $# -eq 2 && "$2" == --fail-when-held ]] && { fail_when_held=1; set -- "$1"; }
[[ $# -eq 1 ]] || { echo "usage: $command <project> [--fail-when-held]" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
[[ -f "$projects/$1/project.json" ]] || { echo "$command: no project $1" >&2; exit 1; }

# ASS-533: with `substrate` added — { checked-at, problems: [{ machine, credential, problem, fix }] } — for a project
# with Substrate clusters: what they need (check-credentials' substrate-needs.json), which holds nothing.
record="$projects/$1/credentials-hold.json" needs="$projects/$1/substrate-needs.json"
substrate='null'
[[ ! -f "$needs" ]] || substrate="$(jq -c '.' "$needs" 2>/dev/null || echo null)"
# ASS-571: with `warnings` added — [{ credential, problem, fix }], holding nothing — while control's last reading of
# the project's Claude usage failed (claude-usage.json's failure, src/control/usage.js: its login token expired and
# could not be refreshed, refused, missing): the usage figures go stale, and the weekly hold reads old ones. The fix
# signs that login in again on the Mac: its config dir is the project's .claude when it has one, else ~/.claude.
warnings='[]'
usage="$projects/$1/claude-usage.json"
if why="$(jq -er '.failure.why // empty | strings' "$usage" 2>/dev/null)"; then
  at="$(jq -r '.failure.at // ""' "$usage")" asof="$(jq -r '."as-of" // ""' "$usage")"
  config=''
  [[ ! -d "$projects/$1/.claude" ]] || config="CLAUDE_CONFIG_DIR=$(readlink -f "$projects/$1/.claude") "
  warnings="$(jq -cn --arg why "$why" --arg at "$at" --arg asof "$asof" --arg fix "${config}claude (it refreshes its token as it starts), then /login if it asks" \
    '[{ credential: "the Claude usage token", problem: "its usage cannot be read since \($at): \($why); \(if $asof == "" then "never read" else "last read \($asof)" end)", fix: $fix }]')"
fi
extra() { jq -cn --argjson s "$substrate" --argjson w "$warnings" '(if $s == null then {} else { substrate: $s } end) + (if $w == [] then {} else { warnings: $w } end)'; }
if [[ -f "$record" ]] && jq -e '(.problems | length) > 0' "$record" >/dev/null 2>&1; then
  jq -c --argjson x "$(extra)" '{ held: true, since: (.since // null), problems } + $x' "$record"
  [[ $fail_when_held -eq 0 ]] || exit 3
else
  jq -cn --argjson x "$(extra)" '{ held: false, since: null, problems: [] } + $x'
fi
