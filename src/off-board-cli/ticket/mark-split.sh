#!/usr/bin/env bash
# Description: Mark an off-board ticket split into others, and Done — ticket:mark-split <project> <key> <key>….
set -euo pipefail

# ASS-252: the last write of an accepted split (agent.sh ticket:apply-split).
# Writes `split-into: <KEY>, <KEY>` in the ticket's front matter (see
# ticket.bash), replacing any earlier list, before its created: line, and sets
# its status Done: the downloader then brings it into neither the sprint nor
# the backlog (src/downloader/cycle.js), so it never joins a sprint — the
# tickets it was split into carry its work. Each key must resolve in the same
# off-board folder (any case); written canonical, duplicates collapsed
# first-wins, kept in the order passed. The same list on a Done ticket writes
# nothing and stamps nothing. ticket:get shows "split-into" on a marked ticket
# alone. Prints { key, split-into, status }. Fails, writing nothing, on an
# unknown key or the ticket's own, when the project is missing or has no
# off-board work source, the ticket is missing, or its file is malformed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -ge 3 ]] || { echo "usage: ticket:mark-split <project> <key> <key>…" >&2; exit 1; }
project="$1"
file="$(ticket_file ticket:mark-split "$project" "$2")"
key="$(ticket_key "$file")"
lock_store ticket:mark-split "$(dirname "$file")"
shift 2

pieces=()
for arg in "$@"; do
  piece_file="$(ticket_file ticket:mark-split "$project" "$arg")"
  piece="$(ticket_key "$piece_file")"
  [[ "$piece" != "$key" ]] || { echo "ticket:mark-split: $key cannot be split into itself" >&2; exit 1; }
  dup=
  for existing in "${pieces[@]+"${pieces[@]}"}"; do [[ "$existing" == "$piece" ]] && { dup=1; break; }; done
  [[ -n "$dup" ]] || pieces+=("$piece")
done
list="$(jq -cn '$ARGS.positional' --args "${pieces[@]}")"

if [[ "$(ticket_json ticket:mark-split "$file" | jq -c '[.status, (.["split-into"] // [])]')" != "$(jq -c '["Done", .]' <<< "$list")" ]]; then
  rewrite_ticket ticket:mark-split "$file" --argjson pieces "$list" '
    close as $c
    | (.[:$c] | index_of(startswith("status:"))) as $s
    | (if $s < 0 then .[:$c] + ["status: Done"] + .[$c:] else .[$s] = "status: Done" end)
    | close as $c
    | (.[:$c] | index_of(startswith("split-into:"))) as $i
    | ("split-into: " + ($pieces | join(", "))) as $line
    | if $i >= 0 then .[$i] = $line
      else (.[:$c] | index_of(startswith("created:"))) as $at
        | if $at < 0 then .[:$c] + [$line] + .[$c:] else .[:$at] + [$line] + .[$at:] end end'
fi
jq -n --arg key "$key" --argjson pieces "$list" '{ key: $key, "split-into": $pieces, status: "Done" }'
