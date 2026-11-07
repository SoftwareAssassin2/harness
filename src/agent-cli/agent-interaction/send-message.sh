#!/usr/bin/env bash
# Description: Send a message to an agent paired with you — agent-interaction:send-message <from-agent> <to-agent> <message>.
set -euo pipefail

# Queues the engine's receive-message template (see prompt.bash) to the
# receiving agent's session inbox (see inbox.bash): {agent-name} the sender,
# {reply-command} this command the other way round, {approve-command} the
# receiver's, and {message} the message itself. Fails, queuing nothing, when
# either agent has no assignment, the message is empty, or the template is
# missing. For a prompt from a human to an agent, see
# agent-interaction:resume-thread.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../prompt.bash"

[[ $# -eq 3 ]] || { echo "usage: agent-interaction:send-message <from-agent> <to-agent> <message>" >&2; exit 1; }
[[ -n "${3//[[:space:]]/}" ]] || { echo "agent-interaction:send-message: the message is empty" >&2; exit 1; }
assignment_of agent-interaction:send-message "$1" > /dev/null
record="$(assignment_of agent-interaction:send-message "$2")"

text="$(template agent-interaction:send-message "$record" receive-message-prompt receive-message-from-another-agent)"
text="$(fill "$text" agent-name "$1")"
text="$(fill "$text" reply-command "$agent_sh agent-interaction:send-message $2 $1 \"<your reply>\"")"
text="$(fill "$text" approve-command "$(approve_command "$2")")"
text="$(fill "$text" message "$3")"
queue_prompt agent-interaction:send-message "$2" "$text"
