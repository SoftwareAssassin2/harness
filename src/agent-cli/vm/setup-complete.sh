#!/usr/bin/env bash
# Description: Whether a ticket variation's Setup is complete — vm:setup-complete <project> <ticket-key> <variation>; exits 0 when its VM holds the setup-complete marker, 1 when not.
set -euo pipefail

# The Setup group's first step (ASS-68 AC7) asks this: the VM recorded on
# the variation (vm:create, ticket:set-vm) runs and holds the marker
# (vm.bash $setup_marker) vm:mark-setup-complete wrote once every setup step
# had succeeded. No VM, one not running, or no marker — a setup that stopped
# part way — is not complete, and Setup runs again from its start, each of
# its steps idempotent. Never starts the VM; prints nothing. Fails (exit 1
# too, with a message) on an unknown variation.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 3 ]] || { echo "usage: vm:setup-complete <project> <ticket-key> <variation>" >&2; exit 1; }
variation_exists vm:setup-complete "$@"
vm="$(running_vm vm:setup-complete "$@" 2>/dev/null)" || exit 1
limactl shell --workdir / "$vm" -- bash -c 'test -e "${HARNESS_VM_ROOT-}$1"' - "$setup_marker"
