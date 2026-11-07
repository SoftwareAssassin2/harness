#!/usr/bin/env bash
# Description: Mark a ticket variation's work at its state done, to wait at a human gate — ticket:mark-work-done <project> <ticket-key> <variation> <state> [<pending-move-json>].
set -euo pipefail

# On the variation in the project's active sprint (see sprint.bash): its
# latest state change, the one into <state>, gets "work-is-done": true and
# nothing moves — control calls it when a step's exit holds but the variation
# gates leaving that state (gate-when-leaving-state), so the dashboard offers
# the human the move. Given <pending-move-json> (an object: the move control
# held, { from, to, reason } and, for a run's step, { run, output }; ASS-132),
# the change keeps it as "pending-move", which ticket:approve-gate makes.
# Marking again changes nothing but the pending move given. Fails, writing
# nothing, unless the variation is at <state> and its latest change is into
# it, or on a pending move that is not an object.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 4 || $# -eq 5 ]] || { echo "usage: ticket:mark-work-done <project> <ticket-key> <variation> <state> [<pending-move-json>]" >&2; exit 1; }
pending="${5:-null}"
if [[ $# -eq 5 ]]; then
  jq -e 'type == "object"' <<< "$pending" > /dev/null 2>&1 || { echo "ticket:mark-work-done: the pending move must be a JSON object" >&2; exit 1; }
fi

update_variation ticket:mark-work-done "$1" "$2" "$3" "$4" --argjson pending "$pending" '
  if (.["state-changes"] // [] | length > 0 and .[-1]["to-state"] == $state) then . else error("\($command): \($key).\($name) has no change into \($state) to mark") end
  | .["state-changes"][-1]["work-is-done"] = true
  | if $pending == null then . else .["state-changes"][-1]["pending-move"] = $pending end'
