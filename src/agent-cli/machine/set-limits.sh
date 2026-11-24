#!/usr/bin/env bash
# Description: Set or clear how much of a workstation or cloud VM the harness may use, its own max-memory-percent / max-cpu-percent (1–100; unset: harness.json's) and its disk hold (ASS-557: disk-free-hold-gb / disk-free-warn-gb, GB; unset: harness.json's) — machine:set-limits <project> <machine-id> [--memory <percent>] [--cpu <percent>] [--disk-hold <gb>] [--disk-warn <gb>] [--clear].
set -euo pipefail

# ASS-546 AC2: edits the entry with id <machine-id> in
# data/projects/<project>/project.json's dev-environments — its workstations
# or its cloud-vms (ids are unique across the two) — the per-machine limits
# ASS-529 added (remote-seats.js admits another ticket on the machine while
# its measured use plus one more stays under them). PROJECTS_DIR overrides
# the projects folder, used by tests. --memory and --cpu set
# max-memory-percent and max-cpu-percent, each a number from 1 to 100;
# --clear removes both first, so `--clear` alone puts the machine back on
# harness.json's limits and `--clear --cpu 50` leaves only its CPU limit.
# ASS-557: --disk-hold and --disk-warn set disk-free-hold-gb and
# disk-free-warn-gb, positive numbers of GB (10^9 bytes): below the hold the
# machine takes no new ticket (remote-seats.js), until its disk is back above
# the warn level; the hold may not be above the warn once both are set.
# --clear removes these too. At least one option is needed. Control rereads project.json every tick.
# project.json.lock is held from the read to the write (seat-settings.bash).
# Prints "<project>: <workstation|cloud VM> <id>: <field> <before> → <after>…"
# for each limit, "unchanged" when nothing changes. Fails, writing nothing,
# on an unknown project, an unknown machine id (naming the project's
# machines), or a bad option or value.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../seat-settings.bash"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"

command=machine:set-limits
usage="usage: $command <project> <machine-id> [--memory <percent>] [--cpu <percent>] [--disk-hold <gb>] [--disk-warn <gb>] [--clear]"
[[ $# -ge 3 ]] || { echo "$usage" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
project="$1" id="$2"
shift 2
memory='' cpu='' hold='' warn='' clear=false
gb_value() { [[ "$2" =~ ^(0|[1-9][0-9]*)(\.[0-9]+)?$ && "$(jq -n --argjson v "$2" '$v > 0')" == true ]] || { echo "$command: $1 must be a positive number of GB, got '$2'" >&2; exit 1; }; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --memory) [[ $# -ge 2 ]] || { echo "$usage" >&2; exit 1; }; ss_percent "$command" "--memory" "$2" 1; memory="$2"; shift 2 ;;
    --cpu) [[ $# -ge 2 ]] || { echo "$usage" >&2; exit 1; }; ss_percent "$command" "--cpu" "$2" 1; cpu="$2"; shift 2 ;;
    --disk-hold) [[ $# -ge 2 ]] || { echo "$usage" >&2; exit 1; }; gb_value --disk-hold "$2"; hold="$2"; shift 2 ;;
    --disk-warn) [[ $# -ge 2 ]] || { echo "$usage" >&2; exit 1; }; gb_value --disk-warn "$2"; warn="$2"; shift 2 ;;
    --clear) clear=true; shift ;;
    *) echo "$usage" >&2; exit 1 ;;
  esac
done

ss_lock "$command" "$projects/$project/project.json"
# Where the machine is: "workstations" or "cloud-vms" (the first list that has it).
list="$(jq -r --arg id "$id" '."dev-environments" // {} | if type != "object" then empty else
  ([("workstations", "cloud-vms") as $l | select((.[$l] | type) == "array" and any(.[$l][]; type == "object" and .id == $id)) | $l] | first // empty) end' "$file")"
if [[ -z "$list" ]]; then
  known="$(jq -r '."dev-environments" // {} | if type != "object" then "" else [(.workstations, ."cloud-vms") | arrays | .[] | objects | .id | strings] | join(", ") end' "$file")"
  echo "$command: $project has no workstation or cloud VM '$id' (it has: ${known:-none}); nothing written" >&2
  exit 1
fi

edit='(if $clear then del(.["max-memory-percent"], .["max-cpu-percent"], .["disk-free-hold-gb"], .["disk-free-warn-gb"]) else . end)
  | (if $memory == "" then . else .["max-memory-percent"] = ($memory | tonumber) end)
  | (if $cpu == "" then . else .["max-cpu-percent"] = ($cpu | tonumber) end)
  | (if $hold == "" then . else .["disk-free-hold-gb"] = ($hold | tonumber) end)
  | (if $warn == "" then . else .["disk-free-warn-gb"] = ($warn | tonumber) end)'
before="$(jq -c --arg l "$list" --arg id "$id" '."dev-environments"[$l][] | select(type == "object" and .id == $id)' "$file" | head -1)"
after="$(jq -c --argjson clear "$clear" --arg memory "$memory" --arg cpu "$cpu" --arg hold "$hold" --arg warn "$warn" "$edit" <<< "$before")"
if [[ "$(jq '(.["disk-free-hold-gb"] != null and .["disk-free-warn-gb"] != null and .["disk-free-hold-gb"] > .["disk-free-warn-gb"])' <<< "$after")" == true ]]; then
  echo "$command: $id's disk-free-hold-gb would be above its disk-free-warn-gb; nothing written" >&2; exit 1
fi
write_json "$file" --arg l "$list" --arg id "$id" --argjson clear "$clear" --arg memory "$memory" --arg cpu "$cpu" --arg hold "$hold" --arg warn "$warn" \
  "(.\"dev-environments\"[\$l][] | select(type == \"object\" and .id == \$id)) |= ($edit)"
exec 9>&-

kind="$([[ "$list" == workstations ]] && echo workstation || echo 'cloud VM')"
changes="$(jq -r -n --argjson b "$before" --argjson a "$after" '
  [("max-memory-percent", "max-cpu-percent", "disk-free-hold-gb", "disk-free-warn-gb") as $f | select($b[$f] != $a[$f])
   | "\($f) \($b[$f] // "unset") → \($a[$f] // "unset")"] | if length == 0 then "unchanged" else join(", ") end')"
echo "$project: $kind $id: $changes"
