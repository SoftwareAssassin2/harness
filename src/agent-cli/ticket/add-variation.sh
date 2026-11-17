#!/usr/bin/env bash
# Description: Build a sprint ticket another way — ticket:add-variation <project> <ticket-key> [--brief <file>] [--at <state>] adds its next variation (B, C, …), with its own brief.
set -euo pipefail

# ASS-499. In the project's active sprint (see sprint.bash), adds to the
# ticket a fresh variation shaped as ticket:sync's new_ticket makes "A" —
# empty build, local-testing, acceptance criteria, merge requests, gates and
# state changes, not paused — named the first letter from B to Z no variation
# of the ticket has had, a deleted one's name included, so a name is never
# reused. It starts at the project's execution engine's `committed` step, or
# at <state> given --at (a top-level step of that engine, checked by
# require_step before anything else, ASS-449). Control then takes it like any
# other variation: its own seat, VM (<key>-<variation>), branches
# (change/<KEY>.<variation>-<id>) and per-variation work files; the
# ticket's other variations are left as they are.
#
# --brief <file> writes the file, whole, as the variation's brief,
# work/<KEY>/variation-brief-<variation>.md: what this variation is to do
# differently (another answer to one of the ticket's questions, say). The
# grouped development prompts that read the ticket's questions and answers
# read it first, and where it conflicts with those answers or the ticket's
# description the brief wins, for this variation only. It is the operator's:
# agents cannot write it (work.bash WORK_MANAGED).
#
# Prints { key, variation, state }. Fails, writing nothing, for a ticket the
# active sprint does not list (one only in the backlog is said to be so), a
# deleted or done ticket (its ticket-system-status Done, or a live variation
# at its engine's done step), an unknown state, a brief that is no file or
# is empty, or a ticket that has used every letter.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../work.bash"

usage() { echo "usage: ticket:add-variation <project> <ticket-key> [--brief <file>] [--at <state>]" >&2; exit 1; }
[[ $# -ge 2 ]] || usage
project="$1" key="$2" brief="" state=committed
shift 2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --brief) [[ $# -ge 2 && -z "$brief" ]] || usage; brief="$2"; shift 2 ;;
    --at) [[ $# -ge 2 ]] || usage; state="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:add-variation: invalid project '$project'" >&2; exit 1; }
engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json" 2>/dev/null || true)"
[[ -n "$engine" ]] || { echo "ticket:add-variation: project '$project' has no execution-state-engine" >&2; exit 1; }
require_step ticket:add-variation "$engine" "$project" "$state" || exit 1
if [[ -n "$brief" ]]; then
  [[ -f "$brief" && -r "$brief" ]] || { echo "ticket:add-variation: no brief file $brief" >&2; exit 1; }
  [[ -s "$brief" ]] || { echo "ticket:add-variation: the brief $brief is empty" >&2; exit 1; }
fi
done_steps="$(engine_steps_of ticket:add-variation "$engine" "$project" | jq -c '[.[] | select(.["is-done"] == true) | .id]')"

sprint="$(sprint_file ticket:add-variation "$project")"
ticket="$(jq -c --arg key "$key" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase))) // empty' "$sprint")"
if [[ -z "$ticket" ]]; then
  if lists "$projects/$project/backlog.json" "$key"; then
    echo "ticket:add-variation: $key is in $project's backlog, not its active sprint: join it to the sprint first (ticket:join-sprint)" >&2
  else
    echo "ticket:add-variation: no $key in $project's active sprint" >&2
  fi
  exit 1
fi
key="$(jq -r .key <<< "$ticket")"
# The first letter after A no variation has had, deleted or not.
name="$(jq -r '[.variations // [] | .[].name] as $used | first(("BCDEFGHIJKLMNOPQRSTUVWXYZ" | split(""))[] | select(IN($used[]) | not)) // empty' <<< "$ticket")"
[[ -n "$name" ]] || { echo "ticket:add-variation: $key has had every variation from A to Z" >&2; exit 1; }

# The checks again under the lock, with the write: a ticket deleted, done or given the name meanwhile is refused.
update_whole_ticket ticket:add-variation "$project" "$key" --arg name "$name" --arg state "$state" --arg engine "$engine" --argjson done "$done_steps" '
  if .["is-deleted"] == true then error("\($command): \($key) is deleted")
  elif .["ticket-system-status"] == "Done" or any(.variations // [] | .[]; (.["is-deleted"] | not) and (.["harness-status"].state | IN($done[])))
    then error("\($command): \($key) is done")
  elif any(.variations // [] | .[]; .name == $name) then error("\($command): \($key) already has a variation \($name)")
  else . end
  | .variations = (.variations // []) + [{
      name: $name, "ai-feedback-short": null, "ai-feedback-long": null,
      "harness-status": { state: $state, "state-engine": $engine },
      build: { branch: null, "branch-url": null, worktree: null, "worktree-folder": null },
      "local-testing": {}, "acceptance-criteria": [], "merge-request": [],
      "gate-when-leaving-state": [], "is-paused": false, "human-review": null, "ai-variation-feedback": null, "state-changes": []
    }]'

if [[ -n "$brief" ]]; then
  mkdir -p "$projects/$project/work/$key"
  file="$(work_path ticket:add-variation "$project" "$key" "$name" "variation-brief-$name.md")"
  lock_on 9 "$file.lock" ticket:add-variation "${JSON_LOCK_TIMEOUT:-30}"
  replace_file "$file" < "$brief" || { echo "ticket:add-variation: could not write $file; $key $name is added without its brief" >&2; exit 1; }
  exec 9>&-
fi
jq -nc --arg key "$key" --arg variation "$name" --arg state "$state" '{ key: $key, variation: $variation, state: $state }'
