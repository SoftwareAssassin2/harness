#!/usr/bin/env bash
# Description: Record the Anthropic API organization's month-to-date spend — harness:set-api-cost <YYYY-MM> <usd>.
set -euo pipefail

# Writes { month, usd, as-of } to data/api-cost.json (API_COST_FILE
# overrides it, used by tests) — live data, like a project's
# claude-usage.json: what control last read of the API organization's spend
# this UTC month from the Cost Admin API, about hourly (ASS-153,
# src/control/api-cost.js checkApiCost), `usd` in dollars, `as-of` now. The
# dashboard shows it in the models box. A plain overwrite: keeping the last
# value when a read fails is control's to do, by not calling this. Fails,
# writing nothing, unless the month is YYYY-MM and the amount a number of
# dollars (0 or more).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
file="${API_COST_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/api-cost.json}"

[[ $# -eq 2 ]] || { echo "usage: harness:set-api-cost <YYYY-MM> <usd>" >&2; exit 1; }
[[ "$1" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]] || { echo "harness:set-api-cost: the month must be YYYY-MM, got '$1'" >&2; exit 1; }
[[ "$2" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "harness:set-api-cost: the amount must be a number of dollars, got '$2'" >&2; exit 1; }

update_json --create "$file" --arg month "$1" --argjson usd "$2" '{ month: $month, usd: $usd, "as-of": (now | floor | todate) }'
