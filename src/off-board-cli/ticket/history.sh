#!/usr/bin/env bash
# Description: Print off-board tickets' status histories — ticket:history <project> [<key>].
set -euo pipefail

# Prints each ticket's status history (ASS-413), <KEY>.history.json beside
# its file (see ticket.bash): { key, "status-changes": [ { at, from, to }… ] }.
# With a key, that ticket's; without, an array of every ticket's in the
# project's folder, in key-number order ([] when the folder is empty or
# missing) — the downloader's analytics step reads it each cycle. A ticket
# with no history file is backfilled first, under the store lock: Backlog at
# its created, then its current status at its updated when that differs, each
# entry "backfilled": true. A malformed ticket file is skipped with a warning
# on stderr when listing all. Fails when the project is missing or has no
# off-board work source, or the key names no ticket.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 1 || $# -eq 2 ]] || { echo "usage: ticket:history <project> [<key>]" >&2; exit 1; }

if [[ $# -eq 2 ]]; then
  file="$(ticket_file ticket:history "$1" "$2")"
  ensure_history ticket:history "$file"
  jq '.' "$(history_file "$file")"
  exit 0
fi

folder="$(ticket_folder ticket:history "$1")"
while read -r file; do
  if ensure_history ticket:history "$file"; then cat "$(history_file "$file")"
  else echo "ticket:history: skipping $file" >&2
  fi
done < <(ticket_files "$folder") | jq -s '.'
