#!/usr/bin/env bash
# Description: Record the fix ticket a ticket variation waits on, or - to stop waiting — ticket:wait-on <project> <ticket-key> <variation> <fix-ticket-key|->.
set -euo pipefail

# Writes the variation's "waits-on": { project, ticket } in the project's
# active sprint — the fix ticket and the project its key names (key_project,
# see ticket-system.bash: a harness ticket's prefix names the harness
# project, a Jira key its board's) — for ticket:fix-landed to check. The one
# dependency a product ticket has on the harness. Prints { ticket, variation,
# waits-on }. Fails, writing nothing, on an unknown ticket or variation; and,
# printing why as { ai-feedback-short, ai-feedback-long } for Blocked to
# hand the ticket to a human with (ASS-107 AC7), on a fix key that is the
# ticket's own — no fix ticket was raised: Blocked's run gives a ticket
# step's command its own work item when it has no fix key — (exit 3) or one
# no project claims (exit 1). A fix key of - removes the variation's
# waits-on, for a wait the operator abandons (ASS-253), printing waits-on null.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"

[[ $# -eq 4 ]] || { echo "usage: ticket:wait-on <project> <ticket-key> <variation> <fix-ticket-key|->" >&2; exit 1; }
fix="$(tr '[:lower:]' '[:upper:]' <<< "$4")"
has='if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end'
[[ "$fix" != - ]] || {
  update_whole_ticket ticket:wait-on "$1" "$2" --arg name "$3" "$has"' | .variations |= map(if .name == $name then del(.["waits-on"]) else . end)'
  jq -nc --arg t "$(tr '[:lower:]' '[:upper:]' <<< "$2")" --arg v "$3" '{ ticket: $t, variation: $v, "waits-on": null }'
  exit 0; }
why() { jq -nc --arg s "$1" --arg l "$2" '{ "ai-feedback-short": $s, "ai-feedback-long": $l }'; echo "ticket:wait-on: $2" >&2; }
[[ "$fix" != "$(tr '[:lower:]' '[:upper:]' <<< "$2")" ]] || { why "No fix ticket was raised" "No fix ticket was raised for $fix's block (the analysis did not hold, or creating it failed); it does not resume as if fixed."; exit 3; }
home="$(key_project ticket:wait-on "$fix")"
[[ -n "$home" ]] || { why "The fix ticket cannot be waited on" "$fix names no project, so $2 cannot wait on it."; exit 1; }
waits="$(jq -nc --arg p "$home" --arg t "$fix" '{ project: $p, ticket: $t }')"
update_whole_ticket ticket:wait-on "$1" "$2" --arg name "$3" --argjson waits "$waits" "$has"' | .variations |= map(if .name == $name then .["waits-on"] = $waits else . end)'
jq -nc --arg t "$(tr '[:lower:]' '[:upper:]' <<< "$2")" --arg v "$3" --argjson w "$waits" '{ ticket: $t, variation: $v, "waits-on": $w }'
