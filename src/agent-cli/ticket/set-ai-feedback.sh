#!/usr/bin/env bash
# Description: Record why a ticket variation is where it is, its health on the dashboard — ticket:set-ai-feedback <project> <ticket-key> <variation> <short> <long>.
set -euo pipefail

# Sets the variation's ai-feedback-short and ai-feedback-long in the
# project's active sprint (see sprint.bash), replacing what was there. A move
# clears them (move_to), so control records what a ticket step's sub-engine
# run returned as its reason after the move (steps.js; ASS-75: Create VM's
# reason at Blocked for Human). Fails, writing nothing, on an empty <short>
# or an unknown variation.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 5 ]] || { echo "usage: ticket:set-ai-feedback <project> <ticket-key> <variation> <short> <long>" >&2; exit 1; }
[[ -n "${4//[[:space:]]/}" ]] || { echo "ticket:set-ai-feedback: the feedback is empty" >&2; exit 1; }
update_whole_ticket ticket:set-ai-feedback "$1" "$2" --arg name "$3" --arg short "$4" --arg long "$5" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | .variations |= map(if .name == $name and (.["is-deleted"] | not) then .["ai-feedback-short"] = $short | .["ai-feedback-long"] = $long else . end)'
