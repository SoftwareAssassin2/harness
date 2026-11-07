#!/usr/bin/env bash
# Description: Record the problems a ticket chat last raised with the operator — collaboration:set-raised <project> <ticket-key> <reasons-json>.
set -euo pipefail

# Writes raised in the ticket's collaboration.json (see collaboration.bash):
# the reasons something is off with the ticket that its chat was last asked to
# explain (ASS-36), so they are raised again only once they change; [] once
# the ticket is healthy, so a repeat problem is raised again. Fails, writing
# nothing, on reasons that are not a JSON array of strings.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/collaboration.bash"

[[ $# -eq 3 ]] || { echo "usage: collaboration:set-raised <project> <ticket-key> <reasons-json>" >&2; exit 1; }
jq -e 'type == "array" and all(type == "string")' <<< "$3" >/dev/null 2>&1 || { echo "collaboration:set-raised: the reasons are not a JSON array of strings" >&2; exit 1; }
update_collaboration collaboration:set-raised "$1" "$2" --argjson raised "$3" '.raised = $raised'
