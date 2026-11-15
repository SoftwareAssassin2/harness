#!/usr/bin/env bash
# Description: Say what you are doing, in your own words — assignments:status-update <agent-name> <status-update>, or --from <file> for the update in a file.
set -euo pipefail

# Writes "ai-status-update-short" and "last-ai-status-update" (now, UTC) on the
# agent's assignment in assignments.json (in data/), replacing the
# last: the agent's own account of what it is doing, where ai-feedback-short
# is another agent's view of it. Fails, writing nothing, when the agent has no
# assignment or the update is empty or longer than 34 characters (the
# dashboard's column). The update is the argument, or with --from <file>
# (ASS-463) that file's text, a trailing newline dropped: an update with
# quotes, $ or backquotes the agent would otherwise have to escape, given
# as a file so the call stays one bare command line (a confined host agent's
# agent.sh runs outside the sandbox only so; never piped). A VM agent gives
# it as the argument: the forwarder's max-args keeps a Mac path out.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# ASSIGNMENTS_FILE overrides the path, used by tests.
file="${ASSIGNMENTS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/assignments.json}"

usage="usage: assignments:status-update <agent-name> <status-update> | assignments:status-update <agent-name> --from <file>"
if [[ $# -eq 3 && "$2" == --from ]]; then
  [[ -f "$3" && -r "$3" ]] || { echo "assignments:status-update: no file $3" >&2; exit 1; }
  update="$(cat "$3")"
elif [[ $# -eq 2 ]]; then update="$2"
else echo "$usage" >&2; exit 1; fi
[[ -n "${update//[[:space:]]/}" ]] || { echo "assignments:status-update: the status update is empty" >&2; exit 1; }
[[ ${#update} -le 34 ]] || { echo "assignments:status-update: the status update is longer than 34 characters" >&2; exit 1; }

update_json "$file" --arg name "$1" --arg update "$update" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  if any(.assignments[]; .["agent-name"] == $name) then . else error("assignments:status-update: no assignment for \($name)") end
  | .assignments |= map(if .["agent-name"] == $name then .["ai-status-update-short"] = $update | .["last-ai-status-update"] = $at else . end)'
