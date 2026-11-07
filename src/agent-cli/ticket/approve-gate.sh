#!/usr/bin/env bash
# Description: Approve a ticket variation's human gate: make the move control held there — ticket:approve-gate <project> <ticket-key> <variation> [<state>].
set -euo pipefail

# The variation's latest state change carries the move control held at the
# gate ("pending-move", see ticket:mark-work-done; ASS-132): where the step's
# exit was going and why, and for a step inside a run, the run and the step's
# own structured-output (ASS-236; one held before it, the run's already merged).
# That move is made: the run's with transient-state-engine:change-state <run>
# <from> <to> <output>, the output merged over the run's as control merges it,
# else the variation's with ticket:change-state <from> <to>
# [<start-sub-engine-at>] (the ticket system following). Given <state> (its
# top-level state, as the ticket screen passes it), the variation must still
# be there. Fails, moving nothing, when the variation is elsewhere or has no
# pending move (no gate waiting, or one marked before ASS-132).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"

[[ $# -eq 3 || $# -eq 4 ]] || { echo "usage: ticket:approve-gate <project> <ticket-key> <variation> [<state>]" >&2; exit 1; }
state="$(variation_status ticket:approve-gate "$1" "$2" "$3" | head -n 1 | cut -f 2)"
[[ $# -eq 3 || "$4" == "$state" ]] || { echo "ticket:approve-gate: $2.$3 is not at $4" >&2; exit 1; }
pending="$(jq -c --arg key "$2" --arg name "$3" '
  first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
  | first(.variations[] | select(.name == $name and (.["is-deleted"] | not)))
  | .["state-changes"][-1] // {} | select(.["work-is-done"] == true) | .["pending-move"] // empty' "$(sprint_file ticket:approve-gate "$1")")"
[[ -n "$pending" ]] || { echo "ticket:approve-gate: $2.$3 has no move waiting at a gate" >&2; exit 1; }
field() { jq -r --arg f "$1" '.[$f] // empty' <<< "$pending"; }

if [[ -n "$(field run)" ]]; then
  output="$(jq -c '.output // empty' <<< "$pending")"
  [[ -z "$output" ]] || output="$(jq -c --arg id "$(field run)" --argjson output "$output" '
    first(.["transient-state-engines"][]? | select(.id == $id)) | .["structured-output"] | (if type == "object" then . else {} end) + $output' "${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}")"
  "$here/../transient-state-engine/change-state.sh" "$(field run)" "$(field from)" "$(field to)" ${output:+"$output"}
else
  start="$(field start-sub-engine-at)"
  "$here/change-state.sh" "$1" "$2" "$3" "$(field from)" "$(field to)" ${start:+"$start"}
fi
