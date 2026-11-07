#!/usr/bin/env bash
# Description: Whether the operator kept an off-board ticket whole, never to be split — ticket:kept-whole <project> <ticket-key>.
set -euo pipefail

# ASS-252: the harness's backlog refinement's Check Kept Whole, between an
# estimate too large and Split. Reads the ticket (off-board.sh ticket:get, in
# its home project, see ticket-system.bash home_project): the operator's Keep
# whole at Awaiting Split Decision marked it kept-whole (off-board.sh
# ticket:keep-whole). Prints { ticket, kept-whole } and exits 0 when it is
# marked, 1 otherwise, so it is never split again. Fails (exit 1, saying why)
# on a ticket off-board.sh cannot read.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../ticket-system.bash"

command=ticket:kept-whole
[[ $# -eq 2 ]] || { echo "usage: $command <project> <ticket-key>" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
home="$(home_project "$command" "$1" "$key")"
got="$(off_board_run "$command" ticket:get "$home" "$key")"
kept="$(jq '.["kept-whole"] == true' <<< "$got")"
jq -nc --arg t "$(jq -r .key <<< "$got")" --argjson kept "$kept" '{ ticket: $t, "kept-whole": $kept }'
[[ "$kept" == true ]]
