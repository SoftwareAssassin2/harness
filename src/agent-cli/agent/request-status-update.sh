#!/usr/bin/env bash
# Description: Ask an agent for a status update — agent:request-status-update <agent-name>.
set -euo pipefail

# Queues the engine's ask-for-status-update template (see prompt.bash) to the
# agent's session inbox (see inbox.bash), {minutes} the whole minutes since the
# record's last-ai-status-update, or since its start-time when there has been
# none. Changes nothing on the record. Fails, queuing nothing, when the agent
# has no assignment or the template is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../prompt.bash"

[[ $# -eq 1 ]] || { echo "usage: agent:request-status-update <agent-name>" >&2; exit 1; }
record="$(assignment_of agent:request-status-update "$1")"
since="$(jq -r '.["last-ai-status-update"] // .["start-time"]' <<< "$record")"
minutes="$(jq -rn --arg t "$since" '(now - ($t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) / 60 | floor')"

text="$(template agent:request-status-update "$record" ask-for-status-update-prompt ask-for-status-update)"
text="$(fill "$text" minutes "$minutes")"
text="$(fill_commands "$text" "$1")"
queue_prompt agent:request-status-update "$1" "$text"
