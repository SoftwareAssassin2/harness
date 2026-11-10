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
#   make_room <command> <project> <bytes> <vm> [volume]   # least recently accessed deletable VMs deleted until <vm>'s <bytes> fit, within the
#                                             # project's limit (not with volume) and the volume's free space; 3, deleting none, when they cannot ($room_short, $room_long)
#   delete_vm <command> <project> <vm>        # deleted, and dropped from the inventory and the forwarder tokens (make_room's, reclaim's, vm:delete's: ASS-325)
#   build_in_progress <project>               # a golden image build of it runs now (its build lock held, or a started one still going: ASS-289)
#   delete_build <command> <project>          # golden-<project>-build deleted, under its build lock (not waited for); fails while a build holds it
#   reclaim_generations <command> <project> [dry-run]   # the project's deletable VMs of an older golden generation deleted (ASS-287); prints what was, and what was kept
#   volume_free                               # the bytes free on the volume holding LIMA_HOME (df)
#   reclaim_all <command> [dry-run]           # every project's deletable VMs deleted, least recently accessed first across all, until that volume is back above disk-free-warn-gb (ASS-288)
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
source "$here_vm/disk.bash"
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
# last-accessed, credential-kind, credential-stamps } } — credential-kind the kind vm:credentials
# last injected ('claude', 'anthropic' or 'both' (ASS-217), or absent for a
# project that declares neither, ASS-215); credential-stamps, { "<kind>":
# "<mdat>" }, the keychain modification time of each item it injected
# (ASS-350: never a value; absent on a VM not started since). Written when a VM is created (before it is
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
# credential-kind?, golden-built-at, old-generation }], golden-bytes, golden-built-at,
# golden-build }, oldest access first.
# A VM's disk is its own disk files' (disk, or diffdisk
# and basedisk) APFS private size, the blocks no clone shares (private-size.c,
# ASS-69 AC3) — while it is a clone of the current golden-<project>, the blocks
# it shares being the image's. Generations (ASS-287): a VM holds a copy of the
# label of the image it was cloned from (vm:create), and every rebuild deletes
# the image — but on APFS a deleted file's blocks stay allocated while any clone
# references them, so a VM whose label's generation is not golden-<project>'s
# now (old-generation) pins its old
# image's blocks, and is charged its disk files' allocated bytes: the private
# size cannot tell blocks shared with the current image from blocks shared with a
# deleted one, and none of it is the current image's. (Sibling clones of one old
# generation are each charged the blocks they share: they are freed only once all
# go.) With no labelled golden-<project> no VM is of an old generation. A
# label's generation (ASS-291) is its generation id, unique to each build
# (vm:build-golden), else — a label from before it — its built-at: whole
# seconds, which two builds may share, and then a VM of the last image looked
# current. golden-built-at stays the label's built-at (null without one). The
# golden images — golden-<project> and a golden-<project>-build left over —
# are counted apart, allocated (golden-bytes: AC3); the registry cache is not.
# A golden-<project>-build (ASS-289) is no ticket's VM, and is never in vms.json
# or vms: golden-build is { name, state, disk-bytes (allocated, in golden-bytes
# too), last-accessed (its disk last written), leftover, deletable }, null with
# none. Leftover: no build of the project is in progress (build_in_progress) —
# a failed build's VM, which vm:build-golden stops as it fails; one in progress
# stops and starts its VM between steps, so its state alone cannot tell.
# Deletable: leftover and not running — and never where limactl is blind to
# the boot session (above), its state unknown there. make_room and reclaim_all
# delete a deletable one before any ticket VM.
# Deletable: stopped, and its variation is not in flight — gone from the
# active sprint, set aside (is-deleted), or at a step where it needs no VM. A
# step says so with `vm` (running or stopped, ASS-75), the deepest level of
# the variation's status that sets it deciding; a VM whose variation is at
# one that sets either is in flight, whatever it is now. One that sets
# `released` (ASS-325: QA, say, where control deletes it at once through
# vm:delete) needs none, as one that sets no `vm`.
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

# accessed_at <instance folder> — when its disk (else the folder) was last written.
accessed_at() { date -u -r "$( [[ -f "$1/disk" ]] && echo "$1/disk" || echo "$1")" +%Y-%m-%dT%H:%M:%SZ; }

golden_bytes() { disk_bytes "$(limactl list "golden-$1" --format '{{.Dir}}' 2>/dev/null)" 2; }

# built_at <instance folder> — the built-at of the golden image label in it, empty without one.
built_at() { jq -r '.["built-at"] // empty' "$1/golden-image.json" 2>/dev/null || true; }
# generation_of <instance folder> — the generation of the golden image label in it (ASS-291): its generation id, else its built-at; empty without one.
generation_of() { jq -r '.generation // .["built-at"] // empty' "$1/golden-image.json" 2>/dev/null || true; }

# volume_free — df's free bytes on the volume holding LIMA_HOME (its nearest existing folder: disk.bash volume_of).
volume_free() { local line; line="$(volume_of "$LIMA_HOME")" || return 1; echo "${line%%$'\t'*}"; }

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
  local command="$1" project="$2" file listing sprint recorded measured="{}" name dir limit blind=false current="" current_at="" golden=0 generation old build=null leftover
  file="$(vms_file "$project")"
  sysctl -n kern.bootsessionuuid >/dev/null 2>&1 || blind=true
  limit="$(vm_disk_limit "$command" "$project")" || return 1
  listing="$({ limactl list --format $'{{.Name}}\t{{.Status}}\t{{.Dir}}' 2>/dev/null || true; } \
    | jq -Rn '[inputs | split("\t") | select(length == 3) | { key: .[0], value: { status: .[1], dir: .[2] } }] | from_entries')"
  sprint="$(sprint_file "$command" "$project" 2>/dev/null)"; [[ -f "$sprint" ]] || sprint=/dev/null   # none: $s[0] is null
  recorded="$(jq -nc --slurpfile s "$sprint" '[$s[0] | (.features, .bugs, .spikes) // [] | .[] | .key as $k | .variations // [] | .[] | select(.vm.name) | { key: .vm.name, value: { ticket: $k, variation: .name } }] | from_entries')"
  for name in "golden-$project" "golden-$project-build"; do
    dir="$(jq -r --arg n "$name" '.[$n].dir // empty' <<<"$listing")"
    [[ -z "$dir" ]] || golden=$(( golden + $(disk_bytes "$dir" 2) ))
    [[ -z "$dir" || "$name" != "golden-$project" ]] || { current="$(generation_of "$dir")" current_at="$(built_at "$dir")"; }
  done
  dir="$(jq -r --arg n "golden-$project-build" '.[$n].dir // empty' <<<"$listing")"
  if [[ -n "$dir" ]]; then
    leftover=true; ! build_in_progress "$project" || leftover=false
    build="$(jq -c --arg n "golden-$project-build" --argjson b "$(disk_bytes "$dir" 2)" --arg at "$(accessed_at "$dir")" --argjson leftover "$leftover" --argjson blind "$blind" \
      '.[$n].status as $s | { name: $n, state: $s, "disk-bytes": $b, "last-accessed": $at, leftover: $leftover, deletable: ($leftover and $s != "Running" and ($blind | not)) }' <<<"$listing")"
  fi
  while IFS=$'\t' read -r name dir; do
    [[ -n "$name" ]] || continue
    generation="$(generation_of "$dir")" old=false
    [[ -z "$current" || "$generation" == "$current" ]] || old=true
    measured="$(jq -c --arg n "$name" --argjson b "$(disk_bytes "$dir" "$( [[ $old == true ]] && echo 2 || echo 1)")" --arg at "$(accessed_at "$dir")" \
      --arg g "$(built_at "$dir")" --argjson old "$old" '.[$n] = { bytes: $b, accessed: $at, "built-at": (if $g == "" then null else $g end), old: $old }' <<<"$measured")"
  done < <(jq -rn --slurpfile v "$file" --slurpfile l <(printf '%s' "$listing") --slurpfile r <(printf '%s' "$recorded") \
    '$l[0] as $l | $v[0] + $r[0] | keys[] | select($l[.]) | "\(.)\t\($l[.].dir)"')
  update_json "$file" --slurpfile l <(printf '%s' "$listing") --slurpfile r <(printf '%s' "$recorded") --slurpfile m <(printf '%s' "$measured") --argjson blind "$blind" \
    '. as $old | $l[0] as $l | $r[0] as $r
    | $m[0] | with_entries(.key as $n | .value = (($old[$n] // ($r[$n] + { "last-accessed": .value.accessed }))
      + { state: (if $blind and $old[$n].state then $old[$n].state else $l[$n].status end), "disk-bytes": .value.bytes }))'
  jq -n --slurpfile vms "$file" --slurpfile s "$sprint" --slurpfile m <(printf '%s' "$measured") --argjson golden "$golden" --argjson build "$build" --arg current "$current_at" --slurpfile e <(engine_files "$project" | { mapfile -t list; jq -n 'reduce inputs as $e ({}; .[input_filename | split("/") | .[-2]] = ($e.steps // []))' /dev/null "${list[@]}"; }) \
    --arg p "$project" --argjson limit "$limit" '
    $s[0] as $sprint | $e[0] as $engines
    | def use($v): [$v["harness-status"] | recurse(.["sub-status"] // empty) | select(.state != null) | . as $l
      | ($engines[$l["state-engine"]] // [] | map(select(.id == $l.state)) | first | .vm) // empty] | last;
    def live($e): first(($sprint // {}) | (.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($e.ticket | ascii_downcase))
      | .variations // [] | .[] | select(.name == $e.variation and (.["is-deleted"] | not))) // null;
    ($vms[0] | to_entries | map({ name: .key } + .value | . + { deletable: (.state != "Running" and (live(.) as $v | $v == null or (use($v) | . == null or . == "released"))),
        "golden-built-at": $m[0][.name]["built-at"], "old-generation": $m[0][.name].old })
      | sort_by(.["last-accessed"], .name)) as $list
    | { project: $p, "limit-bytes": $limit, "use-bytes": ($list | map(.["disk-bytes"]) | add // 0), "golden-bytes": $golden,
        "golden-built-at": (if $current == "" then null else $current end), "golden-build": $build, vms: $list }'
}

# make_room (ASS-75, ASS-287 AC3; ASS-289: a deletable golden-<project>-build,
# a failed build left over, is deleted first, before any ticket VM): first the project's limit — its VMs' use
# plus its golden images' (golden-bytes) plus <bytes> — unless given volume (a
# golden image build: not a ticket's VM); then the free space df reports on the
# volume holding LIMA_HOME, which every project's VMs, the golden images and
# whatever else is there share. Either way, when deleting every deletable VM
# of the project's could not make room, it deletes none and returns 3 with the
# reason in $room_short and $room_long (on stderr too); else it deletes them,
# least recently accessed first, until there is room — for the volume, reading
# df again after each, as a deleted clone frees only the blocks no other file
# shares (an estimate beforehand: its disk-bytes); short still once none is
# left, it returns 3 as well.
make_room() {
  local command="$1" project="$2" need="$3" vm="$4" scope="${5:-}" inventory limit use golden free avail bytes taken
  inventory="$(reconcile_vms "$command" "$project")" || return 1
  # .deletable: what may go, in the order it goes — the leftover build, then the VMs, least recently accessed first.
  inventory="$(jq -c '. + { deletable: ([.["golden-build"] // empty | select(.deletable) | { name, "disk-bytes", "last-accessed", build: true }]
    + [.vms[] | select(.deletable) | { name, "disk-bytes", ticket, variation, "last-accessed", build: false }]) }' <<<"$inventory")"
  read -r limit use golden free < <(jq -r '[.["limit-bytes"], .["use-bytes"], .["golden-bytes"], (.deletable | map(.["disk-bytes"]) | add // 0)] | @tsv' <<<"$inventory")
  if [[ "$scope" != volume ]]; then
    if (( use + golden - free + need > limit )); then
      room_short="VM disk limit reached"
      room_long="$project's VMs use $(gb "$use") GB of its $(gb "$limit") GB VM disk limit (vm-disk-limit-gb), and $vm needs $(gb "$need") GB (golden-$project's size); its golden images take $(gb "$golden") GB of it; nothing more may be deleted: every other VM is running or its variation still in flight. Free space by finishing or setting aside variations, or raise vm-disk-limit-gb."
      echo "$command: $room_long" >&2
      return 3
    fi
    taken=$(( use + golden ))   # a deleted build was among the golden images, a VM among the use
    while (( taken + need > limit )); do
      room_delete "within $project's VM disk limit" || return 1
      taken=$(( taken - bytes )) free=$(( free - bytes ))
    done
  fi
  avail="$(volume_free 2>&1)" || { echo "$command: $avail" >&2; return 1; }
  (( avail < need )) || return 0
  while :; do
    if (( avail + free < need )) || ! jq -e '.deletable | length > 0' <<<"$inventory" >/dev/null; then
      room_short="Disk volume full"
      room_long="The volume holding $LIMA_HOME has $(gb "$avail") GB free, and $vm needs $(gb "$need") GB (golden-$project's size): $(gb $(( need - avail ))) GB short; nothing more of $project's VMs may be deleted: every other is running or its variation still in flight. Free space on the volume (other projects' VMs, old golden images, other files), or finish or set aside variations."
      echo "$command: ${room_long/#The/the}" >&2
      return 3
    fi
    room_delete "on the volume holding $LIMA_HOME: $(gb "$avail") GB free, and $vm needs $(gb "$need") GB" || return 1
    free=$(( free - bytes ))
    avail="$(volume_free 2>&1)" || { echo "$command: $avail" >&2; return 1; }
    (( avail < need )) || return 0
  done
}

# room_delete <why> — make_room's: the first of $inventory's deletable (the leftover build, else the least recently
# accessed VM) deleted, and taken out of it; $bytes its disk-bytes.
room_delete() {
  local name ticket variation accessed build
  IFS=$'\t' read -r name bytes accessed build ticket variation < <(jq -r 'first(.deletable[]) | [.name, .["disk-bytes"], .["last-accessed"], .build, .ticket, .variation] | @tsv' <<<"$inventory")
  if [[ "$build" == true ]]; then
    delete_build "$command" "$project" || return 1
    echo "$command: deleted $name ($project's leftover golden image build, last accessed $accessed, $(gb "$bytes") GB) to make room $1" >&2
  else
    delete_vm "$command" "$project" "$name" || return 1
    echo "$command: deleted $name ($ticket $variation, last accessed $accessed, $(gb "$bytes") GB) to make room $1" >&2
  fi
  inventory="$(jq -c --arg n "$name" '.deletable |= map(select(.name != $n))' <<<"$inventory")"
}

delete_vm() {
  limactl delete -f "$3" >/dev/null 2>&1 || { echo "$1: could not delete $3" >&2; return 1; }
  update_json "$(vms_file "$2")" --arg n "$3" 'del(.[$n])'
  [[ ! -f "$tokens_file" ]] || update_json "$tokens_file" --arg n "$3" 'del(.[$n])'
}

# build_in_progress <project> (ASS-289) — a golden image build of it runs: one
# holds its build lock (vm:build-golden, to its end), or the one
# vm:build-golden-start started last is still going (no exit code, its process
# alive: golden.bash golden_status's "building").
build_in_progress() {
  local dir="$projects/$1" pid
  perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or exit 1; exit(flock($f, LOCK_EX | LOCK_NB) ? 1 : 0)' "$dir/golden-build.lock" && return 0
  [[ ! -f "$dir/golden-build-run.exit" ]] || return 1
  pid="$(jq -r '.pid // empty' "$dir/golden-build-run.json" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# delete_build <command> <project> (ASS-289) — golden-<project>-build deleted
# while holding the project's build lock, so no build starts meanwhile (a
# vm:build-golden then refuses, as with any build running); taken without
# waiting: held, a build is in progress and nothing is deleted.
delete_build() {
  perl -MFcntl=:flock -e 'open(my $f, ">>", shift) or exit 2; flock($f, LOCK_EX | LOCK_NB) or exit 3; exit(system(@ARGV) == 0 ? 0 : 1)' \
    "$projects/$2/golden-build.lock" limactl delete -f "golden-$2-build" >/dev/null 2>&1 \
    || { echo "$1: could not delete golden-$2-build (or a build of $2 started)" >&2; return 1; }
}

# reclaim_generations (ASS-287 AC1): golden-<project>'s rebuild leaves the VMs
# cloned from the image it deleted pinning that image's blocks (reconcile_vms).
# Each one of an old generation that is deletable — stopped, its variation not
# in flight — is deleted, as make_room would; a running or in-flight one is
# never touched, but kept, and named, until its variation ends (the next build
# or vm:reclaim takes it then). Prints { project, golden-built-at, dry-run,
# deleted: [{ name, ticket, variation, golden-built-at, disk-bytes }], kept:
# [{ …, why }] } — with dry-run, those it would delete, deleting none. The
# caller holds the project's VM lock.
reclaim_generations() {
  local command="$1" project="$2" dry="${3:-}" plan name
  plan="$(reconcile_vms "$command" "$project" | jq --argjson dry "$( [[ -n "$dry" ]] && echo true || echo false)" '
    def it: { name, ticket, variation, "golden-built-at", "disk-bytes" };
    { project, "golden-built-at", "dry-run": $dry,
      deleted: [.vms[] | select(.["old-generation"] and .deletable) | it],
      kept: [.vms[] | select(.["old-generation"] and (.deletable | not)) | it + { why: (if .state == "Running" then "running" else "its variation is in flight" end) }] }')" || return 1
  if [[ -z "$dry" ]]; then
    for name in $(jq -r '.deleted[].name' <<<"$plan"); do delete_vm "$command" "$project" "$name" || return 1; done
  fi
  echo "$plan"
}

# reclaim_all (ASS-288): below disk-free-warn-gb on the volume holding
# LIMA_HOME, the deletable VMs of every project — stopped, their variation not
# in flight: reconcile_vms's deletable, as make_room deletes — are deleted,
# every project's leftover golden-<project>-build first (ASS-289: a failed
# build's, deletable when stopped and no build is in progress), then the VMs
# least recently accessed first across all of them, until df says the volume
# is back at or above the warn level or none is left. Each project's inventory
# is read under its VM lock, one project at a time; each deletion takes that
# project's lock again and reconciles first, so a VM started or put back in
# flight since is skipped (no two locks are ever held at once). Each deletion
# is said on stderr with its VM, project, ticket, variation, last access and
# the bytes df says it freed. Prints { dry-run, warn-bytes, free-bytes-before,
# free-bytes, deleted: [{ project, name, kind, ticket, variation, last-accessed,
# disk-bytes, freed-bytes }], short } — kind leftover-golden-build (ticket and
# variation null) or ticket-vm; — short: still below the warn level.
# With dry-run, those it would delete — counting each one's disk-bytes as
# freed — deleting none. A project whose inventory cannot be read is passed
# over, said on stderr.
reclaim_all() {
  local command="$1" dry="${2:-}" warn hold free before candidates="[]" deleted="[]" dir project inventory next name kind bytes ticket variation accessed after freed what
  read -r warn hold < <(disk_levels "$command") || true
  [[ -n "${warn:-}" ]] || return 1
  free="$(volume_free 2>&1)" || { echo "$command: $free" >&2; return 1; }
  before="$free"
  if (( free < warn )); then
    for dir in "$projects"/*/; do
      project="$(basename "$dir")"
      [[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$dir/project.json" ]] || continue
      lock_vms "$command" "$project" || { echo "$command: $project passed over: its VM lock could not be taken" >&2; continue; }
      inventory="$(reconcile_vms "$command" "$project")" || { unlock_vms; echo "$command: $project passed over: its inventory could not be read" >&2; continue; }
      unlock_vms
      candidates="$(jq -c --slurpfile c <(printf '%s' "$candidates") --arg p "$project" \
        '$c[0] + [.["golden-build"] // empty | select(.deletable) | { project: $p, name, kind: "leftover-golden-build", ticket: null, variation: null, "last-accessed", "disk-bytes" }]
         + [.vms[] | select(.deletable) | { project: $p, name, kind: "ticket-vm", ticket, variation, "last-accessed", "disk-bytes" }]' <<<"$inventory")"
    done
    candidates="$(jq -c 'sort_by(.kind != "leftover-golden-build", .["last-accessed"], .name)' <<<"$candidates")"
  fi
  while (( free < warn )); do
    next="$(jq -c 'first(.[]) // empty' <<<"$candidates")"
    [[ -n "$next" ]] || break
    candidates="$(jq -c '.[1:]' <<<"$candidates")"
    IFS=$'\t' read -r project name kind bytes accessed ticket variation < <(jq -r '[.project, .name, .kind, .["disk-bytes"], .["last-accessed"], .ticket, .variation] | @tsv' <<<"$next")
    if [[ -n "$dry" ]]; then
      deleted="$(jq -c --argjson x "$next" '. + [$x + { "freed-bytes": $x["disk-bytes"] }]' <<<"$deleted")"
      free=$(( free + bytes ))
      continue
    fi
    lock_vms "$command" "$project" || { echo "$command: $name passed over: $project's VM lock could not be taken" >&2; continue; }
    if [[ "$kind" == leftover-golden-build ]]; then
      if ! reconcile_vms "$command" "$project" | jq -e --arg n "$name" '.["golden-build"] | . != null and .name == $n and .deletable' >/dev/null; then
        unlock_vms; echo "$command: $name passed over: it runs or a build of $project is in progress now" >&2; continue
      fi
      delete_build "$command" "$project" || { unlock_vms; continue; }
      what="$project's leftover golden image build"
    else
      if ! reconcile_vms "$command" "$project" | jq -e --arg n "$name" 'any(.vms[]; .name == $n and .deletable)' >/dev/null; then
        unlock_vms; echo "$command: $name passed over: it runs or its variation is in flight now" >&2; continue
      fi
      delete_vm "$command" "$project" "$name" || { unlock_vms; continue; }
      what="$project $ticket $variation"
    fi
    unlock_vms
    after="$(volume_free 2>&1)" || { echo "$command: $after" >&2; return 1; }
    freed=$(( after > free ? after - free : 0 ))
    free="$after"
    deleted="$(jq -c --argjson x "$next" --argjson f "$freed" '. + [$x + { "freed-bytes": $f }]' <<<"$deleted")"
    echo "$command: deleted $name ($what, last accessed $accessed): $freed bytes freed ($(gib "$freed") GiB), $(gib "$free") GiB free" >&2
  done
  jq -n --argjson d "$deleted" --argjson dry "$( [[ -n "$dry" ]] && echo true || echo false)" --argjson w "$warn" --argjson b "$before" --argjson f "$free" \
    '{ "dry-run": $dry, "warn-bytes": $w, "free-bytes-before": $b, "free-bytes": $f, deleted: $d, short: ($f < $w) }'
}
