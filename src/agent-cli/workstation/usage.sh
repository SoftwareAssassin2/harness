#!/usr/bin/env bash
# Description: Measure a project's workstation's or cloud VM's memory, CPU and disk (the folder its tickets' work lives in) over its open SSH connection and record them — workstation:usage <project> <id>; prints its usage.
set -euo pipefail

# ASS-529 AC1: a remote machine takes as many of its project's tickets as its
# own memory and CPU allow (src/control/remote-seats.js), so control's
# workstation job runs this once a minute while the machine is connected and
# needed. In one session over the machine's connection (a session of its own
# over the master; nothing is installed there): /proc/meminfo's MemTotal and
# MemAvailable (a container's cgroup memory.max and memory.current instead
# when it is limited below them), the core count (nproc), and two /proc/stat samples a second
# apart — the machine's busy share of every core, as percent of one core (4
# cores all busy: 400). Recorded on its live data (workstations.json) as
# `usage` { at, memory: { total-bytes, available-bytes }, cpu: { cores,
# samples: [{ at, percent }] — the last USAGE_SAMPLES, which control averages
# over 5 minutes }, error: null }, and printed. With no connection open: 255,
# nothing recorded (the machine is not measured; control keeps it at the seats
# it holds, at least one). A reading that fails over an open connection is
# recorded as usage.error { at, message } (the samples kept) and fails (1):
# control then gives the machine no new ticket until a reading works.
# WORKSTATION_PROC_ROOT (the tests') reads another folder than /proc.
# ASS-557 AC1: in the same session, the disk its tickets' work lives on — df -kP
# of ~/harness (wsv_root: the slots' root; the user's home before the first
# setup made it): on a Cloud Workstation /home, its only persistent disk; on a
# cloud VM its root (or data) disk. Recorded beside memory and CPU as
# usage.disk { folder, total-bytes, used-bytes, available-bytes } (null when df
# cannot read it: memory and CPU still count, and remote-seats.js holds no
# work for a disk it cannot see). Under WORKSTATION_PROC_ROOT the fake's `df`
# file (df -kP's output) stands in for df.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../workstation.bash"

command=workstation:usage
[[ $# -eq 2 ]] || { echo "usage: $command <project> <id>" >&2; exit 1; }
project="$1" id="$2"
workstation_settings "$command" "$project" "$id" >/dev/null
keep="${USAGE_SAMPLES:-5}"

workstation_alive "$project" "$id" || { echo "$command: $project's machine $id has no open connection (workstation:connect); not measured" >&2; exit 255; }

# shellcheck disable=SC2016
read_usage='set -eu; p="${1:-/proc}"
total=$(awk "/^MemTotal:/ { print \$2 * 1024 }" "$p/meminfo"); avail=$(awk "/^MemAvailable:/ { print \$2 * 1024 }" "$p/meminfo")
if [ "$p" = /proc ] && command -v nproc >/dev/null; then cores=$(nproc); else cores=$(grep -c "^processor" "$p/cpuinfo"); fi
# A container (a Cloud Workstation is one) limited below the host: its cgroup v2 limit and use instead.
m=/sys/fs/cgroup/memory.max; c=/sys/fs/cgroup/memory.current
if [ "$p" = /proc ] && [ -r "$m" ] && [ -r "$c" ] && lim=$(cat "$m") && [ "$lim" != max ] && [ "$lim" -lt "$total" ]; then total=$lim; avail=$((lim - $(cat "$c"))); fi
# ASS-557: the disk the work lives on, df -kP (under another root its df file): total, used, available.
d="$HOME/harness"; [ -d "$d" ] || d="$HOME"
if [ "$p" = /proc ]; then disk=$(df -kP "$d" 2>/dev/null | awk "NR == 2 { printf \"%.0f %.0f %.0f\", \$2 * 1024, \$3 * 1024, \$4 * 1024 }" || true)
elif [ -r "$p/df" ]; then disk=$(awk "NR == 2 { printf \"%.0f %.0f %.0f\", \$2 * 1024, \$3 * 1024, \$4 * 1024 }" "$p/df"); else disk=""; fi
a=$(head -n 1 "$p/stat"); sleep "${2:-1}"; b=$(head -n 1 "$p/stat")
printf "%s %s %s %s\n%s\n%s\n%s\n" "$total" "$avail" "$cores" "${disk:-0 0 0}" "$a" "$b" "$d"'
if ! out="$(ws_timeout "${WORKSTATION_PROBE_SECONDS:-20}" bash -c "source '$here_ws/workstation.bash' && workstation_ssh \"\$@\"" _ "$project" "$id" bash -c "$read_usage" harness-usage "${WORKSTATION_PROC_ROOT:-/proc}" "${WORKSTATION_USAGE_SAMPLE_SECONDS:-1}" </dev/null 2>&1)" \
  || ! usage="$(awk -v keep="$keep" 'NR == 1 { total = $1; avail = $2; cores = $3; dt = $4; du = $5; da = $6 }
      NR == 2 || NR == 3 { busy = 0; all = 0; for (i = 2; i <= NF; i++) { all += $i; if (i != 5 && i != 6) busy += $i }; b[NR] = busy; t[NR] = all }
      END {
        if (NR < 3 || total <= 0 || cores <= 0 || t[3] < t[2]) exit 1
        disk = dt > 0 ? sprintf("{\"total\":%.0f,\"used\":%.0f,\"available\":%.0f}", dt, du, da) : "null"
        printf "{\"total\":%d,\"available\":%d,\"cores\":%d,\"percent\":%.1f,\"disk\":%s}\n", total, avail, cores, (t[3] > t[2] ? (b[3] - b[2]) / (t[3] - t[2]) * cores * 100 : 0), disk
      }' <<< "$out")"; then
  message="$(tail -n 1 <<< "$out" | cut -c1-200)"
  workstation_alive "$project" "$id" || { echo "$command: $project's machine $id: its connection closed while it was measured; not measured" >&2; exit 255; }
  workstation_record "$project" "$id" --arg m "its memory and CPU could not be read: ${message:-no output}" '.usage = ((.usage // {}) + { error: { at: $at, message: $m } })'
  echo "$command: $project's machine $id: its memory and CPU could not be read: ${message:-no output}" >&2
  exit 1
fi
folder="$(sed -n 4p <<< "$out")"
workstation_record "$project" "$id" --argjson u "$usage" --argjson keep "$keep" --arg folder "$folder" '
  .usage = { at: $at, memory: { "total-bytes": $u.total, "available-bytes": $u.available },
             cpu: { cores: $u.cores, samples: (((.usage.cpu.samples // []) + [{ at: $at, percent: $u.percent }]) | .[-$keep:]) },
             disk: (if $u.disk then { folder: $folder, "total-bytes": $u.disk.total, "used-bytes": $u.disk.used, "available-bytes": $u.disk.available } else null end), error: null }'
workstation_entry "$project" "$id" | jq -c '{ id, usage }'
