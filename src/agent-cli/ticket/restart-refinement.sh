#!/usr/bin/env bash
# Description: Reset every live backlog ticket to its refinement engine's first step — ticket:restart-refinement <project>.
set -euo pipefail

# The one-off move of ASS-144 (Q5): run once per project after the merge,
# with control stopped and backlog.json backed up. In the project's
# backlog.json each variation not deleted, of a ticket neither soft deleted
# nor in the active sprint, goes to the first step by sequence of the
# project's backlog refinement engine (sprint.bash refinement_engine) — its
# harness-status { state: <first step>, state-engine: <engine> }, a change
# from where it was appended to its state-changes, with cause "migrated"
# (ASS-42: no step's exit made it; see sprint.bash) — and the ticket's
# last-refined cleared, so control grooms every one again at once. A
# variation already there is left as it is. Prints { project, engine, step,
# reset: [<ticket-key>…] }. Fails, writing nothing, on a project whose
# execution engine names no refinement engine, or without a backlog.json.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 1 ]] || { echo "usage: ticket:restart-refinement <project>" >&2; exit 1; }
project="$1"
engine="$(refinement_engine ticket:restart-refinement "$project")"
first="$(engine_steps_of ticket:restart-refinement "$engine" "$project" | jq -r 'sort_by(.sequence) | first | .id // empty')"
[[ -n "$first" ]] || { echo "ticket:restart-refinement: $engine has no steps" >&2; exit 1; }
file="$projects/$project/backlog.json"
[[ -f "$file" ]] || { echo "ticket:restart-refinement: $project has no backlog.json" >&2; exit 1; }
# Which tickets the sprint holds, read inside the project's tickets.lock and
# held to the write (ASS-179, sprint.bash lock_tickets): a ticket joining the
# sprint meanwhile is left alone.
lock_tickets ticket:restart-refinement "$project"
sprint="$(sprint_file ticket:restart-refinement "$project" 2>/dev/null)" || sprint=""
in_sprint='[]'
[[ -z "$sprint" || ! -f "$sprint" ]] || in_sprint="$(jq -c '[(.features, .bugs, .spikes) // [] | .[] | .key | ascii_downcase]' "$sprint")"

# The variations to reset: live, of a live backlog ticket, not yet at the first step of the engine.
FILTER='
  def due: (.["is-deleted"] | not) and (.["harness-status"] != { state: $first, "state-engine": $engine });
  def live_ticket: (.["is-deleted"] != true) and ((.key | ascii_downcase) as $k | $sprint | index([$k]) | not);'
reset="$(jq -c --arg first "$first" --arg engine "$engine" --argjson sprint "$in_sprint" "$FILTER"'
  [.tickets // [] | .[] | select(live_ticket and any(.variations // [] | .[]; due)) | .key]' "$file")"
update_json "$file" --arg first "$first" --arg engine "$engine" --argjson sprint "$in_sprint" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$FILTER"'
  .tickets |= map(if live_ticket and any(.variations // [] | .[]; due) then del(.["last-refined"]) | .variations |= map(if due then
      (.["harness-status"].state // null) as $from
      | .["harness-status"] = { state: $first, "state-engine": $engine }
      | .["state-changes"] = (.["state-changes"] // []) + [{ "state-engine": $engine, "from-state": $from, "to-state": $first, timestamp: $at, "agent-dispatch-log": [], "work-is-done": false, cause: "migrated" }]
    else . end) else . end)'
jq -nc --arg p "$project" --arg e "$engine" --arg s "$first" --argjson r "$reset" '{ project: $p, engine: $e, step: $s, reset: $r }'
