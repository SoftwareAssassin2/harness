#!/usr/bin/env bash
# Description: Set one acceptance criterion's dev or testing status — ticket:set-ac-status <project> <ticket-key> <variation> <dev|testing> <criterion-number> <Passed|Failed|Incomplete>.
set -euo pipefail

# ASS-241: the criterion's dev-status (Generate Solution's Passed or Failed,
# Code Review's Failed on a rejection) or testing-status (the Test step's)
# in the project's active sprint (see sprint.bash: under its lock), the
# sprint screen's dot for it green, red or gray. Fails, writing nothing, on
# another kind or value, or when the ticket, variation or criterion is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

command=ticket:set-ac-status
[[ $# -eq 6 && "$4" =~ ^(dev|testing)$ && "$5" =~ ^[0-9]+$ && "$6" =~ ^(Passed|Failed|Incomplete)$ ]] \
  || { echo "usage: $command <project> <ticket-key> <variation> <dev|testing> <criterion-number> <Passed|Failed|Incomplete>" >&2; exit 1; }

update_whole_ticket "$command" "$1" "$2" --arg name "$3" --arg field "$4-status" --argjson n "$5" --arg value "$6" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | if any(.variations[] | select(.name == $name) | .["acceptance-criteria"] // [] | .[]; .["criteria-number"] == $n) then . else error("\($command): \($key) variation \($name) has no criterion \($n)") end
  | .variations |= map(if .name == $name then .["acceptance-criteria"] |= map(if .["criteria-number"] == $n then .[$field] = $value else . end) else . end)'
