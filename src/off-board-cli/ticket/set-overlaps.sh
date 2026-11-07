#!/usr/bin/env bash
# Description: Set an off-board ticket's overlap list — ticket:set-overlaps <project> <key> <key>…|none.
set -euo pipefail

# Rewrites the overlaps-with line of the ticket's front matter (see
# ticket.bash), replacing the whole list: `none` clears it, adding the line
# after its depends-on: when it has one, else after its points:, else after
# its status: (as set-dependencies.sh/update-points.sh/update-priority.sh
# place their own lines). Each key must resolve via ticket_file in the same
# off-board folder (any case, ASS-196); it is written canonical, duplicates
# collapsed first-wins, kept in the order passed. The same list, in the same
# order, writes nothing and stamps nothing — the update-priority "already
# none" idiom, generalised. Refuses, writing nothing: an unknown key (a Jira
# key or another project's key included, since resolution is folder-scoped)
# and the ticket's own key. No cycle check: A overlapping B and B overlapping
# A are both allowed (ASS-196: overlaps are symmetric, stored once on the
# ticket whose Find Dependencies run found it, shown on both via a reverse
# lookup). Prints { key, overlaps }. Fails, writing nothing, when the project
# is missing or has no off-board work source, the ticket is missing, or its
# file is malformed. `none` is the clear form only alone; among other keys
# it is resolved like any key and fails as an unknown ticket named NONE.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -ge 3 ]] || { echo "usage: ticket:set-overlaps <project> <key> <key>…|none" >&2; exit 1; }
project="$1"
file="$(ticket_file ticket:set-overlaps "$project" "$2")"
key="$(ticket_key "$file")"
folder="$(dirname "$file")"
lock_store ticket:set-overlaps "$folder"
shift 2

overlaps=()
if [[ $# -eq 1 && "$1" == none ]]; then
  :
else
  for arg in "$@"; do
    ov_file="$(ticket_file ticket:set-overlaps "$project" "$arg")"
    ov="$(ticket_key "$ov_file")"
    [[ "$ov" == "$key" ]] && { echo "ticket:set-overlaps: $key cannot overlap itself" >&2; exit 1; }
    dup=
    for existing in "${overlaps[@]+"${overlaps[@]}"}"; do [[ "$existing" == "$ov" ]] && { dup=1; break; }; done
    [[ -n "$dup" ]] || overlaps+=("$ov")
  done
fi

new_json="$(jq -cn '$ARGS.positional' --args "${overlaps[@]+"${overlaps[@]}"}")"
current_json="$(ticket_json ticket:set-overlaps "$file")"
current="$(jq -c '.["overlaps-with"]' <<< "$current_json")"

if [[ "$current" != "$new_json" ]]; then
  rewrite_ticket ticket:set-overlaps "$file" --argjson overlaps "$new_json" '
    close as $c
    | ($overlaps | join(", ")) as $joined
    | (.[:$c] | index_of(startswith("overlaps-with:"))) as $i
    | (.[:$c] | index_of(startswith("depends-on:"))) as $d
    | (.[:$c] | index_of(startswith("points:"))) as $p
    | (.[:$c] | index_of(startswith("status:"))) as $s
    | if ($overlaps | length) == 0 then (if $i < 0 then . else del(.[$i]) end)
      elif $i >= 0 then .[$i] = "overlaps-with: \($joined)"
      elif $d >= 0 then .[:$d + 1] + ["overlaps-with: \($joined)"] + .[$d + 1:]
      elif $p >= 0 then .[:$p + 1] + ["overlaps-with: \($joined)"] + .[$p + 1:]
      elif $s >= 0 then .[:$s + 1] + ["overlaps-with: \($joined)"] + .[$s + 1:]
      else .[:$c] + ["overlaps-with: \($joined)"] + .[$c:] end'
fi
jq -n --arg key "$key" --argjson overlaps "$new_json" '{ key: $key, overlaps: $overlaps }'
