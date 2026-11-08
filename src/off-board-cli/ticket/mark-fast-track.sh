#!/usr/bin/env bash
# Description: Mark an existing off-board ticket fast-track — ticket:mark-fast-track <project> <key>.
set -euo pipefail

# ASS-306: the grouped blocked flow's fix ticket, fast-tracked after it is
# created (agent.sh ticket:fast-track, the engine's Fast-Track the Fix step) —
# ticket:create --fast-track cannot, the shared create prompt raising tickets
# for other flows too. Adds `fast-track: true` to the ticket's front matter
# (see ticket.bash), before its created: line, and stamps updated; a later
# ticket:join-sprint carries the mark into the sprint, where control ranks it
# above everything (rank.js, fast-track.js). A ticket marked already writes
# nothing and stamps nothing. ticket:get shows "fast-track": true on a marked
# ticket alone. Prints { key, fast-track }. Fails, writing nothing, when the
# project is missing or has no off-board work source, the ticket is missing,
# or its file is malformed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 2 ]] || { echo "usage: ticket:mark-fast-track <project> <key>" >&2; exit 1; }
file="$(ticket_file ticket:mark-fast-track "$1" "$2")"
lock_store ticket:mark-fast-track "$(dirname "$file")"

if [[ "$(ticket_json ticket:mark-fast-track "$file" | jq -r '.["fast-track"] // false')" != true ]]; then
  rewrite_ticket ticket:mark-fast-track "$file" '
    close as $c | (.[:$c] | index_of(startswith("created:"))) as $at
    | if $at < 0 then .[:$c] + ["fast-track: true"] + .[$c:] else .[:$at] + ["fast-track: true"] + .[$at:] end'
fi
jq -n --arg key "$(ticket_key "$file")" '{ key: $key, "fast-track": true }'
