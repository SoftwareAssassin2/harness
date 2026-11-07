#!/usr/bin/env bash
# Description: Make a fix an agent will make sprint work — self-healing:take-on <project> <ticket-key> <summary> <ticket-url|-> <ticket,…|->.
set -euo pipefail

# The fix ticket joins the sprint at its execution engine's Self Healing step
# (ticket:join-sprint), where self-healing-fix runs on it like any ticket's
# sub-engine, and its plan is recorded on it — "self-healing-plan": {
# summary, ticket-url (null for -), pause-tickets (the comma-separated keys,
# upper case; [] for -) } — for self-healing:start to pause those tickets at
# the start of every attempt. Nothing is paused here. Fails, writing nothing,
# when the summary is empty or the ticket is neither in the sprint nor
# off-board.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"
agent="$here/../../../agent.sh"

[[ $# -eq 5 ]] || { echo "usage: self-healing:take-on <project> <ticket-key> <summary> <ticket-url|-> <ticket,…|->" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" summary="$3" url="$4" list="$5"
project="$(home_project self-healing:take-on "$1" "$key")"   # the fix ticket's own project (an ASS-n: the harness's)
[[ -n "${summary//[[:space:]]/}" ]] || { echo "self-healing:take-on: the summary is empty" >&2; exit 1; }
[[ "$url" != - ]] || url=""
[[ "$list" != - ]] || list=""

"$agent" ticket:join-sprint "$project" "$key" self-healing >/dev/null
update_whole_ticket self-healing:take-on "$project" "$key" --arg summary "$summary" --arg url "$url" --arg list "$list" '
  .["self-healing-plan"] = { summary: $summary, "ticket-url": (if $url == "" then null else $url end),
    "pause-tickets": ($list | ascii_upcase | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != ""))) }'
