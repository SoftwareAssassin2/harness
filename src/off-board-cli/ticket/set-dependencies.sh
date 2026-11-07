#!/usr/bin/env bash
# Description: Set an off-board ticket's dependency list — ticket:set-dependencies <project> <key> <key>…|none.
set -euo pipefail

# Rewrites the depends-on line of the ticket's front matter (see
# ticket.bash), replacing the whole list: `none` clears it, adding the line
# after its points: when it has one, else after its status: (as
# update-points.sh/update-priority.sh place their own lines). Each key must
# resolve via ticket_file in the same off-board folder (any case, ASS-194);
# it is written canonical, duplicates collapsed first-wins, kept in the
# order passed. The same list, in the same order, writes nothing and stamps
# nothing — the update-priority "already none" idiom, generalised. Refuses,
# writing nothing: an unknown key (a Jira key or another project's key
# included, since resolution is folder-scoped), the ticket's own key, and
# any list that would create a cycle in the project's dependency graph — a
# depth-first walk, under the store lock, from each new dependency over the
# on-disk depends-on edges, with a visited set so a pre-existing cycle
# elsewhere in the folder cannot hang it; an edge whose file is missing (a
# hand-edited dangling reference) is skipped, and a malformed file reached
# by the walk fails the command, as ticket:get does on one. Prints { key,
# dependencies }. Fails, writing nothing, when the project is missing or has
# no off-board work source, the ticket is missing, or its file is
# malformed. `none` is the clear form only alone; among other keys it is
# resolved like any key and fails as an unknown ticket named NONE.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -ge 3 ]] || { echo "usage: ticket:set-dependencies <project> <key> <key>…|none" >&2; exit 1; }
project="$1"
file="$(ticket_file ticket:set-dependencies "$project" "$2")"
key="$(ticket_key "$file")"
folder="$(dirname "$file")"
lock_store ticket:set-dependencies "$folder"
shift 2

dependencies=()
if [[ $# -eq 1 && "$1" == none ]]; then
  :
else
  for arg in "$@"; do
    dep_file="$(ticket_file ticket:set-dependencies "$project" "$arg")"
    dep="$(ticket_key "$dep_file")"
    [[ "$dep" == "$key" ]] && { echo "ticket:set-dependencies: $key cannot depend on itself" >&2; exit 1; }
    dup=
    for existing in "${dependencies[@]+"${dependencies[@]}"}"; do [[ "$existing" == "$dep" ]] && { dup=1; break; }; done
    [[ -n "$dup" ]] || dependencies+=("$dep")
  done
fi

# walk <node> <target> — true when $target is reachable from $node over the
# on-disk depends-on edges. A visited set makes it terminate even through a
# pre-existing cycle; a missing file (a dangling hand-edited edge) is a dead
# end, not a failure. ticket_json's own failure (a malformed file reached by
# the walk) is checked explicitly and exits at once — piping it into another
# jq would silently lose a non-zero status on empty input.
declare -A visited
walk() {
  local node="$1" target="$2" node_file node_json edge
  [[ -n "${visited[$node]:-}" ]] && return 1
  visited["$node"]=1
  [[ "$node" == "$target" ]] && return 0
  node_file="$folder/$node.md"
  [[ -f "$node_file" ]] || return 1
  node_json="$(ticket_json ticket:set-dependencies "$node_file")" || exit 1
  while IFS= read -r edge; do
    [[ -z "$edge" ]] && continue
    walk "$edge" "$target" && return 0
  done < <(jq -r '.["depends-on"][]' <<< "$node_json")
  return 1
}

for dep in "${dependencies[@]+"${dependencies[@]}"}"; do
  visited=()
  if walk "$dep" "$key"; then
    echo "ticket:set-dependencies: $key cannot depend on $dep: $dep depends on $key, directly or through another ticket" >&2
    exit 1
  fi
done

new_json="$(jq -cn '$ARGS.positional' --args "${dependencies[@]+"${dependencies[@]}"}")"
current_json="$(ticket_json ticket:set-dependencies "$file")"
current="$(jq -c '.["depends-on"]' <<< "$current_json")"

if [[ "$current" != "$new_json" ]]; then
  rewrite_ticket ticket:set-dependencies "$file" --argjson dependencies "$new_json" '
    close as $c
    | ($dependencies | join(", ")) as $joined
    | (.[:$c] | index_of(startswith("depends-on:"))) as $i
    | (.[:$c] | index_of(startswith("points:"))) as $p
    | (.[:$c] | index_of(startswith("status:"))) as $s
    | if ($dependencies | length) == 0 then (if $i < 0 then . else del(.[$i]) end)
      elif $i >= 0 then .[$i] = "depends-on: \($joined)"
      elif $p >= 0 then .[:$p + 1] + ["depends-on: \($joined)"] + .[$p + 1:]
      elif $s >= 0 then .[:$s + 1] + ["depends-on: \($joined)"] + .[$s + 1:]
      else .[:$c] + ["depends-on: \($joined)"] + .[$c:] end'
fi
jq -n --arg key "$key" --argjson dependencies "$new_json" '{ key: $key, dependencies: $dependencies }'
