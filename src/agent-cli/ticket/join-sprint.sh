#!/usr/bin/env bash
# Description: Make a ticket sprint work at a state — ticket:join-sprint <project> <ticket-key> <state>.
set -euo pipefail

# An off-board ticket (the project's off-board key prefix, see
# ticket-system.bash) not in the active sprint is brought in (ticket:sync,
# from off-board.sh ticket:get: a new ticket, variation A at backlog, its
# manual-priority null, its fast-track mark when it has one, ASS-83; the sync
# renumbers the backlog without it, ASS-84) — into the sprint the project
# tracks work in now (sprints.json is-active, as the TUI shows it), however
# far past its end; then
# each live variation not at <state> moves there (ticket:change-state, which
# sets the step's paired status). Prints { key, state, moved: [<variation>…] }.
# Fails, writing nothing, when the ticket is neither in the sprint nor
# off-board, or the project tracks no sprint — a fast-tracked ticket then
# stays off-board at Backlog, synced to the backlog with its mark, to be
# joined by hand or by its source on a later run (ASS-83; ASS-306 added the
# grouped blocked flow's fix ticket as a second source, whose one-shot
# fast-track-fix step does not retry). It also fails, writing nothing, while the
# ticket has an open blocking question (ASS-248: Asked or Answer Rejected — any
# status but Answered, Answer Accepted or Assumed — and not flagged blocking:
# false, so one asked before the flag counts), naming each: it is not
# committed until the operator answers. A non-blocking question never holds it.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"
agent="$here/../../../agent.sh"

[[ $# -eq 3 ]] || { echo "usage: ticket:join-sprint <project> <ticket-key> <state>" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" state="$3"
# The ticket's own project: an off-board key (ASS-n) lives in the harness's project, whichever project raised it.
project="$(home_project ticket:join-sprint "$1" "$key")"
sprint="$(sprint_file ticket:join-sprint "$project")"
questions="$projects/$project/work/$key/questions-and-answers.json"
if [[ -s "$questions" ]]; then
  open="$(jq -r '.list // [] | .[] | select((.status | IN("Answered", "Answer Accepted", "Assumed") | not) and .blocking != false) | "  - \(.question // "")"' "$questions")"
  [[ -z "$open" ]] || { printf 'ticket:join-sprint: %s has an open blocking question; it joins the sprint once answered:\n%s\n' "$key" "$open" >&2; exit 1; }
fi
in_sprint() { jq -e --arg key "$key" 'any((.features, .bugs, .spikes) // [] | .[]; .key | ascii_upcase == $key)' "$sprint" >/dev/null; }

if ! in_sprint; then
  prefix="$(off_board_prefix ticket:join-sprint "$project")"
  [[ -n "$prefix" && "$key" == "$prefix-"* ]] || { echo "ticket:join-sprint: $key is not in $project's active sprint" >&2; exit 1; }
  fetched="$(mktemp)"
  trap 'rm -f "$fetched"' EXIT
  # The off-board ticket in the shape ticket:sync takes (as src/downloader/off-board.js maps it).
  off_board_run ticket:join-sprint ticket:get "$project" "$key" | jq '{ tickets: [{
    key, title: (.title // ""), description: (.description // ""), url: null,
    "ticket-system-status": .status, "ticket-system-priority": (.priority // null), "ticket-system-assignment": null,
    points: (.points // null), "issue-type": (.type // "Story"), dependencies: [], "sprint-tag": null }
    + (if .["fast-track"] == true then { "fast-track": true } else {} end)] }' > "$fetched"
  "$agent" ticket:sync "$project" sprint "$fetched" >/dev/null
fi

moved=()
while IFS=$'\t' read -r name at; do
  [[ -n "$name" && "$at" != "$state" ]] || continue
  "$agent" ticket:change-state "$project" "$key" "$name" "$at" "$state" >/dev/null
  moved+=("$name")
done < <(jq -r --arg key "$key" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_upcase == $key)) | .variations // [] | .[]
  | select(.["is-deleted"] | not) | [.name, .["harness-status"].state] | @tsv' "$sprint")
jq -nc --arg key "$key" --arg state "$state" '{ key: $key, state: $state, moved: $ARGS.positional }' --args "${moved[@]+"${moved[@]}"}"
