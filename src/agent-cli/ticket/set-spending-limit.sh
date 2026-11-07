#!/usr/bin/env bash
# Description: Set or clear a ticket's own spending limit — ticket:set-spending-limit <project> <ticket-key> <usd|->.
set -euo pipefail

# ASS-191: writes "max-spend-usd": <usd> on the ticket in the project's active
# sprint, or its backlog.json when the sprint does not list it (sprint.bash
# backlog_too); "-" removes it. It wins over project.json's and harness.json's
# max-spend-per-ticket-usd (src/control/spend.js): control dispatches no agent
# for a ticket whose agents have cost that much, and takes its variations to
# Blocked for Human; raised, the ticket handed back works on. Fails, writing
# nothing, on an amount that is not dollars (digits, optional cents) or an
# unknown ticket.
backlog_too=1
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 3 && ( "$3" == - || "$3" =~ ^[0-9]+(\.[0-9]+)?$ ) ]] || { echo "usage: ticket:set-spending-limit <project> <ticket-key> <usd|->" >&2; exit 1; }

update_whole_ticket ticket:set-spending-limit "$1" "$2" --arg usd "$3" '
  if $usd == "-" then del(.["max-spend-usd"]) else .["max-spend-usd"] = ($usd | tonumber) end'
