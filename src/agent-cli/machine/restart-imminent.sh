#!/usr/bin/env bash
# Description: Tell every agent on a ticket variation's machine that it is about to go down: its turn interrupted, the restart prompt queued — machine:restart-imminent <project> <ticket> <variation> [<machine>].
set -euo pipefail

# ASS-504: a cloud VM about to go down (a GCP Spot preemption, ~30 s notice,
# or any shutdown) calls this through the forwarder from its restart watcher
# (workstation/on-workstation/restart-watcher.sh), giving no arguments: the
# forwarder appends its token's binding — project, ticket, variation — and the
# machine's name (forwarder-allowlist.json "from-binding"), so a VM can only
# ever name its own. For every agent assigned to that ticket variation (any
# status but Killed: one Starting has its inbox read once its process is up)
# it queues prompts/restart-imminent/prompt.txt — engine-independent, the one
# place the text lives — with --interrupt (inbox.bash): the supervisor
# (src/agents/process.js) interrupts the turn under way, a long tool call
# included, and sends the prompt at once; control then ends the agent
# without completing its step once that prompt's turn is over (finish.js), the
# step run again when the machine is back. Agents on any other ticket
# variation get nothing. Prints one line, "restart imminent on <machine>:
# told <names>" (or "no agents to tell"), which the forwarder writes to
# control's log. Fails, naming the agent, when a prompt could not be queued.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../inbox.bash"

command=machine:restart-imminent
[[ $# -eq 3 || $# -eq 4 ]] || { echo "usage: $command <project> <ticket> <variation> [<machine>]" >&2; exit 1; }
project="$1" ticket="$2" variation="$3" machine="${4:-"$1 $2 $3's machine"}"
template="${PROMPTS_DIR:-$here/../../../prompts}/restart-imminent/prompt.txt"
[[ -s "$template" ]] || { echo "$command: no restart prompt at $template" >&2; exit 1; }
text="$(cat "$template")"

told=() failed=0
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  if queue_prompt "$command" "$name" "$text" --interrupt; then told+=("$name"); else failed=1; fi
done < <(jq -r --arg p "$project" --arg t "$ticket" --arg v "$variation" '
  .assignments[] | select(.project == $p and ((.["work-item"] // "") | ascii_upcase) == ($t | ascii_upcase) and .variation == $v and .status != "Killed") | .["agent-name"]' "$assignments_file")

if [[ ${#told[@]} -eq 0 ]]; then echo "restart imminent on $machine: no agents to tell"
else echo "restart imminent on $machine: told ${told[*]}"
fi
exit "$failed"
