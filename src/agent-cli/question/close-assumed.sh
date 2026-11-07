#!/usr/bin/env bash
# Description: Close a done ticket's open non-blocking questions as Assumed — question:close-assumed <project> <ticket-key> [--unflagged]; with --unflagged, its questions asked before the blocking flag too.
set -euo pipefail

# ASS-248: a ticket that reaches Done shipped on the assumptions its
# non-blocking questions recorded, so each still open (isOpenQuestion: not
# Answered, Answer Accepted or Assumed) — blocking: false — becomes "Assumed",
# its recommended answer standing (sprint.bash sync_paired_status runs this on
# the move to a done step). With --unflagged a question with no blocking flag
# (asked before ASS-248) closes too: question:migrate-unflagged's one-off for
# the tickets already Done. A blocking one is left open. Prints
# "<ticket-key>: <n> question(s) closed as Assumed"; a ticket with no
# questions file has none, and nothing is written.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/question.bash"

[[ ($# -eq 2 || ($# -eq 3 && "$3" == --unflagged)) && "$2" != global ]] || { echo "usage: question:close-assumed <project> <ticket-key> [--unflagged]" >&2; exit 1; }
question_file question:close-assumed "$1" "$2"
unflagged=false; [[ $# -eq 3 ]] && unflagged=true
# The questions it closes, as a jq condition on one.
closes='(.status | IN("Answered", "Answer Accepted", "Assumed") | not) and (.blocking == false or ($unflagged and .blocking == null))'
n=0
[[ -s "$file" ]] && n="$(jq --argjson unflagged "$unflagged" "[.list // [] | .[] | select($closes)] | length" "$file")"
[[ "$n" -eq 0 ]] || update_json "$file" --argjson unflagged "$unflagged" ".list |= map(if $closes then .status = \"Assumed\" else . end)"
echo "$2: $n question$([[ "$n" -eq 1 ]] || echo s) closed as Assumed"
