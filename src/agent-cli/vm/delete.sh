#!/usr/bin/env bash
# Description: Delete one of a project's stopped VMs whose variation is not in flight — vm:delete <project> <vm>; control deletes a VM once its variation reaches a `vm: released` step.
set -euo pipefail

# ASS-325: a VM at a step that needs none (QA) is deletable, yet was deleted
# only once a new VM was short of room (vm:create's make_room) or the volume
# was (vm:reclaim-all); a step that sets `vm: released` has control
# (src/control/vm-lifecycle.js) delete it at once, through this, so its disk
# goes back to the project's VM disk budget. Under the project's VM lock, the
# VM must be one of the project's (vm.bash reconcile_vms: in its inventory, or
# recorded on a variation of its active sprint), never a golden image or
# another project's, and deletable there, as make_room deletes one: stopped
# (control stops a running one first, vm:stop) and its variation not in
# flight — gone, set aside, or at a step that sets no `vm` or `released`;
# never one at a `running` or `stopped` step. Deleted as make_room deletes
# one (delete_vm): limactl delete, its vms.json row and forwarder token
# dropped. Fails, naming why, otherwise.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 2 ]] || { echo "usage: vm:delete <project> <vm>" >&2; exit 1; }
project="$1" vm="$2"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$project/project.json" ]] || { echo "vm:delete: no project '$project'" >&2; exit 1; }
lock_vms vm:delete "$project"
entry="$(reconcile_vms vm:delete "$project" | jq -r --arg n "$vm" 'first(.vms[] | select(.name == $n) | [.state, .deletable] | @tsv) // empty')"
[[ -n "$entry" ]] || { echo "vm:delete: $vm is not one of $project's VMs" >&2; exit 1; }
IFS=$'\t' read -r state deletable <<<"$entry"
[[ "$state" != Running ]] || { echo "vm:delete: $vm is running: vm:stop it first" >&2; exit 1; }
[[ "$deletable" == true ]] || { echo "vm:delete: $vm's variation is in flight (at a step whose vm is running or stopped)" >&2; exit 1; }
delete_vm vm:delete "$project" "$vm"
