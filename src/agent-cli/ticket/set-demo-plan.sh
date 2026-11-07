#!/usr/bin/env bash
# Description: Record a ticket variation's demo plan, the JSON on stdin — ticket:set-demo-plan <project> <ticket-key> <variation>.
set -euo pipefail

# Write Test Plan records the demo plan (ASS-180) into the ticket's folder,
# data/projects/<project>/work/<KEY>/demo-plan-<variation>.json, a WORK_MANAGED
# file work:write will not touch. Stdin, one JSON value, must pass the same
# validation ticket:demo-plan uses (demo-plan.jq). It is stored verbatim (byte
# for byte, not demo-plan.sh's reformatted output), under the file's lock,
# through a temp file renamed over it (json-file.bash replace_file). Fails,
# writing nothing, on an invalid path or input.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../work.bash"

command=ticket:set-demo-plan
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation> < json" >&2; exit 1; }
file="$(work_path "$command" "$1" "$2" "$3" "demo-plan-$3.json")"

input="$(cat; echo x)"; input="${input%x}"
{ printf '%s' "$input" | jq -se 'length == 1' >/dev/null 2>&1 \
  && printf '%s' "$input" | jq -e -f "$here/../demo-plan.jq" >/dev/null 2>&1; } \
  || { echo "$command: $(basename "$file") must hold { demo: true, setup, ready-check, view: { with: browser, address | terminal, commands | other, how }, look-at } or { demo: false, why }: $(basename "$file") left as it was" >&2; exit 1; }

lock_on 9 "$file.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}" || { echo "$command: $(basename "$file") left as it was" >&2; exit 1; }
printf '%s' "$input" | replace_file "$file" || { echo "$command: the write failed: $(basename "$file") left as it was" >&2; exit 1; }
