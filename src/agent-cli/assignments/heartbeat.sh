#!/usr/bin/env bash
# Description: Note an agent is alive — assignments:heartbeat <agent-name>.
set -euo pipefail

# Writes a last-heartbeat of now (UTC) on the agent's assignment in
# assignments.json (in data/). Fails, writing nothing, when the agent
# has no assignment.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# ASSIGNMENTS_FILE overrides the path, used by tests.
file="${ASSIGNMENTS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/assignments.json}"

[[ $# -eq 1 ]] || { echo "usage: assignments:heartbeat <agent-name>" >&2; exit 1; }

update_json "$file" --arg name "$1" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  if any(.assignments[]; .["agent-name"] == $name) then . else error("assignments:heartbeat: no assignment for \($name)") end
  | .assignments |= map(if .["agent-name"] == $name then .["last-heartbeat"] = $at else . end)'
