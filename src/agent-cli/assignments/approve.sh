#!/usr/bin/env bash
# Description: Approve the final result of your assignment — assignments:approve <agent-name>.
set -euo pipefail

# Writes approvals[<agent-name>] = now (UTC) on every record sharing the
# agent's assignment-id in assignments.json (in data/), so the
# pen-holder's record shows every approval; the work on a step is complete when
# the pen-holder's turn has ended and every paired agent has approved. Fails,
# writing nothing, when the agent has no assignment.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# ASSIGNMENTS_FILE overrides the path, used by tests.
file="${ASSIGNMENTS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/assignments.json}"

[[ $# -eq 1 ]] || { echo "usage: assignments:approve <agent-name>" >&2; exit 1; }

update_json "$file" --arg name "$1" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  (first(.assignments[] | select(.["agent-name"] == $name)) // null) as $a
  | if $a == null then error("assignments:approve: no assignment for \($name)") else . end
  | .assignments |= map(
      if .["agent-name"] == $name or ($a["assignment-id"] != null and .["assignment-id"] == $a["assignment-id"])
      then .approvals[$name] = $at else . end)'
