#!/usr/bin/env bash
# Description: Have an environment issue a ticket health check found repaired as Blocked repairs one — ticket:repair-environment <run-id>.
set -euo pipefail

# ASS-124: the run (check-ticket-health-grouped's, at its repair step) is
# about the ticket its trigger sampled — work-item, variation and
# ticket-project up its parents (its own project when none names one) — and
# its structured-output is what the check found (summary; Classify's issue,
# reasoning, human-action). The ticket's variation, at a step of its
# project's engine, goes to that engine's Blocked entering Blocked's
# sub-engine at its repair step — repair-environment, in the VM, once
# vm:setup-complete; else repair-environment-on-host — as Blocked's own
# Classify routes an environment issue (ASS-97): ticket:change-state, the
# run seeded with what was found ({problem} of the repair prompt), so the same
# step repairs it under the same limits, the ticket resumes where it was once
# repaired, and goes to Blocked for Human with what was found and what to do
# if not. Where the engine's Blocked has no such repair step, the ticket may
# not be repaired: it goes to Blocked for Human (ticket:change-state,
# ticket:set-ai-feedback) with what was found and what the operator must do.
# Prints { project, ticket, variation, handed-to, at? }, exit 0. A ticket
# already at blocked, blocked-for-human, a blocked or a done step — or no
# longer in the sprint — is left as it is (said so, exit 0). While an agent is
# assigned to the variation nothing is written: exit 2, tried again later.
# Fails (exit 1) on an unknown run, or one about no ticket.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
agent="$here/../../../agent.sh"
assignments="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"

[[ $# -eq 1 ]] || { echo "usage: ticket:repair-environment <run-id>" >&2; exit 1; }
about="$(jq -c --arg id "$1" '
  .["transient-state-engines"] // [] | . as $all
  | (first(.[] | select(.id == $id)) // error("no run \($id)")) as $run
  | [$run | recurse(.parent["transient-state-engine"] as $up | if $up then first($all[] | select(.id == $up)) else empty end)] as $chain
  | (first($chain[] | .parent | select(.["work-item"] != null)) // error("run \($id) is about no ticket")) as $p
  | { project: (first($chain[] | .parent["ticket-project"] // empty) // $chain[-1].project), ticket: $p["work-item"], variation: $p.variation,
      found: ($run["structured-output"] // {} | with_entries(select(.key | IN("summary", "issue", "reasoning", "human-action")))) }' "$assignments" 2>&1)" \
  || { echo "ticket:repair-environment: ${about#jq: error (at *): }" >&2; exit 1; }
read -r project key name < <(jq -r '[.project, .ticket, .variation // "-"] | @tsv' <<< "$about")
found="$(jq -c .found <<< "$about")"
said() { jq -nc '{ project: $ARGS.positional[0], ticket: $ARGS.positional[1], variation: $ARGS.positional[2] } + $ARGS.named' "$@" --args "$project" "$key" "$name"; }

state="$(jq -r --arg key "$key" --arg name "$name" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
  | first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) | .["harness-status"].state // empty' "$(sprint_file ticket:repair-environment "$project")")"
[[ -n "$state" ]] || { echo "$key $name is not in $project's active sprint: left as it is"; exit 0; }
steps="$(engine_steps ticket:repair-environment "$project")"
if [[ "$state" == blocked || "$state" == blocked-for-human ]] || jq -e --arg s "$state" 'any(.[]; .id == $s and (.["is-done"] == true or .["is-blocked-state"] == true))' <<< "$steps" > /dev/null; then
  echo "$key $name is at $state: left as it is"; exit 0
fi
if jq -e --arg p "$project" --arg key "$key" --arg name "$name" 'any(.assignments // [] | .[]; .project == $p and (.["work-item"] // "" | ascii_downcase) == ($key | ascii_downcase) and .variation == $name)' "$assignments" > /dev/null; then
  echo "ticket:repair-environment: an agent works on $key $name: tried again once it is done" >&2; exit 2
fi

sub="$(jq -r 'first(.[] | select(.id == "blocked" and .action.type? == "state-engine") | .action.engine) // empty' <<< "$steps")"
if [[ -n "$sub" ]] && engine_steps_of ticket:repair-environment "$sub" "$project" 2>/dev/null | jq -e '[.[].id] | index("repair-environment") and index("repair-environment-on-host")' > /dev/null; then
  at=repair-environment-on-host
  "$agent" vm:setup-complete "$project" "$key" "$name" 2>/dev/null && at=repair-environment
  "$agent" ticket:change-state "$project" "$key" "$name" "$state" blocked "$at" "$found" > /dev/null
  said --arg handed-to blocked --arg at "$at"; exit 0
fi

jq -e 'any(.[]; .id == "blocked-for-human")' <<< "$steps" > /dev/null || { echo "ticket:repair-environment: $project's engine has no Blocked for Human to tell the operator in" >&2; exit 1; }
what="$(jq -r '.["human-action"] // empty' <<< "$found")"
short="$what"
[[ -n "$short" ]] || short="Repair the environment of $key $name"
long="$(jq -r --arg engine "${sub:-none}" --arg what "${what:-not said}" '"The ticket health check found an environment issue: \(.summary // "not said"). \(.reasoning // "")\nNot repaired: its Blocked (\($engine)) makes no environment repair. Needs the operator: \($what)"' <<< "$found")"
"$agent" ticket:change-state "$project" "$key" "$name" "$state" blocked-for-human > /dev/null
"$agent" ticket:set-ai-feedback "$project" "$key" "$name" "$short" "$long"
said --arg handed-to blocked-for-human
