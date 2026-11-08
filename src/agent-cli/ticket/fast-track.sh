#!/usr/bin/env bash
# Description: Fast-track the fix ticket the blocked flow raised, joining it to the sprint — ticket:fast-track <project> <work-item> <ticket>.
set -euo pipefail

# ASS-306: the grouped blocked flow's Fast-Track the Fix step
# (engines/grouped-blocked, between Create the Fix Ticket and Wait on the Fix).
# The fix ticket Create the Fix Ticket raised, or the open one it found, is
# marked fast-track (off-board.sh ticket:mark-fast-track — the shared create
# prompt passes no --fast-track, other flows using it too) and joined to its
# home project's active sprint at committed (ticket:join-sprint, which carries
# the mark in), so control takes it ahead of everything (rank.js,
# fast-track.js) instead of leaving it in the backlog for grooming.
#
# Best-effort, always exiting 0: the blocked ticket must reach Wait on the Fix
# whatever happens. It no-ops, saying so on stderr, when
#   - <ticket> is <work-item>: no fix ticket was raised (facts.js falls back to
#     the blocked ticket's own key), so there is nothing to fast-track;
#   - <ticket> is not an off-board key (a project issue in the project's own
#     ticket system, ASS-83 Q2): fast-track is off-board only;
#   - <ticket> is in the active sprint already: it is left where it is;
#   - <ticket>'s off-board status is not Backlog (Committed, In Progress or
#     Done, outside the active sprint): AC2 scopes fast-tracking to a ticket
#     "still at Backlog" — a Done or otherwise-in-progress ticket is left as
#     it is, not reopened and pulled into the sprint fast-tracked.
# A failed join (no sprint tracking work, an open blocking question) is
# tolerated: the ticket stays off-board at Backlog with its mark — still
# waited on (ticket:wait-on, ticket:fix-landed read the backlog too) and
# flagged there for the operator (ASS-83 AC5, control's fast-track.js note).
# Prints one line of JSON: { ticket, marked, joined }.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"
agent="$here/../../../agent.sh"

command=ticket:fast-track
[[ $# -eq 3 ]] || { echo "usage: $command <project> <work-item> <ticket>" >&2; exit 1; }
project="$1" work_item="$(tr '[:lower:]' '[:upper:]' <<< "$2")" key="$(tr '[:lower:]' '[:upper:]' <<< "$3")"
skip() { echo "$command: $1" >&2; jq -nc --arg t "$key" '{ ticket: $t, marked: false, joined: false }'; exit 0; }

[[ "$key" != "$work_item" ]] || skip "$key is the blocked ticket itself: no fix ticket was raised"
home="$(home_project "$command" "$project" "$key")" || skip "$project has no project.json to read $key's home from"
prefix="$(off_board_prefix "$command" "$home")" || skip "$home has no project.json to read its off-board key prefix from"
[[ -n "$prefix" && "$key" == "$prefix-"* ]] || skip "$key is not an off-board ticket: fast-track is off-board only"

# in_sprint — the ticket is in its home project's active sprint already.
in_sprint() {
  local sprint
  sprint="$(sprint_file "$command" "$home" 2>/dev/null)" || return 1
  jq -e --arg key "$key" 'any((.features, .bugs, .spikes) // [] | .[]; .key | ascii_upcase == $key)' "$sprint" >/dev/null
}
! in_sprint || skip "$key is in $home's active sprint already: left where it is"

status="$(off_board_run "$command" ticket:get "$home" "$key" | jq -r .status)" || skip "could not read $key's off-board status"
[[ "$status" == "Backlog" ]] || skip "$key is $status, not Backlog: left as it is"

marked=false joined=false
if off_board_run "$command" ticket:mark-fast-track "$home" "$key" >/dev/null; then
  marked=true
  if "$agent" ticket:join-sprint "$home" "$key" committed >/dev/null; then
    joined=true
  else
    echo "$command: $key is marked fast-track but its join failed; it stays off-board at Backlog" >&2
  fi
else
  echo "$command: could not mark $key fast-track" >&2
fi
jq -nc --arg t "$key" --argjson marked "$marked" --argjson joined "$joined" '{ ticket: $t, marked: $marked, joined: $joined }'
