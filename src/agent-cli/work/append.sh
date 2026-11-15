#!/usr/bin/env bash
# Description: Append to a report or change log in the ticket's work folder, the variation's own — work:append <project> <ticket-key> <variation|-> <name> [<file>], the content stdin's or <file>'s.
set -euo pipefail

# Adds stdin — or, given <file> (ASS-428, as work:write's ASS-298 form: a
# confined host agent can't pipe or redirect into agent.sh without
# re-sandboxing it, so it stages the entry in a temp file of its own and
# passes the path, the call a bare one), that file's content — and a newline
# when it ends without one, to the end of the file
# (work.bash work_file; made when missing) under <file>.lock — update_json's
# and append_line's lock — as one atomic replace (json-file.bash
# replace_file): appenders at once never interleave, and a reader never sees
# half an entry. Fails, adding nothing, on a refused name, a <file> that is no
# file, or nothing to add.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"

[[ $# -eq 4 || $# -eq 5 ]] || { echo "usage: work:append <project> <ticket-key> <variation|-> <name> [<file>] < content" >&2; exit 1; }
file="$(work_file work:append "$1" "$2" "$3" "$4")"
from=stdin
if [[ $# -eq 5 ]]; then
  from="$5"
  [[ -f "$from" ]] || { echo "work:append: no file $from: $file left as it was" >&2; exit 1; }
  exec < "$from"
fi
entry="$(cat; printf .)"
entry="${entry%.}"
[[ -n "$entry" ]] || { echo "work:append: nothing on $from: $file left as it was" >&2; exit 1; }
[[ "$entry" == *$'\n' ]] || entry+=$'\n'
lock_on 9 "$file.lock" work:append "${JSON_LOCK_TIMEOUT:-30}"
{ [[ ! -f "$file" ]] || cat "$file"; printf '%s' "$entry"; } | replace_file "$file" || { echo "work:append: the write failed: $file left as it was" >&2; exit 1; }
