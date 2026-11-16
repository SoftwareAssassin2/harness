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
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

[[ $# -eq 3 ]] || { echo "usage: vm:mark-setup-complete <project> <ticket-key> <variation>" >&2; exit 1; }
# ASS-468: a variation whose steps run on the project's workstations (vm kind workstation) is marked on the
# variation itself, vm.setup-complete-at — the workstation's repositories are every variation's — once the
# workstation it records was last set up (workstations.json's setup ok: claude, agent.sh and the runtime folder there).
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
ws="$(variation_field 'if .vm.kind == "workstation" then .vm.name else "" end' vm:mark-setup-complete "$1" "$key" "$3" | jq -r .)"
if [[ -n "$ws" ]]; then
  workstation_entry "$1" "$ws" | jq -e '.setup.ok == true' >/dev/null \
    || { echo "vm:mark-setup-complete: $1's workstation $ws has not been set up (workstation:setup); Setup stays incomplete" >&2; exit 1; }
  update_whole_ticket vm:mark-setup-complete "$1" "$key" --arg name "$3" \
    '.variations |= map(if .name == $name and (.["is-deleted"] | not) then .vm["setup-complete-at"] = $at else . end)' >/dev/null
  exit 0
fi
vm="$(running_vm vm:mark-setup-complete "$@")"
missing="$(machine_run --workdir / "$vm" -- bash -c 'R="${HARNESS_VM_ROOT-}"
  command -v claude >/dev/null || echo "claude (command -v claude)"
  for f in /run/harness/agent-url /run/harness/env; do [ -s "$R$f" ] || echo "$f"; done')" \
  || { echo "vm:mark-setup-complete: could not probe $vm" >&2; exit 1; }
[[ -z "$missing" ]] || { echo "vm:mark-setup-complete: $vm cannot run an agent: missing $(paste -sd, - <<< "$missing" | sed 's/,/, /g'); Setup stays incomplete" >&2; exit 1; }
machine_run --workdir / "$vm" -- bash -c 'touch "${HARNESS_VM_ROOT-}$1"' - "$setup_marker" \
  || { echo "vm:mark-setup-complete: could not write $setup_marker in $vm" >&2; exit 1; }
