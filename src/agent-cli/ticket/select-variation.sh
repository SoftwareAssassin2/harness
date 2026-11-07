#!/usr/bin/env bash
# Description: Go with one version of a ticket built several ways — ticket:select-variation <project> <ticket-key> <variation> <state> <selected> <to-state>.
set -euo pipefail

# In the project's active sprint (see sprint.bash), soft deletes every other
# variation of the ticket ("is-deleted": true and its deleted-timestamp) and
# records "selected-variation": { name, state, timestamp } on the ticket. When
# <selected> is at <state> too, the choice is the work done there: its change
# moves to <to-state> (see move_to in sprint.bash) and the ticket system
# follows the new step's paired-ticket-system-status (sync_paired_status).
# <variation> is the one asking, which
# must be at <state>; <selected> must be a variation not already deleted.
# Given a <to-state> of "", nothing moves and <state> is the asking
# variation's detailed step (sprint.bash update_ticket_at_detail) — for a
# human step inside a sub-engine run (ASS-67) that step, and control moves
# the run by the exit the choice meets. Fails, writing nothing, otherwise.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 6 ]] || { echo "usage: ticket:select-variation <project> <ticket-key> <variation> <state> <selected> <to-state>" >&2; exit 1; }

update=update_ticket move='move_to($to)'
[[ -n "$6" ]] || update=update_ticket_at_detail move='.'
"$update" ticket:select-variation "$1" "$2" "$3" "$4" --arg selected "$5" --arg to "$6" '
  if any(.variations[]; .name == $selected and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($selected) to select") end
  | .["selected-variation"] = { name: $selected, state: $state, timestamp: $at }
  | .variations |= map(
      if .name == $selected then
        if .["harness-status"].state == $state then '"$move"' else . end
      elif .["is-deleted"] then .
      else . + { "is-deleted": true, "deleted-timestamp": $at } end)'
[[ -z "$6" ]] || sync_paired_status ticket:select-variation "$1" "$2" "$5"
