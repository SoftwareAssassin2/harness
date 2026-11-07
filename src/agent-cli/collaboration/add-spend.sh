#!/usr/bin/env bash
# Description: Record a ticket chat's turn and what it cost — collaboration:add-spend <project> <ticket-key> <cost-usd> [subscription|api].
set -euo pipefail

# Appends { timestamp (now, UTC), billing, cost-usd } to turns in the ticket's
# collaboration.json (see collaboration.bash) — ASS-216: billing what the
# turn's session was billed to, left out when it never said, and the cost 0 on
# a subscription — whose sum is the ticket's chat spend. Fails, writing
# nothing, on a cost that is not a number from 0 or another billing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/collaboration.bash"

usage="usage: collaboration:add-spend <project> <ticket-key> <cost-usd> [subscription|api]"
[[ $# -eq 3 || $# -eq 4 ]] || { echo "$usage" >&2; exit 1; }
[[ "$3" =~ ^[0-9]+(\.[0-9]+)?([eE]-?[0-9]+)?$ ]] || { echo "collaboration:add-spend: the cost '$3' is not a number from 0" >&2; exit 1; }
billing="${4:-}"
[[ -z "$billing" || "$billing" == subscription || "$billing" == api ]] || { echo "collaboration:add-spend: the billing '$billing' is not subscription or api" >&2; exit 1; }
update_collaboration collaboration:add-spend "$1" "$2" --argjson cost "$3" --arg billing "$billing" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  .turns += [{ timestamp: $at } + (if $billing == "" then {} else { billing: $billing } end) + { "cost-usd": (if $billing == "subscription" then 0 else $cost end) }]'
