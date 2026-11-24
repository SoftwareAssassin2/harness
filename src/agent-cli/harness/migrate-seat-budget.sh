#!/usr/bin/env bash
# Description: One-off migration from seat counts to the seat budget (ASS-528): seats come from the Mac's memory and CPU budget (harness.json's max-memory-percent and max-cpu-percent, 90 and 90 by default), each project taking its share — project.json's `share`, a percentage of the budget set with project:set-share (unset: an equal split of what the set shares leave); workstations and cloud VMs by their own max-memory-percent / max-cpu-percent in dev-environments (machine:set-limits). Removes max-tickets-in-progress and max-tickets-in-planning from harness.json and every project.json and adds the default budget — harness:migrate-seat-budget [--dry-run]; prints each change. The footer shows each budget, share, allotment and use (ASS-530).
set -euo pipefail

# ASS-528: seats come from the Mac's memory and CPU budget, shared between
# projects by percentage (src/control/seat-budget.js), so the seat counts
# max-tickets-in-progress and max-tickets-in-planning are no longer read.
# This removes them from harness.json (HARNESS_FILE overrides it) and from
# each data/projects/<p>/project.json (PROJECTS_DIR overrides the folder),
# and gives harness.json the default budget where it has none:
# max-memory-percent 90 and max-cpu-percent 90 (operator decision,
# 2026-11-22; a value already there is kept). Every other setting is kept,
# max-tickets-ready-for-build included. Each file is rewritten whole through
# update_json (under its lock, a temp file renamed over it), and only when
# something in it changes, so running it again changes nothing. Prints one
# line per file changed, naming what was removed (with its old value) and
# added, or that nothing needed changing; with --dry-run, prints the same
# and writes nothing. Fails, writing nothing more, on a file that is not
# valid JSON.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
harness_file="${HARNESS_FILE:-$here/../../../data/harness.json}"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"
command=harness:migrate-seat-budget

dry=0
case "${1:-}" in
  --dry-run) dry=1; shift ;;
  '') ;;
  *) echo "usage: $command [--dry-run]" >&2; exit 1 ;;
esac
[[ $# -eq 0 ]] || { echo "usage: $command [--dry-run]" >&2; exit 1; }

# The filters: the seat counts removed; for harness.json the default budget added where unset.
remove='del(.["max-tickets-in-progress"], .["max-tickets-in-planning"])'
budget='| (if has("max-memory-percent") then . else .["max-memory-percent"] = 90 end) | (if has("max-cpu-percent") then . else .["max-cpu-percent"] = 90 end)'

# changes <file> <filter> — what the filter would change in <file>, in words ("" for nothing).
changes() {
  jq -r --argjson after "$(jq -c "$2" "$1")" '
    . as $before
    | ([("max-tickets-in-progress", "max-tickets-in-planning") as $k | select($before | has($k)) | "removed \($k) (\($before[$k] | tojson))"]
       + [("max-memory-percent", "max-cpu-percent") as $k | select(($before | has($k) | not) and ($after | has($k))) | "added \($k) \($after[$k])"])
    | join(", ")' "$1"
}

# migrate <file> <filter> <label> — the file changed (unless --dry-run) when the filter changes it, said either way.
migrate() {
  local what
  jq empty "$1" 2>/dev/null || { echo "$command: $1 is not valid JSON; nothing written to it" >&2; exit 1; }
  what="$(changes "$1" "$2")"
  if [[ -z "$what" ]]; then echo "$3: nothing to change"; return; fi
  [[ $dry -eq 1 ]] || update_json "$1" "$2"
  echo "$3: $what$([[ $dry -eq 1 ]] && echo ' (dry run: not written)')"
}

[[ -f "$harness_file" ]] || { echo "$command: no harness.json at $harness_file" >&2; exit 1; }
migrate "$harness_file" "$remove $budget" harness.json
if [[ -d "$projects" ]]; then
  for file in "$projects"/*/project.json; do
    [[ -e "$file" ]] || continue
    migrate "$file" "$remove" "projects/$(basename "$(dirname "$file")")/project.json"
  done
fi
