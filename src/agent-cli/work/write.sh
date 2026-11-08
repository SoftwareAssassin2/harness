#!/usr/bin/env bash
# Description: Write a report into the ticket's work folder, whole, the variation's own — work:write <project> <ticket-key> <variation|-> <name> [<file>], the content stdin's or <file>'s.
set -euo pipefail

# The file (work.bash work_file: <name>-<variation>.<ext>, or <name> for "-")
# becomes stdin — or, given <file> (ASS-298: a confined host agent can't pipe
# or redirect into agent.sh without re-sandboxing it, so it stages the content
# in a file of its own and passes the path, the call a bare one), that file's
# content — replacing what was there, under <file>.lock — update_json's
# lock — through a temp file renamed over it (json-file.bash replace_file),
# so a reader sees the old report or the new one, never half of one. Fails,
# writing nothing, on a refused name, a <file> that is no file, or nothing to
# write.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"

[[ $# -eq 4 || $# -eq 5 ]] || { echo "usage: work:write <project> <ticket-key> <variation|-> <name> [<file>] < content" >&2; exit 1; }
file="$(work_file work:write "$1" "$2" "$3" "$4")"
from=stdin
if [[ $# -eq 5 ]]; then
  from="$5"
  [[ -f "$from" ]] || { echo "work:write: no file $from: $file left as it was" >&2; exit 1; }
  exec < "$from"
fi
lock_on 9 "$file.lock" work:write "${JSON_LOCK_TIMEOUT:-30}"
replace_file "$file" || { echo "work:write: nothing on $from (or the write failed): $file left as it was" >&2; exit 1; }
