# Queues a prompt for an agent, for the agent-cli commands that "send" an agent
# something. Only the supervisor writes to an agent's stdin (see
# src/agents/process.js); a command appends {"prompt": …} as a line to the
# agent's session inbox, data/agents/<agent-name>-<start-time as
# YYYYMMDDTHHMMSSZ>/inbox.jsonl (the folder as src/agents/session.js names it),
# and the supervisor sends it on.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../inbox.bash"
#   queue_prompt <command> <agent-name> <text> [--fresh | --interrupt]
#
# The agent is found by its assignment in assignments.json (in data/;
# ASSIGNMENTS_FILE overrides the path, AGENTS_DIR the agents folder, used by
# tests). The session folder is made when it does not exist yet: a prompt may
# be queued before the agent's process starts (agent:dispatch), and is read when
# it does. The line goes in through json-file.bash's append_line, under
# inbox.jsonl.lock (ASS-179); --fresh (agent:dispatch) makes it the inbox's
# only line, an earlier process of the same name and second having left its
# prompts there. --interrupt (ASS-504: machine:restart-imminent) queues
# {"prompt": …, "interrupt": true}: the supervisor interrupts the agent's turn
# under way first (process.js), then sends the prompt. Fails, queuing nothing,
# naming <command>, when the agent has no assignment.
assignments_file="${ASSIGNMENTS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/assignments.json}"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/json-file.bash"
agents_dir="${AGENTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/agents}"

queue_prompt() {
  local command="$1" name="$2" text="$3" fresh="" interrupt=false start stamp
  case "${4:-}" in --fresh) fresh=--fresh ;; --interrupt) interrupt=true ;; esac
  start="$(jq -r --arg name "$name" 'first(.assignments[] | select(.["agent-name"] == $name) | .["start-time"]) // empty' "$assignments_file")"
  [[ -n "$start" ]] || { echo "$command: no assignment for $name" >&2; return 1; }
  stamp="$(sed -E 's/\.[0-9]+Z$/Z/; s/[-:]//g' <<< "$start")"
  mkdir -p "$agents_dir/$name-$stamp"
  append_line $fresh "$agents_dir/$name-$stamp/inbox.jsonl" "$(jq -cn --arg prompt "$text" --argjson interrupt "$interrupt" '{ prompt: $prompt } + (if $interrupt then { interrupt: true } else {} end)')"
}
