#!/usr/bin/env bash
# Description: Say what you are doing, in your own words — assignments:status-update <agent-name> <status-update>.
set -euo pipefail

# Writes "ai-status-update-short" and "last-ai-status-update" (now, UTC) on the
# agent's assignment in assignments.json (in data/), replacing the
# last: the agent's own account of what it is doing, where ai-feedback-short
# is another agent's view of it. Fails, writing nothing, when the agent has no
# assignment or the update is empty or longer than 34 characters (the
# dashboard's column).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# ASSIGNMENTS_FILE overrides the path, used by tests.
file="${ASSIGNMENTS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/assignments.json}"

[[ $# -eq 2 ]] || { echo "usage: assignments:status-update <agent-name> <status-update>" >&2; exit 1; }
[[ -n "${2//[[:space:]]/}" ]] || { echo "assignments:status-update: the status update is empty" >&2; exit 1; }
[[ ${#2} -le 34 ]] || { echo "assignments:status-update: the status update is longer than 34 characters" >&2; exit 1; }

update_json "$file" --arg name "$1" --arg update "$2" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  if any(.assignments[]; .["agent-name"] == $name) then . else error("assignments:status-update: no assignment for \($name)") end
  | .assignments |= map(if .["agent-name"] == $name then .["ai-status-update-short"] = $update | .["last-ai-status-update"] = $at else . end)'
