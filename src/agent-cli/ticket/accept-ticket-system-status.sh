#!/usr/bin/env bash
# Description: Take the ticket system's status as right and move the ticket to the step it pairs with — ticket:accept-ticket-system-status <project> <ticket-key> <variation>.
set -euo pipefail

# Resolves a gap the ticket system's way: the variation goes to the first
# step (by sequence) of its state engine whose paired-ticket-system-status is
# the ticket's ticket-system-status, as ticket:change-state moves it (a state
# change recorded; the ticket system, matching already, left alone). Prints
# { "from", "to", "status", "changed" } — changed false, nothing written, when
# its step pairs with the status already. Fails, writing nothing, when the
# ticket has no status, no step pairs with it, or the project, ticket or
# variation is missing.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"

command=ticket:accept-ticket-system-status
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
file="$(sprint_file "$command" "$project")"
found="$(jq -c --arg key "$key" --arg name "$variation" '
  (first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase))) // null) as $t
  | ($t.variations // [] | map(select(.name == $name and (.["is-deleted"] | not))) | first) as $v
  | { state: ($v["harness-status"].state // ""), engine: ($v["harness-status"]["state-engine"] // ""), status: ($t["ticket-system-status"] // "") }' "$file")"
state="$(jq -r .state <<< "$found")" engine="$(jq -r .engine <<< "$found")" status="$(jq -r .status <<< "$found")"
[[ -n "$state" && -n "$engine" ]] || { echo "$command: no $key variation $variation in $project's active sprint" >&2; exit 1; }
[[ -n "$status" ]] || { echo "$command: $key has no ticket-system-status" >&2; exit 1; }
steps="$(engine_steps_of "$command" "$engine" "$project")"
current="$(jq -r --arg id "$state" 'first(.[] | select(.id == $id) | .["paired-ticket-system-status"] // empty) // empty' <<< "$steps")"
to="$(jq -r --arg s "$status" '[.[] | select(.["paired-ticket-system-status"] == $s)] | sort_by(.sequence) | first | .id // empty' <<< "$steps")"
[[ -n "$to" ]] || { echo "$command: no step of $engine pairs with \"$status\"" >&2; exit 1; }

changed=false
if [[ "$current" == "$status" ]]; then
  to="$state"
else
  "$here/change-state.sh" "$project" "$key" "$variation" "$state" "$to" >/dev/null
  changed=true
fi
jq -nc --arg from "$state" --arg to "$to" --arg status "$status" --argjson changed "$changed" '{ from: $from, to: $to, status: $status, changed: $changed }'
