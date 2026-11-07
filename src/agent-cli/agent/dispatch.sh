#!/usr/bin/env bash
# Description: Queue an agent its assignment, composed from the prompt templates — agent:dispatch <agent-name> [<placeholder>=<value>…].
set -euo pipefail

# The assignment prompt, prompts/<prompt>/prompt.txt of the agent's record in
# assignments.json with {ticket}, {project}, {variation}, {ticket-folder},
# {agent-sh} (see prompt.bash fill_ticket) and {problem} filled from the record, and
# any <placeholder>=<value> given after the name (control passes folder — the
# agent's folder — and, working in the dev container, dev-container and
# dev-container-folder, that folder as the container mounts it; for an agent
# in its variation's VM, ASS-74, ticket-folder and agent-sh, which then stand
# for the record's own everywhere, the templates' commands too; and
# project-code-folder, the ticket's code — the wrappers' {code-scope}
# preamble names it, ASS-106; and, for a harness run about another project's
# ticket, ticket-project, whose folder is then the ticket's, ASS-204), wrapped in the engine's receive-dispatch template for the
# pen-holder or receive-pair-dispatch for a paired agent ({agent-names} the
# others on the assignment, {pen-holder}; {step}, {model} and {date}, the
# record's state, its model and today, the source of its memories, ASS-62), the commands the template names
# filled in, and the persona prompts/<prompt>/prompt.json names before it all
# (see prompt.bash). Queued to the agent's session inbox (see inbox.bash) —
# the process need not be running yet; it reads its inbox when it starts — and
# printed, so control can log it. The prompt starts the inbox afresh, under
# its lock: an earlier process of the same name and second left its prompts
# there, which this one must not read (control's clear until ASS-179).
# Changes nothing on the record. Fails, queuing nothing, when the agent has no
# assignment or a prompt or template is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../prompt.bash"

[[ $# -ge 1 ]] || { echo "usage: agent:dispatch <agent-name> [<placeholder>=<value>...]" >&2; exit 1; }
name="$1"
shift
for pair in "$@"; do
  [[ "$pair" == *=* ]] || { echo "agent:dispatch: expected <placeholder>=<value>, not \"$pair\"" >&2; exit 1; }
  case "$pair" in agent-sh=*) agent_sh="${pair#*=}" ;; ticket-folder=*) ticket_folder="${pair#*=}" ;; project-code-folder=*) project_code_folder="${pair#*=}" ;; ticket-project=*) ticket_project="${pair#*=}" ;; esac
done
record="$(assignment_of agent:dispatch "$name")"
field() { jq -r --arg key "$1" '.[$key] // ""' <<< "$record"; }
prompt="$(field prompt)"
[[ "$prompt" =~ ^[A-Za-z0-9_-]+$ && -f "$prompts_dir/$prompt/prompt.txt" ]] || { echo "agent:dispatch: no prompt $prompt for $name" >&2; exit 1; }

assignment="$(fill_ticket "$(cat "$prompts_dir/$prompt/prompt.txt")" "$record")"
assignment="$(fill "$assignment" problem "$(field problem)")"
for pair in "$@"; do assignment="$(fill "$assignment" "${pair%%=*}" "${pair#*=}")"; done

pen="$(field pen-holder)"
if [[ -z "$pen" || "$pen" == "$name" ]]; then
  text="$(template agent:dispatch "$record" receive-dispatch-prompt receive-dispatch)"
else
  text="$(template agent:dispatch "$record" receive-pair-dispatch-prompt receive-pair-dispatch)"
  others="$(jq -r --arg id "$(field assignment-id)" --arg name "$name" \
    '[.assignments[] | select(.["assignment-id"] == $id and .["agent-name"] != $name) | .["agent-name"]] | join(", ")' "$assignments_file")"
  text="$(fill "$text" agent-names "$others")"
  text="$(fill "$text" pen-holder "$pen")"
fi
text="$(fill_ticket "$text" "$record")"
# The source an agent saves with each memory (ASS-62): its step, its model and today.
text="$(fill "$text" step "$(field state)")"
text="$(fill "$text" model "$(field model)")"
text="$(fill "$text" date "$(date -u +%Y-%m-%d)")"
text="$(fill_commands "$text" "$name")"
text="$(fill "$text" send-message-command "$agent_sh agent-interaction:send-message $name <to-agent> \"<message>\"")"
text="$(fill "$text" assignment "$assignment")"
# The persona fills the same placeholders as the assignment: it may name the harness ({agent-sh}) and the project.
persona="$(fill_ticket "$(persona_of "$prompt")" "$record")"
[[ -z "$persona" ]] || text="$persona"$'\n\n'"$text"

# The ticket as it stands now, in its folder, for the agent to read before it starts.
write_ticket_json "$record"
queue_prompt agent:dispatch "$name" "$text" --fresh
printf '%s\n' "$text"
