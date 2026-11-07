#!/usr/bin/env bash
# Description: Set an agent's status — assignments:set-status <agent-name> <Starting|Running|Shutting Down|Ended|Killed>.
set -euo pipefail

# Writes status on the agent's assignment in assignments.json (at the repo
# root). Fails, writing nothing, on any other status or when the agent has no
# assignment.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# ASSIGNMENTS_FILE overrides the path, used by tests.
file="${ASSIGNMENTS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/assignments.json}"

usage() { echo "usage: assignments:set-status <agent-name> <Starting|Running|Shutting Down|Ended|Killed>" >&2; exit 1; }
[[ $# -eq 2 ]] || usage
case "$2" in Starting|Running|"Shutting Down"|Ended|Killed) ;; *) usage ;; esac

update_json "$file" --arg name "$1" --arg status "$2" '
  if any(.assignments[]; .["agent-name"] == $name) then . else error("assignments:set-status: no assignment for \($name)") end
  | .assignments |= map(if .["agent-name"] == $name then .status = $status else . end)'
