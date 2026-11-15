# The machine layer's Lima backend (ASS-432; machine.bash): a ticket
# variation's VM, a Lima instance under LIMA_HOME (lima-home.bash), reached
# through limactl. The only file of the bash commands, with vm/build-golden.sh
# and vm/golden-image/*, that runs limactl shell, copy or list
# (test/agent-cli/machine-guard.test.js fails on any other); creating, cloning
# and deleting a VM stay Lima's own (limactl clone, delete and edit, in
# vm:create, vm:recreate, vm:test-repos and vm.bash delete_vm).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/machine-lima.bash"
#   lima_run <workdir|""> <marker|""> <seconds|""> <vm> <argv…>   # limactl shell [--workdir <workdir>] <vm> -- argv, under the marker
#                                                    # when given; past <seconds>, SIGALRMed (perl's alarm, kept across its exec) and 124
#   lima_stop_marked <vm> <marker>                   # SIGTERM, in the VM, to what runs under the marker
#   lima_copy_in <vm> <local> <remote>               # limactl copy -r
#   lima_copy_out <vm> <remote> <local>
#   lima_status <vm>                                 # its {{.Status}} (Running, Stopped, …); fails when there is no such instance
#   lima_start <command> <vm> <display> <port…>      # limactl start, sandboxed (below)
#   lima_stop <vm> [force]                           # limactl stop [-f]
#   lima_list [<vm>] --format <format>               # limactl list: what only Lima has (an instance's Dir, its
#                                                    # SSHLocalPort and display; every instance, golden ones too)
#
# Every call runs with LIMA_HOME as lima_home resolves it (the env var when
# set), so a command needs it no more than it did before (ASS-273).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lima-home.bash"

# A SIGTERM to the local `limactl shell` never reaches the VM (no tty, so
# sshd sends no signal: ASS-69), so a process that may be stopped runs under
# a bash whose own command line carries a marker unique to it, and which
# passes a TERM on to the process; lima_stop_marked pkills the marker in the
# VM. The same wrapper as src/control/machine-lima.js's.
# shellcheck disable=SC2016
lima_wrap='trap '"'"'kill -TERM "$c" 2>/dev/null'"'"' TERM; "$@" <&0 & c=$!; while :; do wait "$c"; s=$?; kill -0 "$c" 2>/dev/null || exit "$s"; done'

lima_run() {
  local workdir="$1" marker="$2" timeout="$3" vm="$4" code=0; shift 4
  LIMA_HOME="$(lima_home)" ${timeout:+perl -e 'alarm shift; exec @ARGV' "$timeout"} limactl shell ${workdir:+--workdir "$workdir"} "$vm" -- ${marker:+bash -c "$lima_wrap" "$marker"} "$@" || code=$?
  [[ -z "$timeout" || $code -ne 142 ]] || code=124
  return "$code"
}

lima_stop_marked() { LIMA_HOME="$(lima_home)" limactl shell "$1" -- pkill -TERM -f "[${2:0:1}]${2:1}"; }

lima_copy_in() { LIMA_HOME="$(lima_home)" limactl copy -r "$2" "$1:$3"; }
lima_copy_out() { LIMA_HOME="$(lima_home)" limactl copy -r "$1:$2" "$3"; }

lima_status() { LIMA_HOME="$(lima_home)" limactl list "$1" --format '{{.Status}}'; }

lima_list() { LIMA_HOME="$(lima_home)" limactl list "$@"; }

lima_stop() { LIMA_HOME="$(lima_home)" limactl stop ${2:+-f} "$1"; }

# The sandbox vm:start explains (step 1): the VM must have an ssh port of its
# own (ssh.localPort, pinned when it was cloned) for the profile to allow.
lima_start() {
  local command="$1" vm="$2" display="$3" ssh port allowed="" profile home; shift 3
  home="$(lima_home)"
  [[ "$(lima_list "$vm" --format '{{.Config.Video.Display}}')" == "$display" ]] \
    || LIMA_HOME="$home" limactl edit --tty=false "$vm" --set ".video.display = \"$display\"" >/dev/null 2>&1 || { echo "$command: could not set $vm's video.display to $display" >&2; return 1; }
  ssh="$(lima_list "$vm" --format '{{.SSHLocalPort}}')"
  [[ "$ssh" =~ ^[1-9][0-9]*$ ]] || { echo "$command: $vm has no ssh port of its own (ssh.localPort); vm:create pins one" >&2; return 1; }
  for port in "$@" "$ssh"; do allowed+=" (remote ip \"localhost:$port\")"; done
  profile="(version 1)
(allow default)
(deny network-outbound (remote ip \"*:*\"))
(allow network-outbound$allowed)"
  # Its host agent outlives this shell: started without the VM lock's descriptor (vm.bash lock_vms) or the ssh port lock's (lock_ports), or it would hold them.
  LIMA_HOME="$home" sandbox-exec -p "$profile" limactl start --tty=false "$vm" >/dev/null 2>&1 8>&- 4>&- || { echo "$command: $vm would not start (see $home/$vm/ha.stderr.log)" >&2; return 1; }
}
