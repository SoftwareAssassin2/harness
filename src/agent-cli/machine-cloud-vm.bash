# The machine layer's cloud-VM backend (ASS-481 AC2; machine.bash): a ticket
# variation's step on one of its project's cloud VMs (plain GCP Compute
# Engine VMs, cloud-vm.bash), in its shared root as on a workstation
# (ASS-468). src/control/machine-cloud-vm.js is the same backend for control.
#
#   cloud_vm_run <workdir|""> <marker|""> <seconds|""> <name> <argv…>   # argv run in the machine's folder
#   cloud_vm_stop_marked <name> <marker>          # SIGTERM, on the VM, to what runs under the marker
#   cloud_vm_copy_in <name> <local> <remote>      # rsync -a over the connection
#   cloud_vm_copy_out <name> <remote> <local>
#   cloud_vm_status <name>     # Running (the connection open and the folder there), Stopped (no connection); fails without the folder
#   cloud_vm_start <command> <name> …             # workstation:connect: started (or resumed) when stopped, waited for
#                                                 # until its SSH answers through IAP, connected
#   cloud_vm_stop <name> [force]                  # nothing: the harness never stops a cloud VM (it stops itself after 60
#                                                 # idle minutes; AC4)
#
# A cloud-VM machine is named cloud-vm:<project>:<id>:<folder> (machine.bash
# $machine_of, from the variation's `workstation` { name: <id>, project,
# folder, kind: cloud-vm } while one of its steps holds the VM, else its vm {
# kind: cloud-vm, … }), its folder the VM's shared root, <home>/harness,
# standing in for a VM's root as a workstation's does
# (machine-workstation.bash says how: wsm_parts, wsm_path, the session's
# HARNESS_VM_ROOT and ~/harness/env, the marker). Once its connection is open
# (workstation:connect: OpenSSH's own master through the IAP tunnel, OS
# Login, cloud-vm.bash), every session, copy and signal goes over it exactly
# as over a workstation's (workstation.bash workstation_ssh, workstation_rsh:
# keyed by the project and the id), so those are the workstation backend's;
# only the start differs, and workstation:connect chooses it by the id's kind.
here_mcv="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here_mcv/machine-workstation.bash"

cloud_vm_run() { workstation_run "$@"; }
cloud_vm_stop_marked() { workstation_stop_marked "$@"; }
cloud_vm_copy_in() { workstation_copy_in "$@"; }
cloud_vm_copy_out() { workstation_copy_out "$@"; }
cloud_vm_status() { workstation_status "$@"; }
cloud_vm_start() { wsm_parts "$2" || return 1; "$here_mcv/../../agent.sh" workstation:connect "$wsm_project" "$wsm_id" >/dev/null; }
cloud_vm_stop() { wsm_parts "$1"; }
