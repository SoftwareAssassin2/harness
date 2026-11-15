#!/usr/bin/env bash
# Description: Run a script file in a ticket variation's VM, from the Mac, for Blocked's Repair the VM — vm:run <project> <ticket-key> <variation> <script-file>; exits with the script's exit code.
set -euo pipefail

# ASS-427 AC1: grouped-blocked's Repair the VM is a confined host agent (it
# writes the VM's source too: the golden image definition, a VM-setup
# declaration), and fixes the ticket's VM in place through this: the script
# file (one it wrote in a temp folder of its own: a bare agent.sh call, never
# a pipe or redirect, ASS-428) runs in the variation's own VM, recorded on the
# variation (ticket:set-vm) — never another ticket's, a golden image or the
# Mac — as the VM's user, through `limactl shell <vm> -- bash -s` (the
# machine layer's machine_run, ASS-432), the script
# on stdin, so its login shell has the VM's credentials and sudo as a VM
# agent has. The VM may still be starting (the step after Classify, which
# stops it, runs it again: vm-lifecycle.js): it is waited for, up to
# VM_RUN_WAIT_SECONDS (180), to be Running and reachable. The script runs for
# at most VM_RUN_TIMEOUT_SECONDS (1800). Its output is printed as it is; the
# script and its exit are logged in the variation's change log (work.bash
# blocked_log, "Repair the VM"). Exits: the script's own exit code (124 when
# it timed out); 3 when the variation has no VM, or it is not running and
# reachable by the end of the wait — nothing run; 1 on bad arguments, an
# unknown ticket or variation, or a script file that is missing or empty.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/work.bash"

command=vm:run title="Repair the VM"
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <script-file>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3" file="$4"
variation_exists "$command" "$project" "$key" "$variation"
[[ -f "$file" && -s "$file" ]] || { echo "$command: no script file $file (or it is empty): nothing run" >&2; exit 1; }
vm="$(recorded_vm "$command" "$project" "$key" "$variation" 2>/dev/null)" \
  || { echo "$command: $key $variation has no VM yet: nothing to fix in place" >&2; exit 3; }

wait="${VM_RUN_WAIT_SECONDS:-180}" waited=0
until [[ "$(machine_status "$vm" 2>/dev/null)" == Running ]] && machine_run --workdir / "$vm" -- true >/dev/null 2>&1; do
  if (( waited >= wait )); then
    blocked_log "$project" "$key" "$variation" "$title" "vm:run: $vm was not running and reachable after ${wait}s: nothing run."
    echo "$command: $vm is not running and reachable after ${wait}s: nothing run" >&2
    exit 3
  fi
  sleep 2; waited=$((waited + 2))
done

code=0
output="$(machine_run --timeout "${VM_RUN_TIMEOUT_SECONDS:-1800}" --workdir / "$vm" -- bash -s < "$file" 2>&1)" || code=$?
[[ $code -ne 142 ]] || code=124
printf '%s\n' "$output"
blocked_log "$project" "$key" "$variation" "$title" "vm:run in $vm: exit $code. The script:"$'\n```bash\n'"$(head -c 4000 "$file")"$'\n```\n'"Its last lines:"$'\n```\n'"$(tail -n 20 <<< "$output" | cut -c 1-300)"$'\n```'
exit $code
