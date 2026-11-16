# A project's GCP Cloud Workstation and its one SSH connection (ASS-433), for
# the workstation:* commands and, through the connection, everything that
# runs on a workstation (ASS-434's setup, ASS-435's machine backend).
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
#   workstation_state <settings>              # its state, lower case: running, stopped, starting, stopping, …; fails, gcloud's output on stderr
#   workstation_ports <command> <project>     # the Mac ports reverse-forwarded: harness.json's forwarder-port (required), project.json's
#                                             # hindsight.port and registry.port when set
#   workstation_open <project> <id> <settings> <port…>   # the master connection opened (below); fails, its output on stderr
#   workstation_close <project> <id>          # the master ended, its socket and pid file removed; nothing when none is open
#   workstation_lock <command> <project> <id> [<seconds>]   # the workstation's lock (descriptor 8) until exit: every connect and disconnect
#   workstation_record <project> <id> [jq options…] <filter>  # its entry in the project's workstations.json, rewritten by <filter>
#   workstation_entry <project> <id>          # that entry as one JSON line, with its id; {"id":…} without one
#   workstation_error <output>                # sets ws_error_kind (expired, offline, unknown) and ws_error_message (one line, tokens redacted)
#   ws_live_control <pid>                     # ASS-470: <pid> is a running control (src/control/main.js), below
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
here_ws="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here_ws/json-file.bash"
source "$here_ws/dev-environments.bash"
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

workstation_gcloud() {
  local settings="$1" sub="$2" id project region cluster config cfg; shift 2
  IFS=$'\t' read -r id project region cluster config cfg < <(jq -r '[.id, .["gcp-project"], .region, .cluster, .config, (.["gcloud-config"] // "")] | @tsv' <<< "$settings")
  env ${cfg:+CLOUDSDK_CONFIG="$cfg"} gcloud workstations "$sub" "$id" --project="$project" --region="$region" --cluster="$cluster" --config="$config" "$@"
}

workstation_state() {
  local out
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
  local project="$1" id="$2" settings="$3" cp log pid port i flags=(); shift 3
  cp="$(workstation_control_path "$project" "$id")" log="$(ws_log_file "$project" "$id")"
  # A unix socket's path is at most 104 bytes on macOS, and ssh adds a 17-character suffix while it makes one; --ssh-flag splits on spaces.
  [[ ${#cp} -le 86 ]] || { echo "the connection's socket path $cp is too long for a unix socket (at most 86 characters); set HARNESS_HOME to a shorter folder" >&2; return 1; }
  [[ "$cp" != *[[:space:]]* ]] || { echo "the connection's socket path $cp has a space, which gcloud's --ssh-flag cannot carry" >&2; return 1; }
  mkdir -p "$ws_folder" && chmod 700 "$ws_folder"
  rm -f "$cp"
  flags=(--ssh-flag=-M --ssh-flag="-S $cp" --ssh-flag=-N --ssh-flag="-o ExitOnForwardFailure=yes" --ssh-flag="-o BatchMode=yes")
  for port in "$@"; do flags+=(--ssh-flag="-R 127.0.0.1:$port:127.0.0.1:$port"); done
  # Its own session, so it outlives this command and control; without the lock's descriptor (8) or update_json's (9), or it would hold them.
  (umask 077; exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "cannot run $ARGV[0]: $!\n"' bash -c "source '$here_ws/workstation.bash' && workstation_gcloud \"\$@\"" _ \
    "$settings" ssh "${flags[@]}" </dev/null >"$log" 2>&1 8>&- 9>&-) &
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
