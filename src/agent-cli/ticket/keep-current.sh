#!/usr/bin/env bash
# Description: Keep a sprint ticket's current description over its pending requirements change — ticket:keep-current <project> <ticket-key>.
set -euo pipefail

# The operator's Keep current (ASS-78 AC3) on the ticket's
# pending-requirements-change, which ticket:sync holds (ASS-77): the
# description stays, the variations the change paused (its
# paused-variations, not those paused otherwise) are un-paused and the change
# is cleared, its description kept as the ticket's
# dismissed-requirements-change so that ticket:sync holds nothing for it
# again, only for a description changed once more. One locked write in the project's active sprint (see
# sprint.bash). Fails, writing nothing, on an unknown ticket or one with no
# pending change.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 2 ]] || { echo "usage: ticket:keep-current <project> <ticket-key>" >&2; exit 1; }

update_whole_ticket ticket:keep-current "$1" "$2" '
  if .["pending-requirements-change"] == null then error("\($command): \($key) has no pending requirements change") else . end
  | .["pending-requirements-change"]["paused-variations"] as $paused
  | .variations |= (if . == null then . else map(if .name | IN($paused[]) then .["is-paused"] = false else . end) end)
  | .["dismissed-requirements-change"] = .["pending-requirements-change"].description
  | del(.["pending-requirements-change"])'
