#!/usr/bin/env bash
# Description: Stamp when a backlog ticket was last refined — ticket:refined <project> <ticket-key> [<at>].
set -euo pipefail

# The ticket's "last-refined" in the project's backlog.json becomes <at>, or
# now (UTC): control stamps it as the groom step's turn completes (ASS-208)
# with when that turn started (ASS-213: what arrived during it still counts), and
# grooms it there again only once the ticket or its questions change after
# it, the operator decides on it, or 48 hours pass (ASS-144,
# src/control/plan.js refinementDue). Prints { ticket, last-refined }.
# Fails, writing nothing, on a ticket not in the backlog.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 2 || $# -eq 3 ]] || { echo "usage: ticket:refined <project> <ticket-key> [<at>]" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
file="$projects/$1/backlog.json"
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$file" ]] && jq -e --arg k "$key" 'any(.tickets[]?; .key | ascii_upcase == $k)' "$file" >/dev/null \
  || { echo "ticket:refined: no $key in $1's backlog" >&2; exit 1; }
at="${3:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
update_json "$file" --arg k "$key" --arg at "$at" '.tickets |= map(if (.key | ascii_upcase) == $k then .["last-refined"] = $at else . end)'
jq -nc --arg t "$key" --arg at "$at" '{ ticket: $t, "last-refined": $at }'
