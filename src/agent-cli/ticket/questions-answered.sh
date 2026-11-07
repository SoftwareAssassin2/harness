#!/usr/bin/env bash
# Description: Whether every blocking question on a ticket has an accepted answer — ticket:questions-answered <project> <ticket-key>.
set -euo pipefail

# Reads the ticket's data/projects/<project>/work/<ticket>/questions-and-answers.json
# (its "list"). Prints { ticket, open } — the blocking questions not "Answer
# Accepted" — and exits 0 when there are none (no file is none), 1 otherwise.
# A non-blocking question (ASS-248: blocking false) never holds the ticket: it
# went on with its assumption. One with no flag, asked before it, counts.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 2 && "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "usage: ticket:questions-answered <project> <ticket-key>" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
file="$projects/$1/work/$key/questions-and-answers.json"
open=0
[[ -s "$file" ]] && open="$(jq '[.list // [] | .[] | select(.status != "Answer Accepted" and .blocking != false)] | length' "$file")"
jq -nc --arg t "$key" --argjson o "$open" '{ ticket: $t, open: $o }'
[[ "$open" -eq 0 ]]
