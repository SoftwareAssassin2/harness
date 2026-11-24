#!/usr/bin/env bash
# Description: Set the harness-wide budget, how much of the Mac's memory and CPU the harness may use (ASS-528; 90 and 90 by default), each 1–100, in data/harness.json — harness:set-budget [--memory <percent>] [--cpu <percent>].
set -euo pipefail

# ASS-546 AC4: writes data/harness.json's max-memory-percent (--memory)
# and max-cpu-percent (--cpu), each a number from 1 to 100 (HARNESS_FILE
# overrides the file, used by tests). Seats on the Mac come from this budget,
# shared between the projects by their `share` (src/control/seat-budget.js);
# it is also the limit of a workstation or cloud VM without its own
# (machine:set-limits). At least one option is needed. Control rereads
# harness.json every tick. harness.json.lock is held from the read to the
# write (seat-settings.bash). Prints "harness budget: <field> <before> →
# <after>…" ("90 (default)" for an unset one). Fails, writing nothing, on a
# bad option or value.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../seat-settings.bash"
harness_file="${HARNESS_FILE:-$here/../../../data/harness.json}"

command=harness:set-budget
usage="usage: $command [--memory <percent>] [--cpu <percent>]"
[[ $# -ge 2 ]] || { echo "$usage" >&2; exit 1; }
memory='' cpu=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --memory) [[ $# -ge 2 ]] || { echo "$usage" >&2; exit 1; }; ss_percent "$command" "--memory" "$2" 1; memory="$2"; shift 2 ;;
    --cpu) [[ $# -ge 2 ]] || { echo "$usage" >&2; exit 1; }; ss_percent "$command" "--cpu" "$2" 1; cpu="$2"; shift 2 ;;
    *) echo "$usage" >&2; exit 1 ;;
  esac
done

ss_lock "$command" "$harness_file"
# The defaults (seat-budget.js DEFAULT_BUDGET) are shown for an unset one.
before="$(jq -c '{ "max-memory-percent": (."max-memory-percent" // null), "max-cpu-percent": (."max-cpu-percent" // null) }' "$file")"
edit='(if $memory == "" then . else .["max-memory-percent"] = ($memory | tonumber) end)
  | (if $cpu == "" then . else .["max-cpu-percent"] = ($cpu | tonumber) end)'
write_json "$file" --arg memory "$memory" --arg cpu "$cpu" "$edit"
after="$(jq -c --arg memory "$memory" --arg cpu "$cpu" "$edit" <<< "$before")"
exec 9>&-
echo "harness budget: $(jq -r -n --argjson b "$before" --argjson a "$after" '
  [("max-memory-percent", "max-cpu-percent") as $f | select($b[$f] != $a[$f]) | "\($f) \($b[$f] // "90 (default)") → \($a[$f])"]
  | if length == 0 then "unchanged" else join(", ") end')"
