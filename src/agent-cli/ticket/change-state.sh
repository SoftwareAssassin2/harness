#!/usr/bin/env bash
# Description: Move a ticket to another state — ticket:change-state <project> <ticket-key> <variation> <from-state> <to-state> [<start-sub-engine-at|-> [<output-json>]].
set -euo pipefail

# Moves the variation to <to-state> in the project's active sprint, as
# sprint.bash's move_to does, then the ticket system follows the new step's
# paired-ticket-system-status (sync_paired_status). Given a start step (not
# -), <to-state> must be a state-engine step of the project's engine and the
# step one of its sub-engine's steps: the same update enters the sub-engine
# there, as ticket:change-sub-state <sub-engine> - <start> would — sub-status
# { state: <start>, state-engine: <sub-engine> }, a sub-state change appended
# after the move — so control starts the run there (steps.js); given an
# <output-json> object too, the sub-status keeps it as `output`, the run's
# structured-output to start from (ASS-124; its one caller, the ticket
# health check's ticket:repair-environment, was removed with that check,
# ASS-450). Fails, writing nothing, unless the variation is
# at <from-state>, or on such a start step, or on an output that is not an
# object or comes without a start step.
#
# <to-state> is checked against the variation's own engine — its
# harness-status's state-engine, else the project's execution engine — start
# step or not (ASS-449, require_step): a state the engine has no step for is
# refused, writing nothing, as the backlog path below already did, naming the
# engine and the state, with ` did you mean <id> (<name>)?` when it is a
# step's display name or a mis-cased id. A display name is never a state.
#
# A backlog ticket (ASS-144: one the active sprint does not list, in the
# project's backlog.json) moves the same way, there, between the steps of its
# own engine — its harness-status's state-engine, else the project's backlog
# refinement engine — <to-state> checked against that engine's steps; it
# enters no sub-engine. The backlog is then renumbered (ticket:renumber-backlog
# --by control, ASS-84), and a ticket entering the engine's done step is
# announced on its ticket (ticket:announce-ready). Fails, writing nothing, on
# a step the engine lacks (the same refusal and hint) or a start step.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
backlog_too=1
source "$here/../sprint.bash"

[[ $# -ge 5 && $# -le 7 ]] || { echo "usage: ticket:change-state <project> <ticket-key> <variation> <from-state> <to-state> [<start-sub-engine-at|-> [<output-json>]]" >&2; exit 1; }
start="${6:--}" sub="" output="${7:-null}"
if [[ $# -eq 7 ]]; then
  jq -e 'type == "object"' <<< "$output" > /dev/null 2>&1 || { echo "ticket:change-state: the output must be a JSON object" >&2; exit 1; }
  [[ "$start" != - ]] || { echo "ticket:change-state: an output needs a start step" >&2; exit 1; }
fi
if in_backlog ticket:change-state "$1" "$2"; then
  [[ "$start" == - ]] || { echo "ticket:change-state: a backlog ticket enters no sub-engine" >&2; exit 1; }
  engine="$(jq -r --arg key "$2" --arg name "$3" 'first(.tickets[] | select(.key | ascii_downcase == ($key | ascii_downcase)) | .variations[]? | select(.name == $name and (.["is-deleted"] | not)) | .["harness-status"]["state-engine"] // empty) // empty' "$projects/$1/backlog.json")"
  [[ -n "$engine" ]] || engine="$(refinement_engine ticket:change-state "$1")"
  require_step ticket:change-state "$engine" "$1" "$5" || exit 1
  done_step="$(engine_steps_of ticket:change-state "$engine" "$1" | jq -r 'first(.[] | select(.["is-done"] == true) | .id) // ""')"
  update_variation ticket:change-state "$1" "$2" "$3" "$4" --arg to "$5" --arg engine "$engine" '.["harness-status"]["state-engine"] = $engine | move_to($to)'
  "$here/renumber-backlog.sh" "$1" --by control >/dev/null
  [[ "$5" != "$done_step" ]] || "$here/../../../agent.sh" ticket:announce-ready "$1" "$2" >/dev/null
  exit 0
fi
# The engine the variation runs in, as ticket:requirements-changed resolves it.
IFS=$'\t' read -r engine state < <(variation_status ticket:change-state "$1" "$2" "$3" | head -n 1) || true
[[ -n "${state:-}" ]] || exit 1
[[ -n "$engine" ]] || engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$1/project.json" 2>/dev/null || true)"
require_step ticket:change-state "$engine" "$1" "$5" || exit 1
if [[ "$start" != - ]]; then
  sub="$(engine_steps_of ticket:change-state "$engine" "$1" | jq -r --arg to "$5" 'first(.[] | select(.id == $to and .action.type? == "state-engine") | .action.engine) // empty')"
  [[ -n "$sub" ]] || { echo "ticket:change-state: $5 runs no state engine" >&2; exit 1; }
  engine_steps_of ticket:change-state "$sub" "$1" | jq -e --arg start "$start" 'any(.[]; .id == $start)' > /dev/null || { echo "ticket:change-state: $sub has no step $start" >&2; exit 1; }
fi

update_variation ticket:change-state "$1" "$2" "$3" "$4" --arg to "$5" --arg start "$start" --arg sub "$sub" --argjson output "$output" '
  move_to($to)
  | if $start == "-" then . else
      .["harness-status"]["sub-status"] = ({ state: $start, "state-engine": $sub } + (if $output == null then {} else { output: $output } end))
      | .["state-changes"][-1]["work-is-done"] = true
      | .["state-changes"] += [{ "state-engine": .["harness-status"]["state-engine"], "from-state": $to, "to-state": $to,
          "sub-state-change": { "state-engine": $sub, "from-state": null, "to-state": $start },
          timestamp: $at, "agent-dispatch-log": [], "work-is-done": false }]
    end'
sync_paired_status ticket:change-state "$1" "$2" "$3"
