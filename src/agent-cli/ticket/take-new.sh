#!/usr/bin/env bash
# Description: Take a sprint ticket's pending requirements change as its description — ticket:take-new <project> <ticket-key>.
set -euo pipefail

# The operator's Take new (ASS-78 AC4) on the ticket's
# pending-requirements-change, which ticket:sync holds (ASS-77): its
# description becomes the ticket's, the variations the change paused (its
# paused-variations) are un-paused and the change is cleared (with any
# dismissed-requirements-change, see ticket:keep-current) — one locked write
# in the project's active sprint (see sprint.bash). Then each live variation
# at a step flagged "recheck-on-requirements-change" starts the
# requirements-changed workflow (sprint.bash recheck_requirements, ASS-79);
# one at an unflagged step just takes the new description. A start that fails
# is reported on stderr and the description stands. Fails, writing
# nothing, on an unknown ticket or one with no pending change.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 2 ]] || { echo "usage: ticket:take-new <project> <ticket-key>" >&2; exit 1; }

update_whole_ticket ticket:take-new "$1" "$2" '
  if .["pending-requirements-change"] == null then error("\($command): \($key) has no pending requirements change") else . end
  | .["pending-requirements-change"] as $change
  | .description = $change.description
  | .variations |= (if . == null then . else map(if .name | IN($change["paused-variations"][]) then .["is-paused"] = false else . end) end)
  | del(.["pending-requirements-change"], .["dismissed-requirements-change"])'

recheck_requirements ticket:take-new "$1" "$2"
