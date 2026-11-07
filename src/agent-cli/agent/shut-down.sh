#!/usr/bin/env bash
# Description: Ask an agent to stop, commit and end its turn — agent:shut-down <agent-name> [ticket-folder=<folder> agent-sh=<agent.sh>].
set -euo pipefail

# Writes status "Shutting Down" and shut-down-requested (now, UTC) on the
# agent's assignment in assignments.json, then queues the engine's shut-down
# template (see prompt.bash) to its session inbox (see inbox.bash), its
# {ticket-folder} and {agent-sh} the record's — or, for an agent in its
# variation's VM, the ticket-folder= and agent-sh= control gives after the
# name, as agent:dispatch takes them (ASS-181: /mnt/ticket and agent.sh). Control
# gives it harness.json's agent-graceful-shut-down-delay-in-seconds, then
# agent:kill. Fails, writing nothing, when the agent has no assignment or the
# template is missing.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../json-file.bash"
source "$here/../prompt.bash"

[[ $# -ge 1 ]] || { echo "usage: agent:shut-down <agent-name> [ticket-folder=<folder> agent-sh=<agent.sh>]" >&2; exit 1; }
for pair in "${@:2}"; do
  case "$pair" in agent-sh=*) agent_sh="${pair#*=}" ;; ticket-folder=*) ticket_folder="${pair#*=}" ;; *) echo "agent:shut-down: expected <placeholder>=<value> (ticket-folder, agent-sh), not \"$pair\"" >&2; exit 1 ;; esac
done
record="$(assignment_of agent:shut-down "$1")"
text="$(fill_ticket "$(template agent:shut-down "$record" shut-down-prompt shut-down)" "$record")"

update_json "$assignments_file" --arg name "$1" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  .assignments |= map(if .["agent-name"] == $name then .status = "Shutting Down" | .["shut-down-requested"] = $at else . end)'
queue_prompt agent:shut-down "$1" "$text"
