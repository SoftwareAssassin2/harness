#!/usr/bin/env bash
# Description: Release one pause — assignments:start <all|project> human | ai; the agents run once none holds.
set -euo pipefail

# Removes that scope's kind from data/assignments.json `pauses`
# (see assignments:pause), leaving the rest: `status` stays "Paused" while any
# pause holds, else becomes "Running". Releasing a pause not holding changes
# nothing. Fails, writing nothing, on an unknown scope or kind.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../pause.bash"

[[ $# -eq 2 && ( "$2" == human || "$2" == ai ) ]] || { echo "usage: assignments:start <all|project> human | ai" >&2; exit 1; }
pause_scope assignments:start "$1"
update_json "$pause_assignments" --arg scope "$1" --arg kind "$2" '
  .pauses = ((.pauses // {}) | if .[$scope] then .[$scope] |= del(.[$kind]) else . end | with_entries(select(.value | length > 0)))
  | .status = (if (.pauses | length) > 0 then "Paused" else "Running" end)'
