#!/usr/bin/env bash
# Description: Print a ticket variation's merge requests, planned and created — ticket:merge-request-plan <project> <ticket-key> <variation>.
set -euo pipefail

# The variation's merge-request in the active sprint, as JSON (see
# ticket:set-merge-request-plan): what Write Execution Plan reads before it
# replans. Fails when the ticket or variation is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:merge-request-plan <project> <ticket-key> <variation>" >&2; exit 1; }
variation_field '.["merge-request"] // []' ticket:merge-request-plan "$1" "$(upper "$2")" "$3"
