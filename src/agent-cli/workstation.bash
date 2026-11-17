# A project's GCP Cloud Workstation and its one SSH connection (ASS-433), for
# the workstation:* commands and, through the connection, everything that
# runs on a workstation (ASS-434's setup, ASS-435's machine backend).
# ASS-481: a project's cloud VMs (plain Compute Engine VMs, cloud-vm.bash) are
# remote machines of its pool alike: the same commands, connection, live data
# and setup, keyed by their ids; only their state, start and master differ,
# chosen by the settings' kind.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../workstation.bash"
#   workstation_settings <command> <project> <id>   # the workstation's dev-environments JSON line; fails, naming <command>, without the project or the workstation
#   workstation_control_path <project> <id>   # the connection's ControlPath: $HARNESS_HOME/workstations/<project>-<id>.sock
#   workstation_ssh <project> <id> [<argv…>]  # argv run on the workstation over the connection, stdin, stdout, stderr and the exit
#                                             # code passed through (ssh's 255 when the connection is not open); a shell without argv
#   workstation_rsh <project> <id>            # the same ssh as one command line, for rsync -e: rsync -e "$(workstation_rsh p id)" … workstation-<id>:<path>
#   workstation_alive <project> <id>          # the connection's master answers on its ControlPath (ssh -O check)
#   workstation_reachable <project> <id>      # and a command run over it returns, within WORKSTATION_PROBE_SECONDS (20)
#   workstation_gcloud <settings> <subcommand> [args…]   # gcloud workstations <subcommand> <id> --project … --region … --cluster
#                                             # … --config …, under its gcloud-config's CLOUDSDK_CONFIG when it names one
#   workstation_kind <settings>               # ASS-481: workstation, or cloud-vm for a cloud VM (cloud-vm.bash)
#   workstation_state <settings>              # its state, lower case: running, stopped, starting, stopping, …; fails, gcloud's output on stderr
#                                             # (a cloud VM's: cloud-vm.bash cvm_state)
#   workstation_ports <command> <project>     # the Mac ports reverse-forwarded: harness.json's forwarder-port (required), project.json's
#                                             # hindsight.port and registry.port when set
#   workstation_open <project> <id> <settings> <port…>   # the master connection opened (below; a cloud VM's: cloud-vm.bash
#                                             # cvm_open, OpenSSH's own through IAP); fails, its output on stderr
#   workstation_close <project> <id>          # the master ended, its socket and pid file removed; nothing when none is open
#   workstation_lock <command> <project> <id> [<seconds>]   # the workstation's lock (descriptor 8) until exit: every connect and disconnect
#   workstation_record <project> <id> [jq options…] <filter>  # its entry in the project's workstations.json, rewritten by <filter>
#   workstation_entry <project> <id>          # that entry as one JSON line, with its id; {"id":…} without one
#   workstation_error <output>                # sets ws_error_kind (expired, offline, unknown) and ws_error_message (one line, tokens redacted)
#   ws_live_control <pid>                     # ASS-470: <pid> is a running control (src/control/main.js), below
#   workstation_clear_stale <project> <id> <settings> <port…>   # ASS-501: the machine's stale sshd sessions of the harness's
#                                             # user holding <port…> on its loopback ended (below); one "<pid>\t<port>\t<start
#                                             # time>" line printed for each; fails (2) when the Mac has a live connection to it
#
# The connection. Each new connection to a workstation goes through Google's
# workstation tunnel and needs a live Google token; an open one does not, and
# the operator's gcloud login lapses under Google Cloud session control (~16
# hours), so one long-lived connection per workstation carries every session
# on it: an OpenSSH master (ControlMaster) whose socket every later ssh names
# (-S), each session a channel of its own over it. workstation_open runs
#   gcloud workstations ssh <id> --project … --region … --cluster … --config …
#     --ssh-flag=-M --ssh-flag="-S <socket>" --ssh-flag=-N
#     --ssh-flag="-o ExitOnForwardFailure=yes" --ssh-flag="-o BatchMode=yes"
#     --ssh-flag="-R 127.0.0.1:<port>:127.0.0.1:<port>" …
# in a session of its own (perl setsid: neither control's exit nor a Ctrl-C
# in its terminal ends it), its output in <project>-<id>.log beside the
# socket, its pid in <project>-<id>.pid; it is up once `ssh -O check` answers
# on the socket and a `true` run over it returns. Why gcloud workstations
# ssh and not ssh with gcloud workstations start-tcp-tunnel as its
# ProxyCommand: start-tcp-tunnel has no stdin/stdout mode (unlike IAP's
# --listen-on-stdin), it only listens on a local port, so a ProxyCommand
# would need a second long-lived process and a port of its own; gcloud
# workstations ssh runs that same tunnel inside its own process (a loopback
# port of its choosing, for its ssh alone) and passes our flags (--ssh-flag,
# before the destination) to its ssh, so the one process is tunnel and master
# together, and dies with it. gcloud gives its ssh -o ServerAliveInterval=0
# first, and ssh keeps the first value, so the master sends no keepalives:
# control's check (src/control/workstations.js) runs a command over it
# instead. The key is the one gcloud keeps, ~/.ssh/google_compute_engine
# (made on first use), the user gcloud's default, `user`.
#
# AC2: every forward is -R 127.0.0.1:<port>:127.0.0.1:<port>: bound to the
# workstation's loopback only (a GatewayPorts sshd honours the address given;
# one without binds loopback anyway), reaching the same port on the Mac's
# loopback, where the forwarder, Hindsight and zot listen today. Nothing new
# listens on the Mac: the master's socket is a file in a 0700 folder, and
# gcloud's tunnel port is its own ssh's, on loopback, for its lifetime. With
# ExitOnForwardFailure a forward the workstation refuses (its port taken)
# fails the connection, never leaving it half forwarded.
#
# A session over the connection: ssh -S <socket> -o ControlMaster=no
# -o BatchMode=yes -o ProxyCommand=false workstation-<id> -- <command>; the
# destination is never resolved while the master is up, and the ProxyCommand
# makes ssh fail at once (255) when it is not, rather than try a connection of
# its own. The remote command is argv quoted for a POSIX shell (ws_quote),
# as src/control/workstation-connection.js remoteCommand quotes it.
#
# Live data (AC5): data/projects/<project>/workstations.json (PROJECTS_DIR
# overrides the projects folder), never project.json — { "<id>": { state
# (gcloud's, lower case: running, stopped, …, as last seen), state-at,
# connected (the master up, as last checked), connected-at, checked-at,
# disconnected-at, started-at (when workstation:connect last started it),
# forwards (the ports forwarded), last-error ({ at, kind, message }: the last
# connect's failure, kind expired, offline or unknown; null once one
# succeeds), setup (ASS-434: workstation:setup's last run, see setup.sh),
# control-pid (ASS-470: the control that owns the connection, below) } },
# written through update_json. Control and the TUI read it
# (src/control/workstation-connection.js loadWorkstations).
#
# ASS-470, who owns a connection. The master outlives whoever opened it (its
# own session), so the live data says whose it is: control-pid, the pid of
# the control (src/control/main.js) it belongs to, or null for one opened by
# hand. Control gives every agent.sh it runs, and so every command those run
# in turn (vm:create, a step's script, workstation:claim), its own pid as
# HARNESS_CONTROL_PID; workstation:connect run with it records that pid —
# before it starts or opens anything, so a control that exits while a connect
# is under way still finds it its own — unless the connection it finds open
# is another running control's (ws_live_control), which it leaves that
# control's. Run without it (the operator's shell), a connect that opens a
# new master records null, and one that finds the connection open leaves the
# owner as it is. A connect run for a control that has since exited opens
# nothing, and closes what it opened should that control exit meanwhile.
# workstation:disconnect clears it. Control closes the connections it owns
# whenever it exits, and at its start those whose control-pid names no
# running control (a crash's, a kill -9's); a hand-opened one (null) neither
# closes, though a running control's idle disconnect still closes one nothing
# needs (src/control/workstations.js).
#
# ASS-501, a stale session holding the forwarded ports. When the Mac end of a
# connection dies (its master killed, the Mac asleep or offline), the far
# end's sshd session can live on — nothing on a workstation or cloud VM drops
# a silent client quickly — still listening on the forwards' ports on its
# loopback, so every new master fails ExitOnForwardFailure with "remote port
# forwarding failed for listen port <p>" (seen 2026-11-17 on a cloud VM:
# fixed by hand by killing that sshd). workstation:connect, on that error and
# only when the Mac has no live connection to the machine (no master
# answering on its ControlPath, nor a master process for it still running:
# ws_connection_live), runs workstation_clear_stale: a short session of its
# own with no forwards (ws_session: gcloud workstations ssh --command, or a
# cloud VM's cvm_session) runs ws_clear_remote there, which lists the
# listening sockets (sudo -n ss -Hltnp; the sshd session's process is not
# dumpable, so only root sees its pid) and ends (SIGTERM, as the user, never
# sudo) each process that is an sshd (sshd or sshd-session), listens on
# 127.0.0.1 at one of the forward ports, runs as the session's own user (the
# harness's SSH user) and is not one of the session's own ancestors (the
# session it runs in) — nothing else — printing each one's pid, port and
# start time. connect logs each and retries once.
here_ws="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here_ws/json-file.bash"
source "$here_ws/dev-environments.bash"
source "$here_ws/cloud-vm.bash"
ws_projects="${PROJECTS_DIR:-$here_ws/../../data/projects}"
ws_harness_file="${HARNESS_FILE:-$here_ws/../../data/harness.json}"
ws_folder="${HARNESS_HOME:-$HOME/.harness}/workstations"

ws_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

workstation_settings() {
  [[ "$2" =~ ^[A-Za-z0-9_-]+$ && -f "$ws_projects/$2/project.json" ]] || { echo "$1: no project '$2'" >&2; return 1; }
  [[ "$3" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$1: invalid workstation '$3'" >&2; return 1; }
  dev_environments_workstation "$1" "$2" "$3"
}

workstation_control_path() { echo "$ws_folder/$1-$2.sock"; }
ws_pid_file() { echo "$ws_folder/$1-$2.pid"; }
ws_log_file() { echo "$ws_folder/$1-$2.log"; }

# ws_quote <arg…> — each argument single-quoted for a POSIX shell, space-separated.
ws_quote() {
  local a out=""
  for a in "$@"; do out+="'${a//\'/\'\\\'\'}' "; done
  printf '%s' "${out% }"
}

ws_ssh_options() { printf '%s\n' -S "$(workstation_control_path "$1" "$2")" -o ControlMaster=no -o BatchMode=yes -o ProxyCommand=false; }

workstation_ssh() {
  local project="$1" id="$2" options=(); shift 2
  while IFS= read -r o; do options+=("$o"); done < <(ws_ssh_options "$project" "$id")
  if [[ $# -gt 0 ]]; then ssh "${options[@]}" "workstation-$id" -- "$(ws_quote "$@")"; else ssh "${options[@]}" "workstation-$id"; fi
}

workstation_rsh() { echo "ssh -S $(printf '%q' "$(workstation_control_path "$1" "$2")") -o ControlMaster=no -o BatchMode=yes -o ProxyCommand=false"; }

workstation_alive() { ssh -S "$(workstation_control_path "$1" "$2")" -O check "workstation-$2" >/dev/null 2>&1; }

# ws_timeout <seconds> <argv…> — argv run in a process group of its own, the
# group ended (TERM, then KILL) past <seconds>: 124, as timeout(1). A session
# gone silent is ssh waiting on the network, which only its whole group's end
# stops (an alarm in perl's exec reaches the first process alone).
ws_timeout() {
  perl -e '
    my $s = shift; my $pid = fork; defined $pid or die "fork: $!\n";
    if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127 }
    local $SIG{ALRM} = sub { kill "TERM", -$pid; sleep 1; kill "KILL", -$pid; exit 124 };
    alarm $s; waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$@"
}

workstation_reachable() {
  workstation_alive "$1" "$2" || return 1
  # Without the locks' descriptors (8, 9): a probe left hanging must hold no lock.
  ws_timeout "${WORKSTATION_PROBE_SECONDS:-20}" bash -c "source '$here_ws/workstation.bash' && workstation_ssh \"\$@\" true" _ "$1" "$2" </dev/null >/dev/null 2>&1 8>&- 9>&-
}

# workstation_kind <settings> — ASS-481: workstation, or cloud-vm for one of the cloud-vms (dev-environments.js).
workstation_kind() { jq -r '.kind // "workstation"' <<< "$1"; }

workstation_gcloud() {
  local settings="$1" sub="$2" id project region cluster config cfg; shift 2
  IFS=$'\t' read -r id project region cluster config cfg < <(jq -r '[.id, .["gcp-project"], .region, .cluster, .config, (.["gcloud-config"] // "")] | @tsv' <<< "$settings")
  env ${cfg:+CLOUDSDK_CONFIG="$cfg"} gcloud workstations "$sub" "$id" --project="$project" --region="$region" --cluster="$cluster" --config="$config" "$@"
}

workstation_state() {
  local out
  if [[ "$(workstation_kind "$1")" == cloud-vm ]]; then cvm_state "$1"; return; fi
  out="$(workstation_gcloud "$1" describe --format='value(state)' 2>&1)" || { printf '%s\n' "$out" >&2; return 1; }
  out="$(tail -n 1 <<< "$out" | tr -d '[:space:]')"
  out="${out#STATE_}"
  [[ -n "$out" ]] || { echo "gcloud workstations describe printed no state" >&2; return 1; }
  tr '[:upper:]' '[:lower:]' <<< "$out"
}

workstation_ports() {
  local forwarder
  forwarder="$(jq -r '.["forwarder-port"] // empty' "$ws_harness_file" 2>/dev/null)" || true
  [[ "$forwarder" =~ ^[0-9]+$ ]] || { echo "$1: harness.json has no forwarder-port" >&2; return 1; }
  { echo "$forwarder"; jq -r '.hindsight.port // empty, .registry.port // empty' "$ws_projects/$2/project.json"; } | grep -E '^[0-9]+$' | awk '!seen[$0]++'
}

workstation_lock() { lock_on 8 "$ws_projects/$2/workstation-$3.lock" "$1" "${4:-${WORKSTATION_LOCK_TIMEOUT:-600}}"; }

workstation_record() {
  local project="$1" id="$2"; shift 2
  local filter="${*: -1}"
  update_json --create "$ws_projects/$project/workstations.json" --arg id "$id" --arg at "$(ws_now)" "${@:1:$#-1}" ".[\$id] = ((.[\$id] // {}) | $filter)"
}

workstation_entry() {
  local file="$ws_projects/$1/workstations.json"
  if [[ -f "$file" ]]; then jq -c --arg id "$2" '{ id: $id } + (.[$id] // {})' "$file"; else jq -nc --arg id "$2" '{ id: $id }'; fi
}

workstation_error() {
  local said
  said="$(printf '%s' "$1" | node "$here_ws/workstation-error.js")" || said=$'unknown\t'
  ws_error_kind="${said%%$'\t'*}" ws_error_message="${said#*$'\t'}"
}

# ws_master_pid <project> <id> — the master's pid from its pid file, when that
# process is still ours (its command line names our socket): never a pid
# reused since by something else.
ws_master_pid() {
  local pid
  pid="$(cat "$(ws_pid_file "$1" "$2")" 2>/dev/null)" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] && ps -o command= -p "$pid" 2>/dev/null | grep -qF -- "$(workstation_control_path "$1" "$2")" && echo "$pid"
}

# ws_live_control <pid> — whether <pid> is a running control: alive, and its
# command line runs control/main.js (never a pid reused since by something else).
ws_live_control() {
  [[ "$1" =~ ^[0-9]+$ ]] && kill -0 "$1" 2>/dev/null && ps -o command= -p "$1" 2>/dev/null | grep -qF 'control/main.js'
}

workstation_close() {
  local cp pid
  cp="$(workstation_control_path "$1" "$2")"
  ssh -S "$cp" -O exit "workstation-$2" >/dev/null 2>&1 || true
  if pid="$(ws_master_pid "$1" "$2")"; then kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; fi
  rm -f "$cp" "$(ws_pid_file "$1" "$2")"
}

workstation_open() {
  local project="$1" id="$2" settings="$3" cp port flags=(); shift 3
  # ASS-481: a cloud VM's master is OpenSSH's own through IAP (cloud-vm.bash cvm_open).
  if [[ "$(workstation_kind "$settings")" == cloud-vm ]]; then cvm_open "$project" "$id" "$settings" "$@"; return; fi
  cp="$(workstation_control_path "$project" "$id")"
  [[ "$cp" != *[[:space:]]* ]] || { echo "the connection's socket path $cp has a space, which gcloud's --ssh-flag cannot carry" >&2; return 1; }
  flags=(--ssh-flag=-M --ssh-flag="-S $cp" --ssh-flag=-N --ssh-flag="-o ExitOnForwardFailure=yes" --ssh-flag="-o BatchMode=yes")
  for port in "$@"; do flags+=(--ssh-flag="-R 127.0.0.1:$port:127.0.0.1:$port"); done
  ws_open_master "$project" "$id" bash -c "source '$here_ws/workstation.bash' && workstation_gcloud \"\$@\"" _ "$settings" ssh "${flags[@]}"
}

# ws_open_master <project> <id> <argv…> — argv, a master SSH connection on the workstation's socket, run in a session
# of its own and waited for (workstation_open; ASS-481: a cloud VM's cvm_open too); fails, its output on stderr.
ws_open_master() {
  local project="$1" id="$2" cp log pid i; shift 2
  cp="$(workstation_control_path "$project" "$id")" log="$(ws_log_file "$project" "$id")"
  # A unix socket's path is at most 104 bytes on macOS, and ssh adds a 17-character suffix while it makes one.
  [[ ${#cp} -le 86 ]] || { echo "the connection's socket path $cp is too long for a unix socket (at most 86 characters); set HARNESS_HOME to a shorter folder" >&2; return 1; }
  mkdir -p "$ws_folder" && chmod 700 "$ws_folder"
  rm -f "$cp"
  # Its own session, so it outlives this command and control; without the lock's descriptor (8) or update_json's (9), or it would hold them.
  (umask 077; exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "cannot run $ARGV[0]: $!\n"' "$@" </dev/null >"$log" 2>&1 8>&- 9>&-) &
  pid=$!
  printf '%s\n' "$pid" | replace_file "$(ws_pid_file "$project" "$id")"
  for ((i = 0; i < ${WORKSTATION_CONNECT_TIMEOUT:-60} * 5; i++)); do
    workstation_alive "$project" "$id" && break
    kill -0 "$pid" 2>/dev/null || { wait "$pid" 2>/dev/null || true; cat "$log" >&2; rm -f "$(ws_pid_file "$project" "$id")"; return 1; }
    sleep 0.2
  done
  if workstation_alive "$project" "$id" && workstation_reachable "$project" "$id" && kill -0 "$pid" 2>/dev/null; then return 0; fi
  { cat "$log"; kill -0 "$pid" 2>/dev/null && echo "the connection did not answer within ${WORKSTATION_CONNECT_TIMEOUT:-60} seconds"; } >&2
  workstation_close "$project" "$id"
  return 1
}

# ws_connection_live <project> <id> — ASS-501: the Mac has a live connection to the machine: a master answers on its
# ControlPath, or a master process for it (-M, its command line naming that socket) still runs.
ws_connection_live() {
  workstation_alive "$1" "$2" && return 0
  # The socket in the environment, not awk's argv: awk itself never matches.
  ps -axww -o command= 2>/dev/null | WS_CP="$(workstation_control_path "$1" "$2")" awk 'index($0, ENVIRON["WS_CP"]) && / (--ssh-flag=)?-M( |$)/ { found = 1 } END { exit !found }'
}

# ws_session <settings> <argv…> — ASS-501: argv run on the machine over an SSH session of its own, apart from the
# master and with no forwards: gcloud workstations ssh --command (a cloud VM's: cloud-vm.bash cvm_session).
ws_session() {
  local settings="$1"; shift
  if [[ "$(workstation_kind "$settings")" == cloud-vm ]]; then cvm_session "$settings" "$@"; return; fi
  workstation_gcloud "$settings" ssh --command="$(ws_quote "$@")" --ssh-flag="-T" --ssh-flag="-o BatchMode=yes" \
    --ssh-flag="-o ClearAllForwardings=yes" --ssh-flag="-o ControlMaster=no" --ssh-flag="-o ControlPath=none"
}

# ws_clear_remote <port…> — ASS-501: run on the machine (bash -c, through ws_session): ends this user's sshd sessions
# listening on 127.0.0.1 at one of <port…>, never this session's own, another user's or anything else; prints
# "ended\t<pid>\t<port>\t<start time>" for each, "note\t<text>" for what workstation_clear_stale passes on to stderr.
ws_clear_remote() {
  local me ancestors=" " ended=" " p listing local_ users port name pid started i
  me="$(id -u)"
  p=$$
  while [[ "$p" =~ ^[0-9]+$ && "$p" -gt 1 ]]; do ancestors+="$p "; p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"; done
  if ! listing="$(sudo -n ss -Hltnp 2>/dev/null)"; then
    printf 'note\t%s\n' "sudo -n ss failed: listed without sudo, which shows no sshd session's pid"
    listing="$(ss -Hltnp)" || return 1
  fi
  while read -r _ _ _ local_ _ users; do
    [[ "${local_%:*}" == 127.0.0.1 ]] || continue
    port="${local_##*:}"
    [[ " $* " == *" $port "* ]] || continue
    while read -r name pid; do
      [[ "$name" == sshd || "$name" == sshd-session ]] || continue
      [[ "$ancestors" != *" $pid "* && "$ended" != *" $pid "* ]] || continue
      [[ "$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')" == "$me" ]] || continue
      started="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//; s/ *$//')"
      kill -TERM "$pid" 2>/dev/null || continue
      ended+="$pid "
      # Waited for (up to 5 seconds), so the retry finds the port free; a zombie holds no socket.
      for ((i = 0; i < 50; i++)); do
        kill -0 "$pid" 2>/dev/null && [[ "$(ps -o stat= -p "$pid" 2>/dev/null)" != *Z* ]] || break
        sleep 0.1
      done
      printf 'ended\t%s\t%s\t%s\n' "$pid" "$port" "${started:-unknown}"
    done < <(grep -oE '\("[^"]*",pid=[0-9]+' <<< "$users" | sed -E 's/^\("([^"]*)",pid=/\1 /')
  done <<< "$listing"
}

workstation_clear_stale() {
  local project="$1" id="$2" settings="$3" out err; shift 3
  if ws_connection_live "$project" "$id"; then echo "the Mac has a live connection to it: nothing ended" >&2; return 2; fi
  err="$(mktemp)"
  # Bounded, and without the locks' descriptors (8, 9), as workstation_reachable's probe.
  out="$(ws_timeout "${WORKSTATION_CONNECT_TIMEOUT:-60}" bash -c "source '$here_ws/workstation.bash' && ws_session \"\$@\"" _ \
    "$settings" bash -c "$(declare -f ws_clear_remote)"$'\n''ws_clear_remote "$@"' _ "$@" </dev/null 2>"$err" 8>&- 9>&-)" \
    || { cat "$err" >&2; rm -f "$err"; return 1; }
  rm -f "$err"
  grep $'^note\t' <<< "$out" | cut -f 2- >&2 || true
  grep $'^ended\t' <<< "$out" | cut -f 2- || true
}
