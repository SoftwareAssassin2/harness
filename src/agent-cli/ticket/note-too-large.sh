#!/usr/bin/env bash
# Description: Note an estimate above the project's scale on a ticket, leaving it without points — ticket:note-too-large <project> <ticket-key> <points>.
set -euo pipefail

# The family's refinement (ASS-264) at Note the Estimate: Estimate answered 8
# or 13, above the family's scale (1, 2, 3, 5), which ticket:set-points
# refuses. The ticket is left without points and the estimate kept on it for
# the operator at Too Large — Accept takes it to Ready as it is, Return sends
# it back to Groom. First the harness: on the ticket in backlog.json (or the
# active sprint, where it is listed instead) points null, points-set-at
# dropped, and "too-large-estimate": { points, noted-at }, which stays until
# an estimate on the scale (ticket:set-points) replaces it; ticket:sync keeps
# it, as it keeps every field not the ticket system's. Then an off-board
# ticket's own points, through `off-board.sh ticket:update-points <home>
# <KEY> none`, so an earlier estimate there is not synced back; a Jira
# ticket's are left alone (acli cannot edit them, see ticket:set-points).
# Prints { ticket, too-large-estimate }. Fails, writing nothing, on <points>
# not a whole number or on the scale, or a ticket listed nowhere.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
backlog_too=1
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"

command=ticket:note-too-large
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <points>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" points="$3"
[[ "$points" =~ ^[0-9]+$ ]] || { echo "$command: $points is not a whole number of points" >&2; exit 1; }
scale="$(story_point_scale "$command" "$project")"
! jq -e --argjson p "$points" 'index($p) != null' <<< "$scale" >/dev/null \
  || { echo "$command: $points is on $project's story-point scale ($(jq -r 'join(", ")' <<< "$scale")): ticket:set-points takes it" >&2; exit 1; }

update_whole_ticket "$command" "$project" "$key" --argjson points "$points" \
  '.points = null | del(.["points-set-at"]) | .["too-large-estimate"] = { points: $points, "noted-at": $at }'

home="$(home_project "$command" "$project" "$key")"
prefix="$(off_board_prefix "$command" "$home")"
if [[ -n "$prefix" && "$key" == "$prefix-"* ]]; then
  off_board_run "$command" ticket:update-points "$home" "$key" none >/dev/null
fi
jq -nc --arg t "$key" --argjson p "$points" '{ ticket: $t, "too-large-estimate": $p }'
