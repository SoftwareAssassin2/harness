#!/usr/bin/env bash
# Description: Record a ticket chat's Claude session, to resume it — collaboration:set-session <project> <ticket-key> <session-id>.
set -euo pipefail

# Writes session-id in the ticket's collaboration.json (see
# collaboration.bash): the session `claude --resume` continues once its
# process has ended, for the ticket's whole life.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/collaboration.bash"

[[ $# -eq 3 ]] || { echo "usage: collaboration:set-session <project> <ticket-key> <session-id>" >&2; exit 1; }
update_collaboration collaboration:set-session "$1" "$2" --arg session "$3" '.["session-id"] = $session'
