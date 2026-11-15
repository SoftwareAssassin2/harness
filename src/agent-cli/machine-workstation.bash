# The machine layer's workstation backend (ASS-435; machine.bash): a ticket
# variation's folder on one of its project's GCP Cloud Workstations, reached
# over that workstation's one SSH connection (ASS-433, workstation.bash: a
# session of its own over the master, never a connection of its own).
# src/control/machine-workstation.js is the same backend for control.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/machine-workstation.bash"
#   workstation_run <workdir|""> <marker|""> <seconds|""> <name> <argv…>   # argv run in the variation's folder (below)
#   workstation_stop_marked <name> <marker>       # SIGTERM, on the workstation, to what runs under the marker
#   workstation_copy_in <name> <local> <remote>   # rsync -a over the connection (rsync's own naming: a folder
#   workstation_copy_out <name> <remote> <local>  #   with a trailing / copies its content)
#   workstation_status <name>   # Running (the connection open and the folder there), Stopped (no connection); fails without the folder
#   workstation_start <command> <name> …          # workstation:connect: started when stopped, connected
#   workstation_stop <name> [force]               # nothing: the harness never stops a workstation (ASS-433: it stops itself once idle)
#   wsm_parts <name>            # sets wsm_project, wsm_id and wsm_folder from the name; fails, naming it, on any other
#   wsm_path <folder> <path>    # a VM path as the variation's folder has it (below)
#   wsm_sync_ticket <name> <ticket-folder>   # the ticket folder's read-only copy brought up to date (below)
#
# A workstation machine is named workstation:<project>:<id>:<folder> (machine.bash
# $machine_of, from the variation's vm { kind: workstation, name: <id>,
# project, folder }, as ticket:set-vm records a placement): the backend's name
# is <project>:<id>:<folder>, the project naming the connection (its socket),
# the folder the variation's own, ~/harness/<KEY>-<variation> made absolute
# (workstation-variation.bash). One variation per workstation at a time
# (ASS-435), and never the owner's ~/workspaces. The folder stands in for a
# VM's root: <folder>/repos is /repos, <folder>/ticket the ticket's read-only
# copy (a VM's /mnt/ticket mount; <folder>/mnt/ticket links to it),
# <folder>/run/harness a link to the setup's runtime folder (a VM's
# /run/harness: the forwarder token and credentials). So every command run
# here gets HARNESS_VM_ROOT=<folder> — the in-VM scripts' stand-in for the
# VM's root ("${HARNESS_VM_ROOT-}/repos/…") — and its workdir as wsm_path
# maps it: / (or none) the folder, /repos…, /mnt/ticket… and /run/harness…
# under it, any other path as it is. Each session sources ~/harness/env
# (ASS-434: ~/harness/bin first on PATH, HARNESS_RUNTIME, and the runtime
# folder's env, the credentials), as a VM's login shell sources
# /etc/profile.d/harness-credentials.sh.
#
# A marker works as in a VM (machine-lima.bash's lima_wrap: the process runs
# under a bash whose command line carries it, and pkill ends it there): a
# local signal to ssh never reaches the workstation's process.
#
# The ticket's copy (AC4): rsync -a --delete of the ticket folder on the Mac
# into <folder>/ticket over the connection (workstation_rsh), its write bit
# given back for the rsync (its --rsync-path) and taken off everything once it
# is done (chmod -R a-w), so an agent reads it and never writes it, as a VM's
# read-only mount; vm:start and vm:create push it, control pushes it as an
# agent starts there, and the forwarder after each call it runs for the
# variation (src/control/forwarder.js, machine-workstation.js syncTicketCopy).
here_wsm="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here_wsm/workstation.bash"

# What a session runs first: into the workdir, HARNESS_VM_ROOT the folder, the harness's env sourced, then argv.
# shellcheck disable=SC2016
wsm_enter='d="$1" f="$2"; shift 2; cd "$d" || exit 1; export HARNESS_VM_ROOT="$f"; [ -r "$HOME/harness/env" ] && . "$HOME/harness/env"; exec "$@"'

wsm_parts() {
  IFS=: read -r wsm_project wsm_id wsm_folder <<< "$1"
  [[ "$wsm_project" =~ ^[A-Za-z0-9_-]+$ && "$wsm_id" =~ ^[A-Za-z0-9_-]+$ && "$wsm_folder" == /*/harness/* ]] \
    || { echo "workstation:$1: not a workstation machine (workstation:<project>:<id>:<folder under ~/harness>)" >&2; return 1; }
}

wsm_path() {
  case "$2" in
    ""|/) echo "$1" ;;
    /repos|/repos/*|/run/harness|/run/harness/*) echo "$1$2" ;;
    /mnt/ticket|/mnt/ticket/*) echo "$1/ticket${2#/mnt/ticket}" ;;
    *) echo "$2" ;;
  esac
}

# wsm_command <project> <id> <argv…> — wsm_cmd, the ssh that runs argv on the workstation over its connection.
wsm_command() {
  local project="$1" id="$2" o; shift 2
  wsm_cmd=(ssh)
  while IFS= read -r o; do wsm_cmd+=("$o"); done < <(ws_ssh_options "$project" "$id")
  wsm_cmd+=("workstation-$id" -- "$(ws_quote "$@")")
}

workstation_run() {
  local workdir="$1" marker="$2" timeout="$3" code=0; shift 3
  wsm_parts "$1" || return 1; shift
  wsm_command "$wsm_project" "$wsm_id" bash -c "$wsm_enter" harness-ws "$(wsm_path "$wsm_folder" "$workdir")" "$wsm_folder" ${marker:+bash -c "$lima_wrap" "$marker"} "$@"
  ${timeout:+perl -e 'alarm shift; exec @ARGV' "$timeout"} "${wsm_cmd[@]}" || code=$?
  [[ -z "$timeout" || $code -ne 142 ]] || code=124
  return "$code"
}

workstation_stop_marked() { wsm_parts "$1" || return 1; workstation_ssh "$wsm_project" "$wsm_id" pkill -TERM -f "[${2:0:1}]${2:1}" </dev/null; }

workstation_copy_in() { wsm_parts "$1" || return 1; rsync -a -e "$(workstation_rsh "$wsm_project" "$wsm_id")" "$2" "workstation-$wsm_id:$(wsm_path "$wsm_folder" "$3")"; }
workstation_copy_out() { wsm_parts "$1" || return 1; rsync -a -e "$(workstation_rsh "$wsm_project" "$wsm_id")" "workstation-$wsm_id:$(wsm_path "$wsm_folder" "$2")" "$3"; }

workstation_status() {
  wsm_parts "$1" || return 1
  workstation_alive "$wsm_project" "$wsm_id" || { echo Stopped; return 0; }
  workstation_ssh "$wsm_project" "$wsm_id" test -d "$wsm_folder/repos" </dev/null || { echo "workstation $wsm_id has no folder $wsm_folder" >&2; return 1; }
  echo Running
}

workstation_start() { wsm_parts "$2" || return 1; "$here_wsm/../../agent.sh" workstation:connect "$wsm_project" "$wsm_id" >/dev/null; }

workstation_stop() { wsm_parts "$1"; }

wsm_sync_ticket() {
  local copy
  wsm_parts "$1" || return 1
  copy="$wsm_folder/ticket"
  rsync -a --delete --rsync-path="mkdir -p $(printf '%q' "$copy") && chmod -R u+w $(printf '%q' "$copy") && rsync" \
    -e "$(workstation_rsh "$wsm_project" "$wsm_id")" "${2%/}/" "workstation-$wsm_id:$copy/" </dev/null \
    && workstation_ssh "$wsm_project" "$wsm_id" chmod -R a-w "$copy" </dev/null
}
