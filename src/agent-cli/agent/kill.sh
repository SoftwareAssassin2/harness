#!/usr/bin/env bash
# Description: End an agent's process outright — agent:kill <agent-name>.
set -euo pipefail

# Sends SIGTERM to the process group of the record's process-id (the agent is
# started in its own group, so its children go too), SIGKILL after 2 seconds
# to whatever is still alive, and writes status "Killed" on the agent's
# assignment in assignments.json (in data/). A process already gone, or
# never started, is no failure: the status is written all the same. Fails,
# writing nothing, when the agent has no assignment.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../json-file.bash"
source "$here/../inbox.bash"

[[ $# -eq 1 ]] || { echo "usage: agent:kill <agent-name>" >&2; exit 1; }
pid="$(jq -r --arg name "$1" 'first(.assignments[] | select(.["agent-name"] == $name) | (.["process-id"] | tostring)) // empty' "$assignments_file")"
[[ -n "$pid" ]] || { echo "agent:kill: no assignment for $1" >&2; exit 1; }

alive() { kill -0 "$pid" 2>/dev/null; }
# signal <sig> — to the group when it is one, else to the process alone.
signal() { kill "-$1" -- "-$pid" 2>/dev/null || kill "-$1" "$pid" 2>/dev/null || true; }
if [[ "$pid" =~ ^[0-9]+$ ]] && alive; then
  signal TERM
  for _ in $(seq 20); do alive || break; sleep 0.1; done
  if alive; then signal KILL; fi
fi

update_json "$assignments_file" --arg name "$1" '
  .assignments |= map(if .["agent-name"] == $name then .status = "Killed" else . end)'
