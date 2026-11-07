#!/usr/bin/env bash
# Description: Set an off-board ticket's status — ticket:update-status <project> <key> <status>.
set -euo pipefail

# Rewrites the status line of the ticket's front matter (see ticket.bash),
# adding one when it has none, and stamps updated. The status is one of the
# four off-board statuses: Backlog, Committed, In Progress, Done (the
# harness-development engine pairs each step with one). Prints
# { key, status }. Fails, writing nothing, on any other status, when the
# project is missing or has no off-board work source, the ticket is missing,
# or its file is malformed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:update-status <project> <key> <status>" >&2; exit 1; }
case "$3" in Backlog|Committed|"In Progress"|Done) ;; *) echo "ticket:update-status: unknown status '$3'; one of Backlog, Committed, In Progress, Done" >&2; exit 1 ;; esac
file="$(ticket_file ticket:update-status "$1" "$2")"

rewrite_ticket ticket:update-status "$file" --arg status "$3" '
  close as $c | (.[:$c] | index_of(startswith("status:"))) as $i
  | if $i < 0 then .[:$c] + ["status: " + $status] + .[$c:] else .[$i] = "status: " + $status end'
jq -n --arg key "$(ticket_key "$file")" --arg status "$3" '{ key: $key, status: $status }'
