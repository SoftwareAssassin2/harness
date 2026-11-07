#!/usr/bin/env bash
# Description: Mark a ticket variation's Setup complete — vm:mark-setup-complete <project> <ticket-key> <variation>; writes the setup-complete marker in its VM.
set -euo pipefail

# The Setup group's last step (ASS-68 AC7), reached only once every setup
# step before it has succeeded: the marker (vm.bash $setup_marker) written
# in the running VM recorded on the variation, so the next entry to Setup
# (vm:setup-complete) leaves it at once. First it proves the VM can run an
# agent (ASS-234): claude on its PATH (`command -v claude`, as an agent's
# command finds it), vm:start's /run/harness/agent-url and vm:credentials'
# /run/harness/env; any missing fails it, naming each, with no marker
# written, so the ticket stays in Setup. Fails, naming why, too when the
# variation has no VM, it is not running, or the marker cannot be written.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 3 ]] || { echo "usage: vm:mark-setup-complete <project> <ticket-key> <variation>" >&2; exit 1; }
vm="$(running_vm vm:mark-setup-complete "$@")"
missing="$(limactl shell --workdir / "$vm" -- bash -c 'R="${HARNESS_VM_ROOT-}"
  command -v claude >/dev/null || echo "claude (command -v claude)"
  for f in /run/harness/agent-url /run/harness/env; do [ -s "$R$f" ] || echo "$f"; done')" \
  || { echo "vm:mark-setup-complete: could not probe $vm" >&2; exit 1; }
[[ -z "$missing" ]] || { echo "vm:mark-setup-complete: $vm cannot run an agent: missing $(paste -sd, - <<< "$missing" | sed 's/,/, /g'); Setup stays incomplete" >&2; exit 1; }
limactl shell --workdir / "$vm" -- bash -c 'touch "${HARNESS_VM_ROOT-}$1"' - "$setup_marker" \
  || { echo "vm:mark-setup-complete: could not write $setup_marker in $vm" >&2; exit 1; }
