# The machine layer's Substrate sandbox backend (ASS-535; machine.bash): a
# ticket variation's own sandbox — a Substrate actor in its project's atespace
# on the cluster of the machine its seat is on (the Mac's, a workstation's or a
# cloud VM's, ASS-533) — reached through the sandbox image's command server
# (ASS-534) by src/substrate/sandbox-exec.js, as a VM is through limactl.
# src/control/machine-substrate.js is the same backend for control, and says
# the whole design; src/agent-cli/substrate/sandbox.bash makes, starts, stops
# and deletes the sandboxes (the substrate:sandbox-* commands).
#
#   substrate_run <workdir|""> <marker|""> <seconds|""> <name> <argv…>   # argv run in the sandbox (sandbox-exec.js),
#                                                    # as its user agent, in <workdir> (its home without one)
#   substrate_stop_marked <name> <marker>            # SIGTERM, in the sandbox, to what runs under the marker
#   substrate_copy_in <name> <local> <remote>        # a file or folder copied in (a tar stream through the command
#   substrate_copy_out <name> <remote> <local>       #   server, as root); <remote> or <local> its new path, or, ending
#                                                    #   in /, the folder it goes into
#   substrate_status <name>     # Running, Stopped (suspended: hibernated); fails when there is no such sandbox
#   substrate_start <command> <name> …               # resumed when suspended, its endpoint (proxy, forward) up
#   substrate_stop <name> [force]                    # suspended: hibernated, its files and processes kept
#   sbm_parts <name>            # sets sbm_project, sbm_machine and sbm_actor; fails, naming it, on any other
#
# A sandbox machine is named substrate:<project>:<machine>:<actor> (machine.bash
# $machine_of, from the variation's `sandbox` { name: <actor>, project, machine }
# while its run target is a substrate one — its `run-target`, code:hand-over's,
# or HARNESS_RUN_TARGET, which control sets for a script step): <machine> is the
# cluster's (mac, or a workstation's or cloud VM's id), <actor> the sandbox's,
# <KEY>-<variation> in lower case (sandbox.bash sandbox_actor) — one per ticket
# variation, never shared. Paths in it are a VM's: /repos/<repo> each
# repository's checkout (baked into the image, ASS-534), /mnt/ticket the
# ticket folder's read-only copy (substrate:sandbox-up and control bring it up
# to date).
here_msb="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
sbm_exec="$here_msb/../substrate/sandbox-exec.js"

sbm_parts() {
  IFS=: read -r sbm_project sbm_machine sbm_actor <<< "$1"
  [[ "$sbm_project" =~ ^[A-Za-z0-9_-]+$ && "$sbm_machine" =~ ^[A-Za-z0-9_-]+$ && "$sbm_actor" =~ ^[a-z0-9-]+$ ]] \
    || { echo "substrate:$1: not a sandbox machine (substrate:<project>:<machine>:<actor>)" >&2; return 1; }
}

substrate_run() {
  local workdir="$1" marker="$2" timeout="$3"; shift 3
  sbm_parts "$1" || return 1; shift
  node "$sbm_exec" --sandbox "$sbm_project:$sbm_machine:$sbm_actor" ${workdir:+--workdir "$workdir"} ${marker:+--marker "$marker"} ${timeout:+--timeout "$timeout"} -- "$@"
}

substrate_stop_marked() { sbm_parts "$1" || return 1; node "$sbm_exec" --sandbox "$sbm_project:$sbm_machine:$sbm_actor" --root -- pkill -TERM -f "[${2:0:1}]${2:1}" </dev/null; }

# sbm_split <path> — sbm_dir and sbm_base: a path's folder and name, or (ending in /) the folder and "".
sbm_split() { if [[ "$1" == */ ]]; then sbm_dir="${1%/}" sbm_base=""; else sbm_dir="$(dirname "$1")" sbm_base="$(basename "$1")"; fi; }

substrate_copy_in() {
  local name="$1" local_path="${2%/}" remote="$3" base
  sbm_parts "$name" || return 1
  sbm_split "$remote"; base="$(basename "$local_path")"
  COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -c -C "$(dirname "$local_path")" ${sbm_base:+-s ",^$base,$sbm_base,"} "$base" \
    | node "$sbm_exec" --sandbox "$sbm_project:$sbm_machine:$sbm_actor" --root -- bash -c 'd="${HARNESS_VM_ROOT-}$1"; mkdir -p "$d" && tar -x -C "$d" --no-same-owner -f -' _ "$sbm_dir"
}

substrate_copy_out() {
  local name="$1" remote="${2%/}" local_path="$3"
  sbm_parts "$name" || return 1
  sbm_split "$local_path"; mkdir -p "$sbm_dir" || return 1
  node "$sbm_exec" --sandbox "$sbm_project:$sbm_machine:$sbm_actor" --root -- bash -c 'tar -c -C "${HARNESS_VM_ROOT-}$1" "$2"' _ "$(dirname "$remote")" "$(basename "$remote")" </dev/null \
    | tar -x -C "$sbm_dir" ${sbm_base:+-s ",^$(basename "$remote"),$sbm_base,"} -f -
}

substrate_status() {
  local out
  sbm_parts "$1" || return 1
  out="$("$here_msb/../../agent.sh" substrate:sandbox-state "$sbm_project" "$sbm_machine" "$sbm_actor")" || return 1
  case "$(jq -r '.state // ""' <<< "$out")" in
    running|resuming) echo Running ;;
    "") echo "no sandbox $sbm_actor on $sbm_machine" >&2; return 1 ;;
    *) echo Stopped ;;
  esac
}

substrate_start() { sbm_parts "$2" || return 1; "$here_msb/../../agent.sh" substrate:sandbox-endpoint "$sbm_project" "$sbm_machine" "$sbm_actor" >/dev/null; }

substrate_stop() { sbm_parts "$1" || return 1; "$here_msb/../../agent.sh" substrate:sandbox-suspend "$sbm_project" "$sbm_machine" "$sbm_actor" >/dev/null; }
