#!/usr/bin/env bash
# Description: Whether a backlog ticket has story points — ticket:has-points <project> <ticket-key>.
set -euo pipefail

# Reads the ticket's "points" in the project's backlog.json (a
# refinement step Check the Points, ASS-144: a ticket with points needs no
# estimate). Prints { ticket, points } and exits 0 when it has points (not
# null), 1 otherwise. Fails (exit 1) on a ticket not in the backlog.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 2 && "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "usage: ticket:has-points <project> <ticket-key>" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
file="$projects/$1/backlog.json"
[[ -f "$file" ]] && lists "$file" "$key" || { echo "ticket:has-points: no $key in $1's backlog" >&2; exit 1; }
points="$(jq -c --arg k "$key" 'first(.tickets[] | select(.key | ascii_upcase == $k)) | .points // null' "$file")"
jq -nc --arg t "$key" --argjson p "$points" '{ ticket: $t, points: $p }'
[[ "$points" != null ]]
