#!/usr/bin/env bash
# Description: Read the free space on the volumes holding LIMA_HOME and the data folder, and record it against harness.json's disk-free-warn-gb and disk-free-hold-gb — harness:check-disk-space [--report <project> <run>]; prints what it recorded.
set -euo pipefail

# ASS-288. df for the volume holding LIMA_HOME (the VMs, lima-home.bash) and
# for the one holding the data folder (harness.json's), one entry per volume
# (both folders on one volume share it), the least free deciding the level:
#   hold — below disk-free-hold-gb; or held already and not yet back above
#          disk-free-warn-gb: control starts no agent, VM, clone or golden
#          build until it is (src/control/disk.js);
#   warn — below disk-free-warn-gb: control reclaims VMs (vm:reclaim-all), the
#          dashboard and the health check say so;
#   ok   — at or above it: nothing is shown.
# GB are 10^9 bytes (as vm-disk-limit-gb); 50 and 15 without the keys. Writes
# { as-of, level, free-bytes, warn-bytes, hold-bytes, held-since, volumes:
# [{ mount, free-bytes, paths }] } to disk-space.json beside harness.json
# (DISK_SPACE_FILE overrides it) — live data, under its lock, the previous
# level read in the same write so every control agrees on the hold — and
# prints it. Control runs it at most once a minute. With --report (the health
# check's step, engines/check-health-v2), below the warn level it also writes
# disk.md in the run's folder (data/projects/<project>/work/run-<root run>),
# beside the health check's other reports; at or above it, nothing. Fails,
# writing nothing, when df cannot be read or the thresholds are bad.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../lima-home.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../disk.bash"
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"
assignments_file="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"
command=harness:check-disk-space

usage() { echo "usage: $command [--report <project> <run>]" >&2; exit 1; }
report_project="" report_run=""
if [[ $# -gt 0 ]]; then
  [[ $# -eq 3 && "$1" == --report ]] || usage
  [[ "$2" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$2/project.json" ]] || { echo "$command: no project '$2'" >&2; exit 1; }
  [[ "$3" =~ ^[0-9a-f-]+$ ]] || { echo "$command: invalid run '$3'" >&2; exit 1; }
  report_project="$2" report_run="$3"
fi

read -r warn hold < <(disk_levels "$command") || exit 1
[[ -n "${warn:-}" ]] || exit 1
lima="$(lima_home)"
volumes="[]"
for path in "$lima" "$disk_data_folder"; do
  line="$(volume_of "$path" 2>&1)" || { echo "$command: $line" >&2; exit 1; }
  IFS=$'\t' read -r free mount <<<"$line"
  volumes="$(jq -c --arg m "$mount" --argjson f "$free" --arg p "$path" '
    if any(.[]; .mount == $m) then map(if .mount == $m then .paths += [$p] else . end) else . + [{ mount: $m, "free-bytes": $f, paths: [$p] }] end' <<<"$volumes")"
done

update_json --create "$disk_space_file" --argjson v "$volumes" --argjson warn "$warn" --argjson hold "$hold" '
  (.level // "ok") as $was | (.["held-since"] // null) as $since
  | ($v | map(.["free-bytes"]) | min) as $free
  | (if $free < $hold or ($was == "hold" and $free < $warn) then "hold" elif $free < $warn then "warn" else "ok" end) as $level
  | { "as-of": (now | floor | todate), level: $level, "free-bytes": $free, "warn-bytes": $warn, "hold-bytes": $hold,
      "held-since": (if $level != "hold" then null elif $was == "hold" and $since != null then $since else (now | floor | todate) end),
      volumes: $v }'
record="$(jq -c . "$disk_space_file")"

if [[ -n "$report_project" && "$(jq -r .level <<<"$record")" != ok ]]; then
  root="$(jq -r --arg id "$report_run" '."transient-state-engines" // [] | . as $runs
    | def up($r): (first($runs[] | select(.id == $r.parent["transient-state-engine"])) // null) as $p | if $p == null then $r.id else up($p) end;
    (first(.[] | select(.id == $id)) // null) as $r | if $r == null then $id else up($r) end' "$assignments_file" 2>/dev/null || echo "$report_run")"
  folder="$projects/$report_project/work/run-$root"
  mkdir -p "$folder"
  lock_on 9 "$folder/disk.md.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}"
  jq -r --arg free "$(gib "$(jq '.["free-bytes"]' <<<"$record")")" '
    def gb: . / 1e9 | tostring;
    def gib: . / 1073741824 * 10 | round / 10 | tostring | if test("\\.") then . else . + ".0" end;
    "# Disk space\n\n"
    + "Free space is below the warning level: \($free) GiB free on the fullest volume (warning below \(.["warn-bytes"] | gb) GB, harness.json disk-free-warn-gb; work held below \(.["hold-bytes"] | gb) GB, disk-free-hold-gb).\n"
    + (if .level == "hold" then "\nWork is held: control starts no agent, VM, clone or golden build until the free space is back above the warning level.\n" else "" end)
    + "\n" + (.volumes | map("- \(.mount): \(.["free-bytes"] | gib) GiB free (holds \(.paths | join(", ")))") | join("\n")) + "\n"
    + "\nControl deletes the stopped VMs no ticket needs (vm:reclaim-all), least recently accessed first across every project, by itself; what it cannot free (other files on the volume) needs the operator.\n"' <<<"$record" \
    | replace_file "$folder/disk.md"
  exec 9>&-
fi
echo "$record"
