#!/usr/bin/env bash
# Description: Send a running agent a prompt in its current session — agent-interaction:resume-thread <agent-name> <prompt>.
set -euo pipefail

# Appends {"prompt": …} as a line to the agent's session inbox (see
# inbox.bash), which the supervisor, the only writer to an agent's stdin, sends
# on (see src/agents/process.js). The agent is found by its assignment in
# assignments.json (in data/). Fails, queuing nothing, when the agent
# has no assignment, its process-id is not running, or the prompt is empty.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../inbox.bash"

[[ $# -eq 2 ]] || { echo "usage: agent-interaction:resume-thread <agent-name> <prompt>" >&2; exit 1; }
[[ -n "${2//[[:space:]]/}" ]] || { echo "agent-interaction:resume-thread: the prompt is empty" >&2; exit 1; }

pid="$(jq -r --arg name "$1" 'first(.assignments[] | select(.["agent-name"] == $name) | (.["process-id"] | tostring)) // empty' "$assignments_file")"
[[ -n "$pid" ]] || { echo "agent-interaction:resume-thread: no assignment for $1" >&2; exit 1; }
kill -0 "$pid" 2>/dev/null || { echo "agent-interaction:resume-thread: $1 is not running (process $pid)" >&2; exit 1; }

queue_prompt agent-interaction:resume-thread "$1" "$2"
