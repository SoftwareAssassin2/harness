# A project's cloud VM (ASS-481): a plain GCP Compute Engine VM of its
# dev-environments' cloud-vms (src/control/dev-environments.js), the remote
# machine a workstation is (ASS-433..435, ASS-468): reached over one SSH
# connection, set up, claimed per step. Only what is a VM's own differs, and
# is here; workstation.bash sources this file and runs these where a
# workstation runs gcloud workstations (its settings' kind cloud-vm says
# which), and machine-cloud-vm.bash is its machine-layer backend.
#
#   cvm_gcloud <settings> <subcommand> [args…]   # gcloud compute instances <subcommand> <id> --zone … --project …, quiet,
#                                                # under its gcloud-config's CLOUDSDK_CONFIG when it names one
#   cvm_state <settings>        # its state, lower case, a workstation's words: running, stopped (TERMINATED), suspended,
#                               # starting (PROVISIONING, STAGING), stopping, suspending, repairing; fails, gcloud's output on stderr
#   cvm_user <settings>         # the Linux user it is reached as: its ssh-user, else the OS Login user of the gcloud
#                               # login's account (ada.lovelace@example.com → ada_lovelace_example_com)
#   cvm_iap_command <settings>  # the ssh ProxyCommand: gcloud compute start-iap-tunnel <id> 22 --listen-on-stdin …
#   cvm_banner <settings>       # one probe: the guest's SSH banner answers through the IAP tunnel within
#                               # CLOUD_VM_PROBE_SECONDS (10)
#   cvm_open <project> <id> <settings> <port…>   # the master connection opened, as workstation_open (below)
#
# The connection (AC2). A VM has no `gcloud workstations ssh` doing tunnel and
# master in one process; it has IAP's start-iap-tunnel, which speaks the
# tunnel on stdin and stdout (--listen-on-stdin), so OpenSSH itself is the
# master, the tunnel its ProxyCommand:
#   ssh -M -S <socket> -N -T -o ExitOnForwardFailure=yes -o BatchMode=yes
#     -o ServerAliveInterval=30 -o ServerAliveCountMax=4
#     -o "ProxyCommand=gcloud … compute start-iap-tunnel <id> 22 --listen-on-stdin --zone … --project …"
#     -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
#     -i ~/.ssh/google_compute_engine -o IdentitiesOnly=yes -l <user>
#     -R 127.0.0.1:<port>:127.0.0.1:<port> … cloud-vm-<id>
# OS Login authorises the user's key (gcloud's own, ~/.ssh/google_compute_
# engine, the operator's `ssh harness-vm` key); IAP authenticates the VM end
# (only the instance named is reached), so its host key is not pinned — as the
# operator's ~/.ssh/config.d/harness-vm does: a VM made again would otherwise
# be refused. The ProxyCommand runs under the VM's CLOUDSDK_CONFIG, given to
# ssh's environment. -N -T: no command and no terminal, so the connection
# never opens a pts session — the VM's own idle stop (no
# interactive pts login, no claude or codex process, low load for 60 minutes)
# is not held off by it (AC4); every session over it is a channel without a
# terminal too (workstation_ssh). ServerAliveInterval keeps a dead tunnel from
# hanging the master. Each session over it is a workstation's: ssh -S <socket>
# … workstation-<id> (workstation.bash), the name never resolved.
#
# Starting (AC2) is workstation:connect's (connect.sh): describe; start
# (TERMINATED) or resume (SUSPENDED), --async, and wait out STOPPING and
# SUSPENDING; poll until RUNNING; then, when it was not running at first,
# wait for the guest's SSH banner through IAP (RUNNING comes before sshd is
# up: ~60 seconds from stopped to a prompt, tested 2026-11-17), probe after
# probe, up to CLOUD_VM_SSH_TIMEOUT seconds (180); a timeout recorded as the
# live data's last-error of kind timeout ("start timed out"). The pattern is
# the operator's ~/.local/bin/harness-vm-proxy's.
here_cvm="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

# cvm_fields <settings> — sets cvm_id, cvm_project, cvm_zone, cvm_config from the settings' JSON line.
cvm_fields() {
  IFS=$'\t' read -r cvm_id cvm_project cvm_zone cvm_config < <(jq -r '[.id, .["gcp-project"], .zone, (.["gcloud-config"] // "")] | @tsv' <<< "$1")
}

cvm_gcloud() {
  local sub="$2"
  cvm_fields "$1"; shift 2
  env ${cvm_config:+CLOUDSDK_CONFIG="$cvm_config"} gcloud --quiet --verbosity=error compute instances "$sub" "$cvm_id" --zone="$cvm_zone" --project="$cvm_project" "$@"
}

cvm_state() {
  local out
  out="$(cvm_gcloud "$1" describe --format='value(status)' 2>&1)" || { printf '%s\n' "$out" >&2; return 1; }
  out="$(tail -n 1 <<< "$out" | tr -d '[:space:]')"
  case "$out" in
    RUNNING) echo running ;;
    TERMINATED|STOPPED) echo stopped ;;
    PROVISIONING|STAGING) echo starting ;;
    SUSPENDED|SUSPENDING|STOPPING|REPAIRING) tr '[:upper:]' '[:lower:]' <<< "$out" ;;
    "") echo "gcloud compute instances describe printed no status" >&2; return 1 ;;
    *) tr '[:upper:]' '[:lower:]' <<< "$out" ;;
  esac
}

cvm_user() {
  local user account
  user="$(jq -r '.["ssh-user"] // empty' <<< "$1")"
  if [[ -z "$user" ]]; then
    cvm_fields "$1"
    account="$(env ${cvm_config:+CLOUDSDK_CONFIG="$cvm_config"} gcloud --quiet config get-value account 2>/dev/null | tail -n 1 | tr -d '[:space:]')"
    [[ -n "$account" ]] || { echo "no ssh-user, and the gcloud login${cvm_config:+ under $cvm_config} has no account to take its OS Login user from" >&2; return 1; }
    user="$(tr '[:upper:]' '[:lower:]' <<< "$account" | sed 's/[^a-z0-9]/_/g')"
  fi
  echo "$user"
}

cvm_iap_command() {
  cvm_fields "$1"
  printf 'gcloud --quiet --verbosity=error compute start-iap-tunnel %q 22 --listen-on-stdin --zone=%q --project=%q' "$cvm_id" "$cvm_zone" "$cvm_project"
}

cvm_banner() {
  local line="" pid rfd wfd
  cvm_fields "$1"
  coproc CVM_PROBE { exec env ${cvm_config:+CLOUDSDK_CONFIG="$cvm_config"} gcloud --quiet --verbosity=none compute start-iap-tunnel "$cvm_id" 22 --listen-on-stdin --zone="$cvm_zone" --project="$cvm_project" 2>/dev/null 8>&- 9>&-; }
  # A tunnel that fails at once may be reaped, its descriptors gone, before they are read: a failed probe.
  pid="${CVM_PROBE_PID:-}" rfd="${CVM_PROBE[0]:-}" wfd="${CVM_PROBE[1]:-}"
  [[ -z "$rfd" ]] || IFS= read -r -t "${CLOUD_VM_PROBE_SECONDS:-10}" -u "$rfd" line 2>/dev/null || true
  # Its stdin closed (the tunnel ends on EOF) and the process ended: a probe never lingers.
  [[ -z "$wfd" ]] || eval "exec $wfd>&-" 2>/dev/null || true
  [[ -z "$rfd" ]] || eval "exec $rfd<&-" 2>/dev/null || true
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  [[ "$line" == SSH-* ]]
}

# cvm_master_argv <project> <id> <settings> <port…> — cvm_argv, the master's ssh (above).
cvm_master_argv() {
  local project="$1" id="$2" settings="$3" user port; shift 3
  user="$(cvm_user "$settings")" || return 1
  cvm_argv=(ssh -M -S "$(workstation_control_path "$project" "$id")" -N -T -o ExitOnForwardFailure=yes -o BatchMode=yes
    -o ServerAliveInterval=30 -o ServerAliveCountMax=4 -o "ProxyCommand=$(cvm_iap_command "$settings")"
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
    -i "${CLOUD_VM_SSH_KEY:-$HOME/.ssh/google_compute_engine}" -o IdentitiesOnly=yes -l "$user")
  for port in "$@"; do cvm_argv+=(-R "127.0.0.1:$port:127.0.0.1:$port"); done
  cvm_argv+=("cloud-vm-$id")
}

# cvm_exec <settings> <argv…> — argv exec'd under the VM's CLOUDSDK_CONFIG (the master's ProxyCommand runs under it).
cvm_exec() {
  cvm_fields "$1"; shift
  exec env ${cvm_config:+CLOUDSDK_CONFIG="$cvm_config"} "$@"
}

cvm_open() {
  local project="$1" id="$2" settings="$3"; shift 3
  cvm_master_argv "$project" "$id" "$settings" "$@" || return 1
  ws_open_master "$project" "$id" bash -c "source '$here_cvm/workstation.bash' && cvm_exec \"\$@\"" _ "$settings" "${cvm_argv[@]}"
}
