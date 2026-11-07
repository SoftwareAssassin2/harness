#!/usr/bin/env bash
# Description: Write a ticket's story points to the harness and its ticket system — ticket:set-points <project> <ticket-key> <points>.
set -euo pipefail

# The estimate's one write (ASS-152), whatever the ticket system. <points>
# must be on the project's scale (project:story-point-scale). First the
# harness: the ticket's points in backlog.json (or the active sprint, where
# it is listed instead), with points-set-at, the estimate pending until the
# ticket system shows it (ticket:sync keeps it over a null meanwhile). Then
# the ticket system: an off-board ticket (its key carries the off-board key
# prefix, see home_project in ticket-system.bash) through `off-board.sh
# ticket:update-points <home> <KEY> <points>`; any other, a Jira ticket
# among them, the harness alone: acli cannot edit a custom field (`json:
# unknown field "additionalAttributes"`, acli 1.3.39), so a Jira estimate
# stays pending in the harness until Jira shows points of its own
# (operator, 2026-10-26). An estimate on the scale drops the ticket's
# too-large-estimate (ASS-264, ticket:note-too-large). Prints { ticket, points }. Fails,
# writing nothing, on a value off the scale or a ticket listed nowhere; fails,
# naming the ticket system and quoting its error, when it refuses the write —
# the harness then keeping the estimate, pending.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
backlog_too=1
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"

command=ticket:set-points
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <points>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" points="$3"
scale="$(story_point_scale "$command" "$project")"
[[ "$points" =~ ^[0-9]+$ ]] && jq -e --argjson p "$points" 'index($p) != null' <<< "$scale" >/dev/null \
  || { echo "$command: $points is not on $project's story-point scale: $(jq -r 'join(", ")' <<< "$scale")" >&2; exit 1; }

update_whole_ticket "$command" "$project" "$key" --argjson points "$points" '.points = $points | .["points-set-at"] = $at | del(.["too-large-estimate"])'

home="$(home_project "$command" "$project" "$key")"
prefix="$(off_board_prefix "$command" "$home")"
err="$(mktemp)"
trap 'rm -f "$err"' EXIT
refused() { echo "$command: $1 refused $key's story points ($points); the harness keeps them, pending: $(cat "$err")" >&2; exit 1; }
if [[ -n "$prefix" && "$key" == "$prefix-"* ]]; then
  off_board_run "$command" ticket:update-points "$home" "$key" "$points" >/dev/null 2>"$err" || refused off-board
fi
jq -nc --arg t "$key" --argjson p "$points" '{ ticket: $t, points: $p }'
