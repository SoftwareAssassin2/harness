#!/usr/bin/env bash
# Description: Create the tickets a split proposal names and mark the original split into them — ticket:apply-split <project> <ticket-key>.
set -euo pipefail

# ASS-252: the operator's Accept at the harness's backlog refinement's Awaiting
# Split Decision, run by its Create the Split Tickets step. From the ticket's
# split-proposal.json (ticket:propose-split), through off-board.sh alone, in
# the ticket's home project (ticket-system.bash home_project):
# - each proposed ticket created (ticket:create, at Backlog, with the
#   original's priority): its user story, its context with a line naming the
#   ticket it was split from and the criteria it carries, then its
#   acceptance criteria (ticket:replace-acceptance-criteria, numbered, AC<n>:
#   put before one that has none) and its points (ticket:update-points). Its
#   key is kept in the proposal as it is created, so a run stopped part way
#   and run again creates none twice. The downloader brings each into the
#   backlog at the refinement's first step, like any new ticket. ASS-266: one
#   an earlier apply already made is reused, never created again, its user
#   story and context rewritten to this proposal's (ticket:update-requirements)
#   and its key recorded: the one already-created gives its place (a proposal
#   made after a partial apply, ticket:propose-split), else one with the same
#   title carrying this split's marker ("Split from <KEY> (", split.bash
#   split_made) that neither this proposal nor already-created holds — a run
#   stopped between creating a ticket and recording its key. An
#   already-created ticket with no place is left as it is, outside the split;
# - each one's dependencies (ticket:set-dependencies): the proposal's own,
#   its places turned into the new keys, and, on one that waits on none of
#   the others, what the original waited on;
# - every other ticket that depended on the original made to depend on all
#   of them instead;
# - the original marked split into them, Done (ticket:mark-split), so the
#   downloader takes it into neither the sprint nor the backlog; and its
#   backlog entry given ticket-system-status Done and the split-into list,
#   so control and the dashboard leave it out of the backlog (rank.js
#   isLiveBacklogEntry) and it never joins a sprint.
# Prints { ticket, split-into }. Fails, saying why, with no proposal, or
# when off-board.sh refuses a write — a run again picks up where it stopped.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
backlog_too=1
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"
source "$here/../work.bash"
source "$here/../split.bash"

command=ticket:apply-split
[[ $# -eq 2 ]] || { echo "usage: $command <project> <ticket-key>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
file="$(work_path "$command" "$project" "$key" - split-proposal.json)"
[[ -f "$file" ]] || { echo "$command: $key has no split proposal (ticket:propose-split)" >&2; exit 1; }
# One run at a time: two would create the tickets twice.
lock_on 6 "$file.apply.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}"

home="$(home_project "$command" "$project" "$key")"
original="$(off_board_run "$command" ticket:get "$home" "$key")"
key="$(jq -r .key <<< "$original")" title="$(jq -r .title <<< "$original")" priority="$(jq -r '.priority // empty' <<< "$original")"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
count="$(jq '.tickets | length' "$file")"

# The tickets, created once each: what an earlier apply made (ASS-266) reused.
before="$(split_made "$command" "$home" "$key" "$file")"
keys=()
for ((i = 0; i < count; i++)); do
  made="$(jq -r --argjson i "$i" '.tickets[$i].key // empty' "$file")"
  if [[ -z "$made" ]]; then
    jq -r --argjson i "$i" --arg key "$key" --arg title "$title" '.tickets[$i]
      | "## User story\n\n\(.["user-story"])\n\n## Context\n\n\(.context)\n\nSplit from \($key) (\($title)); covers \(if (.covers | length) > 0 then "its " + (.covers | map("AC\(.)") | join(", ")) else "none of its criteria" end).\n\n## Acceptance criteria\n"' "$file" \
      | replace_file "$scratch/body.md"
    made="$(jq -r --argjson i "$i" --argjson before "$before" --argjson keys "$(jq -cn '$ARGS.positional' --args "${keys[@]+"${keys[@]}"}")" "$split_same_title"'
      ([.tickets[].key | strings] + $keys + [(.["already-created"] // [])[].key]) as $held
      | first(((.["already-created"] // [])[] | select(.place == $i + 1) | .key),
          ((.tickets[$i].title | same_title) as $t | $before[] | select((.title | same_title) == $t) | .key | select(. as $k | $held | index([$k]) | not))) // empty' "$file")"
    if [[ -n "$made" ]]; then
      off_board_run "$command" ticket:update-requirements "$home" "$made" "$scratch/body.md" >/dev/null
    else
      made="$(off_board_run "$command" ticket:create "$home" "$(jq -r --argjson i "$i" '.tickets[$i].type' "$file")" "$(jq -r --argjson i "$i" '.tickets[$i].title' "$file")" "$scratch/body.md" ${priority:+--priority "$priority"} | jq -r .key)"
    fi
    update_json "$file" --argjson i "$i" --arg k "$made" '.tickets[$i].key = $k'
  fi
  keys+=("$made")
done
pieces="$(jq -cn '$ARGS.positional' --args "${keys[@]}")"

# Their criteria, points and dependencies: writes that change nothing when run again.
inherited="$(jq -c '.["depends-on"]' <<< "$original")"
for ((i = 0; i < count; i++)); do
  jq --argjson i "$i" '[.tickets[$i]["acceptance-criteria"] | to_entries[]
    | { "criteria-number": (.key + 1), description: (if .value | test("^AC[0-9]+:") then .value else "AC\(.key + 1): \(.value)" end) }]' "$file" \
    | replace_file "$scratch/criteria.json"
  off_board_run "$command" ticket:replace-acceptance-criteria "$home" "${keys[$i]}" "$scratch/criteria.json" >/dev/null
  off_board_run "$command" ticket:update-points "$home" "${keys[$i]}" "$(jq -r --argjson i "$i" '.tickets[$i].points' "$file")" >/dev/null
  deps=()
  while IFS= read -r dep; do [[ -n "$dep" ]] && deps+=("$dep"); done < <(jq -r --argjson i "$i" --argjson pieces "$pieces" --argjson inherited "$inherited" '
    .tickets[$i]["depends-on"] as $own
    | ([$own[] | if type == "number" then $pieces[. - 1] else . end] + (if any($own[]; type == "number") then [] else $inherited end))
    | reduce .[] as $d ([]; if index([$d]) then . else . + [$d] end) | .[]' "$file")
  off_board_run "$command" ticket:set-dependencies "$home" "${keys[$i]}" "${deps[@]-none}" >/dev/null
done

# What waited on the original waits on all of them.
while IFS=$'\t' read -r waiting list; do
  [[ -n "$waiting" ]] || continue
  read -r -a deps <<< "$list"
  off_board_run "$command" ticket:set-dependencies "$home" "$waiting" "${deps[@]}" >/dev/null
done < <(off_board_run "$command" ticket:list "$home" | jq -r --arg key "$key" --argjson pieces "$pieces" '
  .[] | select(.key != $key and (.["depends-on"] | index([$key])))
  | [.key, ([.["depends-on"][] | if . == $key then $pieces[] else . end] | reduce .[] as $d ([]; if index([$d]) then . else . + [$d] end) | join(" "))] | @tsv')

off_board_run "$command" ticket:mark-split "$home" "$key" "${keys[@]}" >/dev/null
if in_backlog "$command" "$project" "$key"; then
  update_whole_ticket "$command" "$project" "$key" --argjson pieces "$pieces" '.["ticket-system-status"] = "Done" | .["split-into"] = $pieces'
fi
jq -nc --arg t "$key" --argjson pieces "$pieces" '{ ticket: $t, "split-into": $pieces }'
