# A ticket variation's VM (ASS-74), for vm:create and vm:start.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
#   vm_name <ticket-key> <variation>          # <key>-<variation>, lower case: ass-74-a
#   ticket_folder <command> <project> <key>   # the ticket's folder on the Mac, absolute, made if missing
#   variation_exists <command> <project> <key> <variation>   # fails, naming <command>, when the active sprint has no such variation
#   recorded_vm <command> <project> <key> <variation>  # the VM recorded on the variation (ticket:set-vm); fails, naming why, without one
#   running_vm <command> <project> <key> <variation>   # that VM when it is running; fails, naming why, else
#   $setup_marker                             # the file in a VM whose Setup finished (ASS-68: vm:mark-setup-complete, vm:setup-complete)
#   free_port                                 # a TCP port free on the Mac's loopback now: a clone's ssh.localPort
#   start_sandboxed <command> <vm> <display> <port…>   # limactl start, its video.display <display> (none or vz), its host agent let reach the Mac's loopback only at <port…> and the VM's ssh port
#
# A project's VMs and their disk (ASS-75):
#   lock_vms <command> <project>              # the project's VM lock (descriptor 8) until unlock_vms or exit: every start, stop, clone and delete
#   unlock_vms
#   record_vm <project> <vm> <ticket-key> <variation> <state> [<credential-kind>]   # its inventory entry, accessed now; the kind kept when not given
#   reconcile_vms <command> <project>         # the inventory reconciled, and printed (vm:inventory)
#   golden_bytes <project>                    # golden-<project>'s disk, allocated: what a new VM is charged
#   make_room <command> <project> <bytes> <vm>   # least recently accessed deletable VMs deleted until <vm>'s <bytes> fit; 3, deleting none, when they cannot ($room_short, $room_long)
#
# One VM per ticket variation, a copy-on-write clone of the project's golden
# image (golden-<project>, vm:build-golden) under LIMA_HOME (lima-home.bash:
# the env var, else harness.local.json's lima-home, else harness.json's, else ~/.lima). Ticket keys are unique across projects, so
# the name is too. The ticket's folder is data/projects/<project>/work/<KEY> — an
# off-board ticket's in its home project's, as every agent's (prompt.bash
# work_folder) — and is the only thing of the Mac's a VM has, read-only, at
# /mnt/ticket (ASS-182: a VM writes it only through its agent.sh).
# $agent is the repo's agent.sh; $harness_file data/harness.json (HARNESS_FILE
# overrides it); $tokens_file where vm:start keeps each VM's forwarder token,
# hashed, and its binding: $HARNESS_HOME/vm-tokens.json (~/.harness by default).
here_vm="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here_vm/sprint.bash"
source "$here_vm/ticket-system.bash"
source "$here_vm/lima-home.bash"
LIMA_HOME="$(lima_home)"; export LIMA_HOME
agent="$here_vm/../../agent.sh"
harness_file="${HARNESS_FILE:-$here_vm/../../data/harness.json}"
tokens_file="${HARNESS_HOME:-$HOME/.harness}/vm-tokens.json"

setup_marker=/repos/.setup-complete

vm_name() { tr '[:upper:]' '[:lower:]' <<< "$1-$2"; }

ticket_folder() {
  local home key
  home="$(home_project "$1" "$2" "$3")" || return 1
  key="$(tr '[:lower:]' '[:upper:]' <<< "$3")"
  mkdir -p "$projects/$home/work/$key"
  echo "$(cd "$projects/$home/work/$key" && pwd -P)"
}

variation_exists() {
  [[ "$3" =~ ^[A-Za-z0-9-]+$ && "$4" =~ ^[A-Za-z0-9]+$ ]] || { echo "$1: invalid ticket '$3' or variation '$4'" >&2; return 1; }
  variation_status "$@" >/dev/null 2>&1 || { echo "$1: no $3 variation $4 in $2's active sprint" >&2; return 1; }
}

recorded_vm() {
  local file vm
  variation_exists "$@" || return 1
  file="$(sprint_file "$1" "$2")" || return 1
  vm="$(jq -r --arg key "$3" --arg name "$4" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
    | first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) | .vm.name // empty' "$file")"
  [[ -n "$vm" ]] || { echo "$1: $3 $4 has no VM: vm:create it first" >&2; return 1; }
  echo "$vm"
}

running_vm() {
  local vm
  vm="$(recorded_vm "$@")" || return 1
  [[ "$(limactl list "$vm" --format '{{.Status}}' 2>/dev/null)" == Running ]] || { echo "$1: $vm is not running" >&2; return 1; }
  echo "$vm"
}

free_port() { node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })'; }

# The sandbox vm:start explains (step 1): the VM must have an ssh port of its
# own (ssh.localPort, pinned when it was cloned) for the profile to allow.
start_sandboxed() {
  local command="$1" vm="$2" display="$3" ssh port allowed="" profile; shift 3
  [[ "$(limactl list "$vm" --format '{{.Config.Video.Display}}')" == "$display" ]] \
    || limactl edit --tty=false "$vm" --set ".video.display = \"$display\"" >/dev/null 2>&1 || { echo "$command: could not set $vm's video.display to $display" >&2; return 1; }
  ssh="$(limactl list "$vm" --format '{{.SSHLocalPort}}')"
  [[ "$ssh" =~ ^[1-9][0-9]*$ ]] || { echo "$command: $vm has no ssh port of its own (ssh.localPort); vm:create pins one" >&2; return 1; }
  for port in "$@" "$ssh"; do allowed+=" (remote ip \"localhost:$port\")"; done
  profile="(version 1)
(allow default)
(deny network-outbound (remote ip \"*:*\"))
(allow network-outbound$allowed)"
  # Its host agent outlives this shell: started without the VM lock's descriptor (lock_vms), or it would hold the lock.
  sandbox-exec -p "$profile" limactl start --tty=false "$vm" >/dev/null 2>&1 8>&- || { echo "$command: $vm would not start (see $LIMA_HOME/$vm/ha.stderr.log)" >&2; return 1; }
}

# The inventory: data/projects/<project>/vms.json (untracked), one entry per VM of
# the project's — { "<vm>": { ticket, variation, state, disk-bytes,
# last-accessed, credential-kind } } — credential-kind the kind vm:credentials
# last injected ('claude', 'anthropic' or 'both' (ASS-217), or absent for a
# project that declares neither, ASS-215). Written when a VM is created (before it is
# cloned, so a crash cannot hide it), started, stopped or deleted (record_vm,
# make_room).
# "Accessed" is when it was last started or stopped: a VM is used only while
# it runs, and control stops it as its variation stops needing it.
# reconcile_vms makes it what limactl list has: an entry whose VM is gone is
# dropped; a VM recorded on a sprint variation (ticket:set-vm) with no entry
# is taken in, accessed when its disk was last written; each one's state and
# disk-bytes read afresh — but where limactl cannot read the Mac's boot
# session (sysctl kern.bootsessionuuid denied, as in an agent's sandbox) it
# calls every VM "Broken", so there a recorded state is kept (ASS-240). It prints { project, limit-bytes, use-bytes, vms:
# [{ name, ticket, variation, state, disk-bytes, last-accessed, deletable,
# credential-kind? }] }, oldest access first. A VM's disk is its own disk files' (disk, or diffdisk
# and basedisk) APFS private size, the blocks no clone shares (private-size.c,
# ASS-69 AC3); the golden images and the registry cache are not counted.
# Deletable: stopped, and its variation is not in flight — gone from the
# active sprint, set aside (is-deleted), or at a step where it needs no VM. A
# step says so with `vm` (running or stopped, ASS-75), the deepest level of
# the variation's status that sets it deciding; a VM whose variation is at
# one that sets either is in flight, whatever it is now.
# The limit is project.json's vm-disk-limit-gb (GB, 10^9 bytes), within
# harness.json's, every project's default and ceiling: a project's above it
# is held to it, with a warning.
vms_file() { local file="$projects/$1/vms.json"; [[ -f "$file" ]] || update_json --create "$file" .; echo "$file"; }

# VM_LOCK_HELD=1: the caller holds it already (vm:create running vm:start).
lock_vms() { [[ -n "${VM_LOCK_HELD-}" ]] || lock_on 8 "$projects/$2/vms.lock" "$1" "${VM_LOCK_TIMEOUT:-600}"; }
unlock_vms() { exec 8>&-; }

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

record_vm() {
  update_json "$(vms_file "$1")" --arg n "$2" --arg t "$3" --arg v "$4" --arg s "$5" --arg at "$(now)" --arg k "${6-}" \
    '.[$n] = ((.[$n] // { "disk-bytes": 0 }) + { ticket: $t, variation: $v, state: $s, "last-accessed": $at }
              + (if $k == "" then {} else { "credential-kind": $k } end))'
}

# private_size <file…> — "<private> <allocated>" bytes per file; the helper built on first use.
private_size() {
  local bin="${HARNESS_HOME:-$HOME/.harness}/bin/private-size" src="$here_vm/vm/private-size.c"
  if [[ ! -x "$bin" || "$src" -nt "$bin" ]]; then
    mkdir -p "$(dirname "$bin")"
    clang -O2 -o "$bin.$$" "$src" 2>/dev/null && mv -f "$bin.$$" "$bin" || { rm -f "$bin.$$"; echo "private-size: could not build $src (clang)" >&2; return 1; }
  fi
  "$bin" "$@"
}

# disk_bytes <instance folder> <1|2> — its disk files' private (1) or allocated (2) bytes.
disk_bytes() {
  local files=() name
  for name in disk diffdisk basedisk; do [[ -f "$1/$name" ]] && files+=("$1/$name"); done
  [[ ${#files[@]} -gt 0 ]] || { echo 0; return; }
  private_size "${files[@]}" | awk -v c="$2" '{ s += $c } END { printf "%.0f\n", s }'
}

golden_bytes() { disk_bytes "$(limactl list "golden-$1" --format '{{.Dir}}')" 2; }

gb() { jq -n --argjson b "$1" '$b / 1e7 | round / 100'; }

vm_disk_limit() {
  local command="$1" project="$2" bytes how
  read -r bytes how < <(jq -rn --slurpfile h "$harness_file" --slurpfile p "$projects/$project/project.json" '
    $h[0]["vm-disk-limit-gb"] as $c | $p[0]["vm-disk-limit-gb"] as $o
    | if ($c | type) != "number" or $c <= 0 then "- none"
      elif $o != null and (($o | type) != "number" or $o <= 0) then "- bad"
      elif $o != null and $o > $c then "\($c * 1e9 | floor) clamped \($o) \($c)"
      else "\(($o // $c) * 1e9 | floor) -" end')
  case "$how" in
    none) echo "$command: harness.json has no vm-disk-limit-gb (GB): every project's VM disk limit, and its ceiling" >&2; return 1 ;;
    bad) echo "$command: $project's vm-disk-limit-gb is not a positive number" >&2; return 1 ;;
    clamped*) read -r _ own ceiling <<<"$how"; echo "$command: $project's vm-disk-limit-gb ($own) is above harness.json's ($ceiling); $ceiling is used" >&2 ;;
  esac
  echo "$bytes"
}

# The sprint, the engines and what grows with VMs and tickets reach jq through
# files (--slurpfile, a process substitution for one held here), never as
# arguments: past ARG_MAX (1 MB on macOS) jq would not start (ASS-135).
reconcile_vms() {
  local command="$1" project="$2" file listing sprint recorded measured="{}" name dir limit blind=false
  file="$(vms_file "$project")"
  sysctl -n kern.bootsessionuuid >/dev/null 2>&1 || blind=true
  limit="$(vm_disk_limit "$command" "$project")" || return 1
  listing="$({ limactl list --format $'{{.Name}}\t{{.Status}}\t{{.Dir}}' 2>/dev/null || true; } \
    | jq -Rn '[inputs | split("\t") | select(length == 3) | { key: .[0], value: { status: .[1], dir: .[2] } }] | from_entries')"
  sprint="$(sprint_file "$command" "$project" 2>/dev/null)"; [[ -f "$sprint" ]] || sprint=/dev/null   # none: $s[0] is null
  recorded="$(jq -nc --slurpfile s "$sprint" '[$s[0] | (.features, .bugs, .spikes) // [] | .[] | .key as $k | .variations // [] | .[] | select(.vm.name) | { key: .vm.name, value: { ticket: $k, variation: .name } }] | from_entries')"
  while IFS=$'\t' read -r name dir; do
    [[ -n "$name" ]] || continue
    measured="$(jq -c --arg n "$name" --argjson b "$(disk_bytes "$dir" 1)" --arg at "$(date -u -r "$( [[ -f "$dir/disk" ]] && echo "$dir/disk" || echo "$dir")" +%Y-%m-%dT%H:%M:%SZ)" \
      '.[$n] = { bytes: $b, accessed: $at }' <<<"$measured")"
  done < <(jq -rn --slurpfile v "$file" --slurpfile l <(printf '%s' "$listing") --slurpfile r <(printf '%s' "$recorded") \
    '$l[0] as $l | $v[0] + $r[0] | keys[] | select($l[.]) | "\(.)\t\($l[.].dir)"')
  update_json "$file" --slurpfile l <(printf '%s' "$listing") --slurpfile r <(printf '%s' "$recorded") --slurpfile m <(printf '%s' "$measured") --argjson blind "$blind" \
    '. as $old | $l[0] as $l | $r[0] as $r
    | $m[0] | with_entries(.key as $n | .value = (($old[$n] // ($r[$n] + { "last-accessed": .value.accessed }))
      + { state: (if $blind and $old[$n].state then $old[$n].state else $l[$n].status end), "disk-bytes": .value.bytes }))'
  jq -n --slurpfile vms "$file" --slurpfile s "$sprint" --slurpfile e <(engine_files "$project" | { mapfile -t list; jq -n 'reduce inputs as $e ({}; .[input_filename | split("/") | .[-2]] = ($e.steps // []))' /dev/null "${list[@]}"; }) \
    --arg p "$project" --argjson limit "$limit" '
    $s[0] as $sprint | $e[0] as $engines
    | def use($v): [$v["harness-status"] | recurse(.["sub-status"] // empty) | select(.state != null) | . as $l
      | ($engines[$l["state-engine"]] // [] | map(select(.id == $l.state)) | first | .vm) // empty] | last;
    def live($e): first(($sprint // {}) | (.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($e.ticket | ascii_downcase))
      | .variations // [] | .[] | select(.name == $e.variation and (.["is-deleted"] | not))) // null;
    ($vms[0] | to_entries | map({ name: .key } + .value | . + { deletable: (.state != "Running" and (live(.) as $v | $v == null or use($v) == null)) })
      | sort_by(.["last-accessed"], .name)) as $list
    | { project: $p, "limit-bytes": $limit, "use-bytes": ($list | map(.["disk-bytes"]) | add // 0), vms: $list }'
}

make_room() {
  local command="$1" project="$2" need="$3" vm="$4" inventory limit use free name bytes ticket variation accessed
  inventory="$(reconcile_vms "$command" "$project")" || return 1
  read -r limit use free < <(jq -r '[.["limit-bytes"], .["use-bytes"], (.vms | map(select(.deletable) | .["disk-bytes"]) | add // 0)] | @tsv' <<<"$inventory")
  if (( use - free + need > limit )); then
    room_short="VM disk limit reached"
    room_long="$project's VMs use $(gb "$use") GB of its $(gb "$limit") GB VM disk limit (vm-disk-limit-gb), and $vm needs $(gb "$need") GB (golden-$project's size); nothing more may be deleted: every other VM is running or its variation still in flight. Free space by finishing or setting aside variations, or raise vm-disk-limit-gb."
    echo "$command: $room_long" >&2
    return 3
  fi
  while (( use + need > limit )); do
    IFS=$'\t' read -r name bytes ticket variation accessed < <(jq -r 'first(.vms[] | select(.deletable)) | [.name, .["disk-bytes"], .ticket, .variation, .["last-accessed"]] | @tsv' <<<"$inventory")
    limactl delete -f "$name" >/dev/null 2>&1 || { echo "$command: could not delete $name" >&2; return 1; }
    update_json "$(vms_file "$project")" --arg n "$name" 'del(.[$n])'
    [[ ! -f "$tokens_file" ]] || update_json "$tokens_file" --arg n "$name" 'del(.[$n])'
    inventory="$(jq --arg n "$name" '.vms |= map(select(.name != $n))' <<<"$inventory")"
    use=$(( use - bytes ))
    echo "$command: deleted $name ($ticket $variation, last accessed $accessed, $(gb "$bytes") GB) to make room within $project's VM disk limit" >&2
  done
}
