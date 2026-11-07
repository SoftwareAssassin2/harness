#!/usr/bin/env bash
# Description: Pause a variation to free a seat for a fast-tracked ticket, or resume one so paused — ticket:set-preempted <project> <ticket-key> <variation> <fast-track-key|-> [<seat>].
set -euo pipefail

# Control's pre-emption (ASS-83, src/control/fast-track.js): with a
# fast-tracked ticket's key, the variation in the project's active sprint is
# paused (is-paused true, as ticket:set-paused pauses it) and marked
# paused-for-fast-track: <that key, upper-cased>, so control — and the TUI,
# saying why — can tell its pause from the operator's — and, given <seat>
# (planning, progress or agents: the pool it gave up a seat in),
# preempted-seat: <seat>. With -, a variation
# carrying that mark is resumed (is-paused false, both marks gone); one paused
# any other way, or not at all, is left as it is. ticket:set-paused clears the
# mark: the pause becomes the operator's. Fails, writing nothing, on an
# unknown ticket or variation, or bad arguments.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ ( $# -eq 4 || ( $# -eq 5 && "$4" != - && "$5" =~ ^(planning|progress|agents)$ ) ) && -n "$4" ]] || { echo "usage: ticket:set-preempted <project> <ticket-key> <variation> <fast-track-key|-> [planning|progress|agents]" >&2; exit 1; }
for_key="$(tr '[:lower:]' '[:upper:]' <<< "$4")"

update_whole_ticket ticket:set-preempted "$1" "$2" --arg name "$3" --arg for "$for_key" --arg seat "${5:-}" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | .variations |= map(if .name != $name then .
      elif $for != "-" then .["is-paused"] = true | .["paused-for-fast-track"] = $for | (if $seat == "" then del(.["preempted-seat"]) else .["preempted-seat"] = $seat end)
      elif .["paused-for-fast-track"] != null then .["is-paused"] = false | del(.["paused-for-fast-track"], .["preempted-seat"])
      else . end)'
