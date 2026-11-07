#!/usr/bin/env bash
# Description: Stop one of a project's VMs — vm:stop <project> <vm>; control stops a VM its variation no longer needs running.
set -euo pipefail

# ASS-75: the VM must be one of the project's (vm.bash reconcile_vms: in its
# inventory, or recorded on a variation of its active sprint), never a golden
# image or another project's. A running one is stopped (`limactl stop`) and
# recorded in the inventory, accessed now; one stopped already is left as it
# is. Under the project's VM lock. Fails, naming why, otherwise.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 2 ]] || { echo "usage: vm:stop <project> <vm>" >&2; exit 1; }
project="$1" vm="$2"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$project/project.json" ]] || { echo "vm:stop: no project '$project'" >&2; exit 1; }
lock_vms vm:stop "$project"
entry="$(reconcile_vms vm:stop "$project" | jq -r --arg n "$vm" 'first(.vms[] | select(.name == $n) | [.state, .ticket, .variation] | @tsv) // empty')"
[[ -n "$entry" ]] || { echo "vm:stop: $vm is not one of $project's VMs" >&2; exit 1; }
IFS=$'\t' read -r state key variation <<<"$entry"
[[ "$state" == Running ]] || exit 0
limactl stop "$vm" >/dev/null 2>&1 || { echo "vm:stop: $vm would not stop (see $LIMA_HOME/$vm/ha.stderr.log)" >&2; exit 1; }
record_vm "$project" "$vm" "$key" "$variation" Stopped
