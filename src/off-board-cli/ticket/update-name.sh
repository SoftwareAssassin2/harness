#!/usr/bin/env bash
# Description: Rename an off-board ticket — ticket:update-name <project> <key> <title>.
set -euo pipefail

# Rewrites the H1 title line of the ticket's file (see ticket.bash) and
# stamps updated. Prints { key, title }. Fails, writing nothing, when the
# project is missing or has no off-board work source, the ticket is missing,
# or its file is malformed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:update-name <project> <key> <title>" >&2; exit 1; }
file="$(ticket_file ticket:update-name "$1" "$2")"

rewrite_ticket ticket:update-name "$file" --arg title "$3" '.[h1] = "# " + $title'
jq -n --arg key "$(ticket_key "$file")" --arg title "$3" '{ key: $key, title: $title }'
