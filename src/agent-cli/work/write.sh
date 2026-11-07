#!/usr/bin/env bash
# Description: Write a report into the ticket's work folder, stdin whole, the variation's own — work:write <project> <ticket-key> <variation|-> <name> < content.
set -euo pipefail

# The file (work.bash work_file: <name>-<variation>.<ext>, or <name> for "-")
# becomes stdin, replacing what was there, under <file>.lock — update_json's
# lock — through a temp file renamed over it (json-file.bash replace_file),
# so a reader sees the old report or the new one, never half of one. Fails,
# writing nothing, on a refused name or nothing on stdin.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"

[[ $# -eq 4 ]] || { echo "usage: work:write <project> <ticket-key> <variation|-> <name> < content" >&2; exit 1; }
file="$(work_file work:write "$@")"
lock_on 9 "$file.lock" work:write "${JSON_LOCK_TIMEOUT:-30}"
replace_file "$file" || { echo "work:write: nothing on stdin (or the write failed): $file left as it was" >&2; exit 1; }
