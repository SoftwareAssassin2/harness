#!/usr/bin/env bash
# Description: Move a state engine run to its next step — transient-state-engine:change-state <id> <from-state> <to-state> [<structured-output-json>].
set -euo pipefail

# On the run in assignments.json's transient-state-engines (in data/):
# state becomes <to-state>, the move appended to its state-changes ({
# from-state, to-state, timestamp }: the history its steps' visits are
# counted over, the run's own — a new run starts none), last-heartbeat now
# (UTC), structured-output the
# JSON given (the last prompt's output; kept as it was when none is given), and
# is-done true when the engine's step <to-state> has is-done true (see
# engine.bash). When the run works for a ticket step — its parent is one ({
# work-item, variation }, no trigger), or its parent run's is, walked up as
# far as it goes (ASS-67) — the move is recorded on the variation first, as
# ticket:change-sub-state records it, beneath the states its parent runs are
# under: the deepest level is kept current wherever the run sits (MOVED_BY_RUN
# set, so ticket:change-sub-state records it rather than handing it back
# here); the run written second, a rerun after a stop between the two finds
# the variation at <to> already and moves the run alone (ASS-178). Fails, writing nothing, unless the run is at <from-state>, the
# step exists and the output is JSON. The run's engine is its project's own
# first (engine.bash, ASS-276). ASSIGNMENTS_FILE, ENGINES_DIR and PROJECTS_DIR
# override the paths, used by tests.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../json-file.bash"
source "$here/../engine.bash"
source "$here/../runs.bash"
file="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"

[[ $# -eq 3 || $# -eq 4 ]] || { echo "usage: transient-state-engine:change-state <id> <from-state> <to-state> [<structured-output-json>]" >&2; exit 1; }
id="$1" from="$2" to="$3"
record="$(jq -c --arg id "$id" 'first(.["transient-state-engines"][]? | select(.id == $id)) // empty' "$file")"
[[ -n "$record" ]] || { echo "transient-state-engine:change-state: no transient state engine $id" >&2; exit 1; }
[[ "$(jq -r .state <<< "$record")" == "$from" ]] || { echo "transient-state-engine:change-state: $id is not at $from" >&2; exit 1; }
engine="$(jq -r '.["state-engine"]' <<< "$record")"
step="$(engine_steps_of transient-state-engine:change-state "$engine" "$(jq -r '.project // empty' <<< "$record")" | jq -c --arg to "$to" 'first(.[] | select(.id == $to)) // empty')"
[[ -n "$step" ]] || { echo "transient-state-engine:change-state: $engine has no step $to" >&2; exit 1; }
set_output=false output=null
if [[ $# -eq 4 ]]; then
  jq -e . <<< "$4" > /dev/null 2>&1 || { echo "transient-state-engine:change-state: the structured output is not JSON" >&2; exit 1; }
  set_output=true output="$4"
fi

# The project, work-item and variation of the ticket step at the top of the
# run's parents, then the states beneath it, one per line; nothing for a run
# that is not a ticket step's (a trigger's, or none's).
ticket_path="$(jq -r --arg id "$id" "$ticket_path_def"'
  .["transient-state-engines"] as $all
  | first($all[] | select(.id == $id)) | ticket_path($all) | (.[0:3] + .[4:])[]' "$file")"
if [[ -n "$ticket_path" ]]; then
  at=(); while IFS= read -r line; do at+=("$line"); done <<< "$ticket_path"
  # A stop between the variation's move and the run's (below) leaves the
  # variation at <to> already, its level's "<engine>\t<state>" line the
  # (#at - 1)th of variation_status: a rerun moves the run alone (ASS-178).
  moved="$( (source "$here/../sprint.bash"; variation_status transient-state-engine:change-state "${at[0]}" "${at[1]}" "${at[2]}") 2>/dev/null | sed -n "$(( ${#at[@]} - 1 ))p")" || true
  if [[ "$from" == "$to" || "$moved" != "$engine"$'\t'"$to" ]]; then
    MOVED_BY_RUN=1 "$here/../ticket/change-sub-state.sh" "${at[0]}" "${at[1]}" "${at[2]}" "$engine" "$from" "$to" "${at[@]:3}"
  fi
fi

# ASS-388: a MOVE_CAUSE in the environment (control's, moves.js causeEnv) is merged into the run's change
# too, as ticket:change-sub-state merges it into the variation's: the run's steps' visits are counted over
# its own changes, and a cause such as no-op-round must be there to be read (engine.js).
update_json "$file" --arg id "$id" --arg from "$from" --arg to "$to" --argjson done "$(jq '.["is-done"] == true' <<< "$step")" \
  --argjson set_output "$set_output" --argjson output "$output" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson cause "${MOVE_CAUSE:-"{}"}" '
  .["transient-state-engines"] |= map(if .id == $id then
      if .state != $from then error("transient-state-engine:change-state: \($id) is not at \($from)") else . end
      | .state = $to | .["last-heartbeat"] = $at | .["is-done"] = $done
      | .["state-changes"] = (.["state-changes"] // []) + [{ "from-state": $from, "to-state": $to, timestamp: $at } + $cause]
      | if $set_output then .["structured-output"] = $output else . end
    else . end)'
