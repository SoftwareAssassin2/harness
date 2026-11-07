#!/usr/bin/env bash
# Description: Set an off-board ticket's story points — ticket:update-points <project> <key> <1|2|3|5|none>.
set -euo pipefail

# Rewrites the points line of the ticket's front matter (see ticket.bash),
# adding one after its status when it has none; `none` removes it, the
# unestimated state. A value it already has writes nothing and stamps nothing,
# so a re-estimate to the same number is no change to the downloader. Prints
# { key, points }. Fails, writing nothing, on any other value, when the
# project is missing or has no off-board work source, the ticket is missing,
# or its file is malformed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:update-points <project> <key> <1|2|3|5|none>" >&2; exit 1; }
case "$3" in 1|2|3|5) points="$3" ;; none) points=null ;; *) echo "ticket:update-points: '$3' is not a story-point value; one of 1, 2, 3, 5 or none" >&2; exit 1 ;; esac
file="$(ticket_file ticket:update-points "$1" "$2")"
key="$(ticket_key "$file")"

if [[ "$(ticket_json ticket:update-points "$file" | jq -c '.points')" != "$points" ]]; then
  rewrite_ticket ticket:update-points "$file" --argjson points "$points" '
    close as $c | (.[:$c] | index_of(startswith("points:"))) as $i
    | (.[:$c] | index_of(startswith("status:"))) as $s
    | if $points == null then (if $i < 0 then . else del(.[$i]) end)
      elif $i >= 0 then .[$i] = "points: \($points)"
      elif $s >= 0 then .[:$s + 1] + ["points: \($points)"] + .[$s + 1:]
      else .[:$c] + ["points: \($points)"] + .[$c:] end'
fi
jq -n --arg key "$key" --argjson points "$points" '{ key: $key, points: $points }'
