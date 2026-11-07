#!/usr/bin/env bash
# Description: Append stdin to a report or change log in the ticket's work folder, the variation's own — work:append <project> <ticket-key> <variation|-> <name> < content.
set -euo pipefail

# Adds stdin, and a newline when it ends without one, to the end of the file
# (work.bash work_file; made when missing) under <file>.lock — update_json's
# and append_line's lock — as one atomic replace (json-file.bash
# replace_file): appenders at once never interleave, and a reader never sees
# half an entry. Fails, adding nothing, on a refused name or nothing on stdin.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"

[[ $# -eq 4 ]] || { echo "usage: work:append <project> <ticket-key> <variation|-> <name> < content" >&2; exit 1; }
file="$(work_file work:append "$@")"
entry="$(cat; printf .)"
entry="${entry%.}"
[[ -n "$entry" ]] || { echo "work:append: nothing on stdin: $file left as it was" >&2; exit 1; }
[[ "$entry" == *$'\n' ]] || entry+=$'\n'
lock_on 9 "$file.lock" work:append "${JSON_LOCK_TIMEOUT:-30}"
{ [[ ! -f "$file" ]] || cat "$file"; printf '%s' "$entry"; } | replace_file "$file" || { echo "work:append: the write failed: $file left as it was" >&2; exit 1; }
