#!/usr/bin/env bash
# Description: Delete every project's stopped VMs no variation in flight needs, least recently accessed first across all projects, until the volume holding LIMA_HOME is back above disk-free-warn-gb — vm:reclaim-all [--dry-run]; prints { dry-run, warn-bytes, free-bytes-before, free-bytes, deleted, short }.
set -euo pipefail

# ASS-288 AC3: control runs it, beside its tick, while the free space is below
# harness.json's disk-free-warn-gb (src/control/disk.js); see vm.bash
# reclaim_all. A running or in-flight VM is never touched. One at a time
# harness-wide: a second, while one runs (another control's), waits a second
# for its lock (vm-reclaim-all.lock beside harness.json), then does nothing and
# prints { skipped }. --dry-run deletes nothing, listing what it would.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 0 || ( $# -eq 1 && "$1" == --dry-run ) ]] || { echo "usage: vm:reclaim-all [--dry-run]" >&2; exit 1; }
if ! lock_on 6 "$disk_data_folder/vm-reclaim-all.lock" vm:reclaim-all 1 2>/dev/null; then
  jq -nc '{ skipped: "another vm:reclaim-all is running" }'
  exit 0
fi
reclaim_all vm:reclaim-all ${1:+dry-run}
