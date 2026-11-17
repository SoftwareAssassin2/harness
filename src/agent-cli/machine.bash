# The machine layer (ASS-432): every operation the bash commands run against
# a ticket variation's machine — a command run in it, files copied in or out,
# its status, its start and stop — goes through here, so a second kind of
# machine (a GCP workstation over SSH, ASS-435) is added in one place, not at
# every call site. src/control/machine.js is the same layer for control.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/machine.bash"
#   machine_run [--workdir <dir>] [--marker <marker>] [--timeout <seconds>] <machine> -- <argv…>
#                                     # argv run in the machine, in <dir> (the backend's default without it); stdin, stdout,
#                                     # stderr and the exit code passed through; under <marker> (a step's agent, say), a
#                                     # process machine_stop_marked can end there, which a local signal never reaches;
#                                     # ended past <seconds>, exit 124 (as timeout(1)), when given
#   machine_stop_marked <machine> <marker>   # SIGTERM, in the machine, to what runs under <marker>; its own status
#   machine_copy_in <machine> <local> <remote>    # a file or folder copied into the machine
#   machine_copy_out <machine> <remote> <local>   # and out of it
#   machine_status <machine>          # Running, Stopped, …; fails when there is no such machine
#   machine_start <command> <machine> <display> <port…>   # started: for a VM, sandboxed so it reaches the Mac's
#                                     # loopback only at <port…> (vm:start, step 1), its video.display <display> (none or vz)
#   machine_stop <machine> [force]    # stopped (force: at once)
#   machine_backend <machine>         # its backend's name; fails, naming it, for one there is none of
#   machine_remote <machine>          # ASS-481: it is a workstation's or a cloud VM's (workstation:… or cloud-vm:…)
#   $machine_of                       # a jq filter: a ticket variation (its "vm", ticket:set-vm) → its machine, "" without one
#
# A machine is named as the variation records it: its "vm" { name, kind }
# (ticket:set-vm, vm:create). Without a kind, or kind lima, it is the VM's
# Lima instance name, as ever (ass-74-a); any other kind is "<kind>:<name>",
# so the backend is chosen per ticket variation from what it records, and
# vm.bash recorded_vm, running_vm and code.bash vm_of print the machine so.
# Two backends: Lima (machine-lima.bash) and, since ASS-435, a GCP
# workstation (machine-workstation.bash), whose machine is named
# workstation:<project>:<id>:<folder> from the variation's vm { kind:
# workstation, name: <id>, project, folder } — the folder on the workstation
# standing in for a VM's root (machine-workstation.bash says how). ASS-468:
# while one of its steps holds a workstation, the variation's `workstation`
# { name, project, folder } (workstation:claim) is its machine instead,
# whatever its vm records — so in vm+workstation mode a variation with a VM
# runs a step on the workstation when it is free. ASS-481: a third, a cloud
# VM (machine-cloud-vm.bash), named cloud-vm:<project>:<id>:<folder> alike
# from the claim's `workstation` (its kind cloud-vm) or vm { kind: cloud-vm,
# … }; machine_remote says a machine is one of the two remote kinds. A
# backend's functions are named by its kind, a - made _ (cloud_vm_run). A new one is a machine-<kind>.bash defining <kind>_run,
# <kind>_stop_marked, <kind>_copy_in, <kind>_copy_out, <kind>_status,
# <kind>_start and <kind>_stop as lima_* do, sourced here and named in
# $machine_backends.
#
# Lima-specific, outside the layer: building the golden image (vm:build-golden,
# golden-image/*), and creating, cloning and deleting a VM (vm:create,
# vm:recreate, vm:test-repos, vm.bash delete_vm and the inventory): those use
# limactl, and lima_list for what only Lima has, directly.
# test/agent-cli/machine-guard.test.js fails on a limactl shell, copy or
# list anywhere else.
here_machine="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here_machine/machine-lima.bash"
source "$here_machine/machine-workstation.bash"
source "$here_machine/machine-cloud-vm.bash"

machine_backends="lima workstation cloud-vm"

# shellcheck disable=SC2016
machine_of='(if (.workstation.name // "") != "" and .workstation.project and .workstation.folder then .workstation + { kind: (.workstation.kind // "workstation") } else .vm // {} end) as $m | if ($m.name // "") == "" then "" elif ($m.kind // "lima") == "lima" then $m.name
  elif ($m.kind | IN("workstation", "cloud-vm")) and $m.project and $m.folder then "\($m.kind):\($m.project):\($m.name):\($m.folder)" else "\($m.kind):\($m.name)" end'

# machine_remote <machine> — ASS-481: it is a remote machine of the project's pool (a workstation's or a cloud VM's,
# workstation:… or cloud-vm:…), reached over its one connection.
machine_remote() { [[ "$1" == workstation:* || "$1" == cloud-vm:* ]]; }

machine_backend() {
  local kind=lima
  [[ "$1" != *:* ]] || kind="${1%%:*}"
  [[ " $machine_backends " == *" $kind "* ]] || { echo "${1#*:}: no machine backend for its kind '$kind' (there is: $machine_backends)" >&2; return 1; }
  echo "$kind"
}

machine_run() {
  local workdir="" marker="" timeout="" machine backend
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --workdir) workdir="$2"; shift 2 ;;
      --marker) marker="$2"; shift 2 ;;
      --timeout) timeout="$2"; shift 2 ;;
      *) break ;;
    esac
  done
  machine="$1"; shift
  [[ "${1-}" == -- ]] && shift
  backend="$(machine_backend "$machine")" || return 1
  "${backend//-/_}_run" "$workdir" "$marker" "$timeout" "${machine#"$backend":}" "$@"
}

machine_stop_marked() { local backend; backend="$(machine_backend "$1")" || return 1; "${backend//-/_}_stop_marked" "${1#"$backend":}" "$2"; }
machine_copy_in() { local backend; backend="$(machine_backend "$1")" || return 1; "${backend//-/_}_copy_in" "${1#"$backend":}" "$2" "$3"; }
machine_copy_out() { local backend; backend="$(machine_backend "$1")" || return 1; "${backend//-/_}_copy_out" "${1#"$backend":}" "$2" "$3"; }
machine_status() { local backend; backend="$(machine_backend "$1")" || return 1; "${backend//-/_}_status" "${1#"$backend":}"; }
machine_start() { local backend; backend="$(machine_backend "$2")" || return 1; "${backend//-/_}_start" "$1" "${2#"$backend":}" "${@:3}"; }
machine_stop() { local backend; backend="$(machine_backend "$1")" || return 1; "${backend//-/_}_stop" "${1#"$backend":}" "${2:-}"; }
