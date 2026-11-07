#!/usr/bin/env bash
# Description: Record what a ticket chat was last told about its ticket — collaboration:set-briefed <project> <ticket-key> <snapshot-json>.
set -euo pipefail

# Writes briefed in the ticket's collaboration.json (see collaboration.bash):
# the snapshot its briefing or last catch-up was made from, which the next
# catch-up is worked out against. Fails, writing nothing, on a snapshot that
# is not a JSON object.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/collaboration.bash"

[[ $# -eq 3 ]] || { echo "usage: collaboration:set-briefed <project> <ticket-key> <snapshot-json>" >&2; exit 1; }
jq -e 'type == "object"' <<< "$3" >/dev/null 2>&1 || { echo "collaboration:set-briefed: the snapshot is not a JSON object" >&2; exit 1; }
update_collaboration collaboration:set-briefed "$1" "$2" --argjson briefed "$3" '.briefed = $briefed'
