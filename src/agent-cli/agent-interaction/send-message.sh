#!/usr/bin/env bash
# Description: Send a message to an agent paired with you — agent-interaction:send-message <from-agent> <to-agent> <message>, or --from <file> for the message in a file.
set -euo pipefail

# Queues the engine's receive-message template (see prompt.bash) to the
# receiving agent's session inbox (see inbox.bash): {agent-name} the sender,
# {reply-command} this command the other way round, {approve-command} the
# receiver's, and {message} the message itself. Fails, queuing nothing, when
# either agent has no assignment, the message is empty, or the template is
# missing. For a prompt from a human to an agent, see
# agent-interaction:resume-thread. The message is the argument, or with
# --from <file> (ASS-463) that file's text: a long or quoted message given
# as a file, so the call stays one bare command line (never piped). A VM
# agent gives it as the argument: the forwarder's max-args keeps a Mac path out.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../prompt.bash"

if [[ $# -eq 4 && "$3" == --from ]]; then
  [[ -f "$4" && -r "$4" ]] || { echo "agent-interaction:send-message: no file $4" >&2; exit 1; }
  message="$(cat "$4")"
elif [[ $# -eq 3 ]]; then message="$3"
else echo "usage: agent-interaction:send-message <from-agent> <to-agent> <message> | agent-interaction:send-message <from-agent> <to-agent> --from <file>" >&2; exit 1; fi
[[ -n "${message//[[:space:]]/}" ]] || { echo "agent-interaction:send-message: the message is empty" >&2; exit 1; }
assignment_of agent-interaction:send-message "$1" > /dev/null
record="$(assignment_of agent-interaction:send-message "$2")"

text="$(template agent-interaction:send-message "$record" receive-message-prompt receive-message-from-another-agent)"
text="$(fill "$text" agent-name "$1")"
text="$(fill "$text" reply-command "$agent_sh agent-interaction:send-message $2 $1 \"<your reply>\"")"
text="$(fill "$text" approve-command "$(approve_command "$2")")"
text="$(fill "$text" message "$message")"
queue_prompt agent-interaction:send-message "$2" "$text"
