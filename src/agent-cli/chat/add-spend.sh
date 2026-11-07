#!/usr/bin/env bash
# Description: Record a chat-screen turn and what it cost against the chat's project — chat:add-spend [--estimate] <project> <chat-id> <cost-usd> [subscription|api].
set -euo pipefail

# Appends { timestamp (now, UTC), chat, billing, cost-usd } to turns in the
# project's data/projects/<project>/chat-spend.json, made when missing (ASS-271:
# the chat screen's turns, as collaboration:add-spend keeps a ticket chat's) —
# billing what the turn's session was billed to, left out when it never said,
# and the cost 0 on a subscription. With --estimate the turn was stopped
# mid-way (its chat deleted, the dashboard exiting) and the cost is its
# usage.json estimate, marked estimate: true. spend.js spendRecords counts
# them toward the project's API caps and Day and Sprint Spend; no ticket's
# spending limit sees them. Kept apart from chats.json, which forgets a deleted
# chat. PROJECTS_DIR overrides the projects folder, used by tests. Fails,
# writing nothing, on a bad or missing project, a bad chat id, a cost that is
# not a number from 0 or another billing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

usage="usage: chat:add-spend [--estimate] <project> <chat-id> <cost-usd> [subscription|api]"
estimate=false
[[ "${1:-}" == --estimate ]] && { estimate=true; shift; }
[[ $# -eq 3 || $# -eq 4 ]] || { echo "$usage" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "chat:add-spend: invalid project '$1'" >&2; exit 1; }
[[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "chat:add-spend: invalid chat '$2'" >&2; exit 1; }
[[ -d "$projects/$1" ]] || { echo "chat:add-spend: no project $1" >&2; exit 1; }
[[ "$3" =~ ^[0-9]+(\.[0-9]+)?([eE]-?[0-9]+)?$ ]] || { echo "chat:add-spend: the cost '$3' is not a number from 0" >&2; exit 1; }
billing="${4:-}"
[[ -z "$billing" || "$billing" == subscription || "$billing" == api ]] || { echo "chat:add-spend: the billing '$billing' is not subscription or api" >&2; exit 1; }
update_json --create "$projects/$1/chat-spend.json" --arg chat "$2" --argjson cost "$3" --arg billing "$billing" --argjson estimate "$estimate" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  .turns = (.turns // []) + [{ timestamp: $at, chat: $chat } + (if $billing == "" then {} else { billing: $billing } end)
    + { "cost-usd": (if $billing == "subscription" then 0 else $cost end) } + (if $estimate then { estimate: true } else {} end)]'
