#!/usr/bin/env bash
# Description: Mark an off-board ticket kept whole, never split — ticket:keep-whole <project> <key>.
set -euo pipefail

# ASS-252: the operator's Keep whole at the harness's backlog refinement's
# Awaiting Split Decision. Adds `kept-whole: true` to the ticket's front
# matter (see ticket.bash), before its created: line, and stamps updated; the
# refinement's Check Kept Whole (agent.sh ticket:kept-whole) reads it, so an
# estimate too large sends the ticket on to Ready, not to Split again. A
# ticket marked already writes nothing and stamps nothing. ticket:get shows
# "kept-whole": true on a marked ticket alone. Prints { key, kept-whole }.
# Fails, writing nothing, when the project is missing or has no off-board
# work source, the ticket is missing, or its file is malformed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 2 ]] || { echo "usage: ticket:keep-whole <project> <key>" >&2; exit 1; }
file="$(ticket_file ticket:keep-whole "$1" "$2")"
lock_store ticket:keep-whole "$(dirname "$file")"

if [[ "$(ticket_json ticket:keep-whole "$file" | jq -r '.["kept-whole"] // false')" != true ]]; then
  rewrite_ticket ticket:keep-whole "$file" '
    close as $c | (.[:$c] | index_of(startswith("created:"))) as $at
    | if $at < 0 then .[:$c] + ["kept-whole: true"] + .[$c:] else .[:$at] + ["kept-whole: true"] + .[$at:] end'
fi
jq -n --arg key "$(ticket_key "$file")" '{ key: $key, "kept-whole": true }'
