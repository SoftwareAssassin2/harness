#!/usr/bin/env bash
# Description: Pause or unpause a ticket variation — ticket:set-paused <project> <ticket-key> <variation> <true|false> [<agent-name>].
set -euo pipefail

# Writes the variation's "is-paused" in the project's active sprint (see
# sprint.bash), whatever state it is in: true holds it where it is, false
# lets it go on. With <agent-name>, an AI's pause: allowed only from a health
# check, and only on its own project's tickets unless that health check is
# the harness project's (see pause.bash); without one, the human's or a
# script's. Either way the pause is no longer control's pre-emption (its
# paused-for-fast-track mark goes, ticket:set-preempted, ASS-83): control
# leaves it to whoever set it. Nor is it any longer the reassignment hold's
# (ASS-345, ticket:sync): the variation leaves its ticket's
# reassigned.paused-variations, so the ticket coming back to the operator
# leaves this pause, or its lifting, alone; the reassigned mark stays. Fails, writing nothing, on anything but true or false, an
# unknown ticket or variation, or a pause the named agent may not take.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../pause.bash"

[[ ( $# -eq 4 || $# -eq 5 ) && ( "$4" == true || "$4" == false ) ]] || { echo "usage: ticket:set-paused <project> <ticket-key> <variation> <true|false> [<agent-name>]" >&2; exit 1; }
[[ $# -eq 4 ]] || may_pause ticket:set-paused "$5" "$1" >/dev/null

update_whole_ticket ticket:set-paused "$1" "$2" --arg name "$3" --argjson paused "$4" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | .variations |= map(if .name == $name then .["is-paused"] = $paused | del(.["paused-for-fast-track"], .["preempted-seat"]) else . end)
  | if .reassigned == null then . else .reassigned["paused-variations"] |= map(select(. != $name)) end'
