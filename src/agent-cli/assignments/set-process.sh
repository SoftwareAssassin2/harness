#!/usr/bin/env bash
# Description: Record an agent's running process — assignments:set-process <agent-name> <pid> <session-id|->.
set -euo pipefail

# Writes process-id, session-id (null for -), status "Running" and a
# last-heartbeat of now (UTC) on the agent's assignment in data/assignments.json.
# Fails, writing nothing, when the agent has no assignment or
# the pid is not a whole number.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# ASSIGNMENTS_FILE overrides the path, used by tests.
file="${ASSIGNMENTS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/assignments.json}"

[[ $# -eq 3 ]] || { echo "usage: assignments:set-process <agent-name> <pid> <session-id|->" >&2; exit 1; }
[[ "$2" =~ ^[0-9]+$ ]] || { echo "assignments:set-process: pid must be a whole number, got '$2'" >&2; exit 1; }

update_json "$file" --arg name "$1" --argjson pid "$2" --arg session "$3" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  if any(.assignments[]; .["agent-name"] == $name) then . else error("assignments:set-process: no assignment for \($name)") end
  | .assignments |= map(if .["agent-name"] == $name then
      .["process-id"] = $pid | .["session-id"] = (if $session == "-" then null else $session end) | .status = "Running" | .["last-heartbeat"] = $at
    else . end)'
