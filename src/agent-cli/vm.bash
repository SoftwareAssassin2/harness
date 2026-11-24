# A ticket variation's VM (ASS-74), for vm:create and vm:start.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
#   vm_name <ticket-key> <variation>          # <key>-<variation>, lower case: ass-74-a
#   ticket_folder <command> <project> <key>   # the ticket's folder on the Mac, absolute, made if missing
#   variation_exists <command> <project> <key> <variation>   # fails, naming <command>, when the active sprint has no such variation
#   recorded_vm <command> <project> <key> <variation>  # the VM recorded on the variation (ticket:set-vm), as machine.bash names a machine; fails, naming why, without one
#   running_vm <command> <project> <key> <variation>   # that VM when it is running (machine_status); fails, naming why, else
#   $setup_marker                             # the file in a VM whose Setup finished (ASS-68: vm:mark-setup-complete, vm:setup-complete)
#   free_port                                 # a TCP port free on the Mac's loopback now that no instance pins: a clone's ssh.localPort (under lock_ports)
#   lock_ports <command> / unlock_ports       # the harness-wide ssh port lock (descriptor 4): from choosing a port until it is written to lima.yaml
#   pinned_ports                              # "<instance>\t<port>" for every instance, in every Lima folder in use (lima_homes), whose lima.yaml pins ssh.localPort
#   ports_in_use <port…>                      # those of the ports something listens on now, on the Mac's loopback
#   ssh_repin <command> <vm>                  # a stopped VM whose pinned port another instance pins, or something holds now, re-pinned to a free one (ASS-467)
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
#   reclaim_all <command> [dry-run]           # on each volume holding a Lima folder below disk-free-warn-gb, the deletable VMs of the projects
#                                             # whose folder it holds deleted, least recently accessed first across them, until it is back above (ASS-288, ASS-578)
#
# One VM per ticket variation, a copy-on-write clone of the project's golden
# image (golden-<project>, vm:build-golden) in the project's Lima folder (lima-home.bash lima_home <project>, ASS-578:
# its project.json lima-home, else the harness-wide one — the LIMA_HOME env var, else harness.local.json's lima-home,
# else harness.json's, else ~/.lima). Sourcing this exports LIMA_HOME as the harness-wide folder (lima_init); a command
# for one project's VMs makes it that project's (lima_use) before its own limactl calls, and the functions below that
# take a project use its folder whatever LIMA_HOME is. Ticket keys are unique across projects, so
# the name is too, across every folder. The ticket's folder is data/projects/<project>/work/<KEY> — an
# off-board ticket's in its home project's, as every agent's (prompt.bash
# work_folder) — and is the only thing of the Mac's a VM has, read-only, at
# /mnt/ticket (ASS-182: a VM writes it only through its agent.sh).
# $agent is the repo's agent.sh; $harness_file data/harness.json (HARNESS_FILE
# overrides it); $tokens_file where vm:start keeps each VM's forwarder token,
# hashed, and its binding: $HARNESS_HOME/vm-tokens.json (~/.harness by default).
# Everything run in, copied to, started, stopped or asked of a variation's VM
# goes through the machine layer (machine.bash, ASS-432: machine_run,
# machine_status, machine_start, …); what stays here is Lima's own — the
# inventory of instances and their disks, and deleting one (lima_list,
# limactl delete).
here_vm="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here_vm/sprint.bash"
source "$here_vm/ticket-system.bash"
source "$here_vm/lima-home.bash"
source "$here_vm/machine.bash"
source "$here_vm/disk.bash"
lima_init
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
    | first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) | '"$machine_of" "$file")"
  [[ -n "$vm" ]] || { echo "$1: $3 $4 has no VM: vm:create it first" >&2; return 1; }
  echo "$vm"
}

running_vm() {
  local vm
  vm="$(recorded_vm "$@")" || return 1
  [[ "$(machine_status "$vm" 2>/dev/null)" == Running ]] || { echo "$1: $vm is not running" >&2; return 1; }
  echo "$vm"
}

# ASS-467: every VM keeps an ssh port (ssh.localPort in its lima.yaml) no
# other instance pins, in any Lima folder in use (ASS-578: the ports are the Mac's, whichever folder an instance is in) — running or stopped, any project's, a
# golden image's or a vm:test-repos VM's — so a stopped VM's port, free on the
# Mac while it is down, is never handed to another, which would then hold it
# (Lima's host agent listens on it) and keep the first from starting. A port
# is chosen and written to the instance's lima.yaml (limactl clone or edit)
# under lock_ports, so two choosing at once cannot take the same one. The
# lock is harness-wide, vm-ports.lock beside harness.json, taken after a
# project's VM lock (lock_vms) where both are held, and let go before a VM
# starts (its host agent would inherit it). VM_PORT_TRY, space-separated
# ports, are tried first (tests); then the kernel's ephemeral ones.
lock_ports() { lock_on 4 "$disk_data_folder/vm-ports.lock" "$1" "${VM_LOCK_TIMEOUT:-600}"; }
unlock_ports() { exec 4>&-; }

pinned_ports() {
  local yaml name home
  while IFS= read -r home; do for yaml in "$home"/*/lima.yaml; do
    name="$(basename "$(dirname "$yaml")")"
    [[ -f "$yaml" && "$name" != _* ]] || continue
    awk -v vm="$name" '/^ssh:/ { s = 1; next } /^[^[:space:]#]/ { s = 0 }
      s && /^[[:space:]]+localPort:/ { p = $2; gsub(/[^0-9]/, "", p); if (p + 0 > 0) print vm "\t" p + 0; exit }' "$yaml"
  done; done < <(lima_homes)
}

ports_in_use() {
  [[ $# -gt 0 ]] || return 0
  node -e 'const net = require("net");
    (async () => { for (const p of process.argv.slice(1)) await new Promise(done => { const s = net.createServer()
      .once("error", () => { console.log(p); done(); }).listen(Number(p), "127.0.0.1", () => s.close(done)); }); })();' "$@"
}

free_port() {
  node -e 'const net = require("net"), taken = new Set(process.argv.slice(1).map(Number));
    const tries = (process.env.VM_PORT_TRY || "").split(/\s+/).filter(Boolean).map(Number);
    const attempt = n => { if (n >= 200) { console.error("free_port: no free ssh port found"); process.exit(1); }
      const want = n < tries.length ? tries[n] : 0;
      if (want && taken.has(want)) return attempt(n + 1);
      const s = net.createServer().once("error", () => attempt(n + 1)).listen(want, "127.0.0.1", () => {
        const p = s.address().port; s.close(); if (taken.has(p)) attempt(n + 1); else console.log(p); }); };
    attempt(0);' $(pinned_ports | cut -f2)
}

ssh_repin() {
  local command="$1" vm="$2" pins port others why="" port_new
  lock_ports "$command" || return 1
  pins="$(pinned_ports)"
  port="$(awk -F'\t' -v vm="$vm" '$1 == vm { print $2 }' <<< "$pins")"
  if [[ -n "$port" ]]; then
    others="$(awk -F'\t' -v vm="$vm" -v p="$port" '$1 != vm && $2 == p { print $1 }' <<< "$pins" | paste -sd, - | sed 's/,/, /g')"
    if [[ -n "$others" ]]; then why="pinned by $others too"
    elif [[ -n "$(ports_in_use "$port")" ]]; then why="held by another process now"; fi
  fi
  [[ -n "$why" ]] || { unlock_ports; return 0; }
  port_new="$(free_port)" && LIMA_HOME="$(lima_vm_home "$vm")" limactl edit --tty=false "$vm" --set ".ssh.localPort = $port_new" >/dev/null 2>&1 \
    || { unlock_ports; echo "$command: $vm's ssh port $port is $why, and it could not be re-pinned to a free one" >&2; return 1; }
  unlock_ports
  echo "$command: $vm's ssh port $port is $why; re-pinned to $port_new" >&2
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
# calls every VM "Broken", so there a recorded state is kept (ASS-240). It prints { project, limit-bytes, use-bytes,
# golden-bytes, shared-bytes, golden-built-at, golden-build, generations: [{ generation, golden-built-at,
# old-generation, shared-bytes, vms }], vms: [{ name, ticket, variation, state, disk-bytes, last-accessed,
# deletable, credential-kind?, golden-built-at, old-generation }] }, vms oldest access first.
# ASS-403: the disk is what the project's VMs and golden images occupy on the
# volume, each block counted once (measure_disks, shared-size.c: the disk
# files' — disk, or diffdisk and basedisk — physical extents). A VM is an APFS
# clone of golden-<project>; every block it has not written since it shares
# with the image, or with its sibling clones once a rebuild has deleted the
# image (on APFS a deleted file's blocks stay while any clone references them).
# So: golden-bytes, the golden images' blocks — golden-<project> and a
# golden-<project>-build left over — the clones' shared ones among them; a VM's
# disk-bytes, its private bytes, the blocks no other VM or golden image has,
# whatever its generation; a generation's shared-bytes, the blocks its VMs
# share and no golden image has: an older golden image's still held, counted
# once while any VM of it remains (a block VMs of two generations share counted
# as the older's; the generation null: VMs cloned before VMs recorded theirs);
# shared-bytes their sum; and use-bytes all of it: the VMs' disk-bytes, the
# generations' shared-bytes and golden-bytes. (Until ASS-403 a VM of an older
# generation was charged all it had allocated, so every one of its clones paid
# for the old image's blocks again: a rebuild alone could put a project far
# over its limit.) Generations (ASS-287): a VM holds a copy of the label of the
# image it was cloned from (vm:create); one whose label's generation is not
# golden-<project>'s now is old-generation. With no labelled golden-<project>
# no VM is of an old generation. A
# label's generation (ASS-291) is its generation id, unique to each build
# (vm:build-golden), else — a label from before it — its built-at: whole
# seconds, which two builds may share, and then a VM of the last image looked
# current. golden-built-at stays the label's built-at (null without one). The
# registry cache is not counted.
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
# vm:delete) needs none, as one that sets no `vm`. ASS-480: nor is one
# deletable while a step's end is pending on it (data/projects/<p>/
# step-ends.json, control's: a step ran in it whose vm:step-end has not
# succeeded — its commits not pushed yet), whatever its variation's step.
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

# helper <name> <arg…> — vm/<name>.c run, built on first use (and again when its source is newer) into $HARNESS_HOME/bin.
helper() {
  local name="$1" bin="${HARNESS_HOME:-$HOME/.harness}/bin/$1" src="$here_vm/vm/$1.c"; shift
  if [[ ! -x "$bin" || "$src" -nt "$bin" ]]; then
    mkdir -p "$(dirname "$bin")"
    clang -O2 -o "$bin.$$" "$src" 2>/dev/null && mv -f "$bin.$$" "$bin" || { rm -f "$bin.$$"; echo "$name: could not build $src (clang)" >&2; return 1; }
  fi
  "$bin" "$@"
}

# private_size <file…> — "<private> <allocated>" bytes per file (private-size.c).
private_size() { helper private-size "$@"; }

# disk_files <instance folder> — its disk files (disk, or diffdisk and basedisk), one per line.
disk_files() { local name; for name in disk diffdisk basedisk; do [[ ! -f "$1/$name" ]] || echo "$1/$name"; done; }

# disk_bytes <instance folder> <1|2> — its disk files' private (1) or allocated (2) bytes.
disk_bytes() {
  local files=()
  mapfile -t files < <(disk_files "$1")
  [[ ${#files[@]} -gt 0 ]] || { echo 0; return; }
  private_size "${files[@]}" | awk -v c="$2" '{ s += $c } END { printf "%.0f\n", s }'
}

# measure_disks <goldens> <instance folder…> (ASS-403) — "<own> <shared> <allocated>" bytes per folder, in
# order: its disk files' blocks no other folder's have, those it has with another when it is the first (in
# order) to have them, and all they have allocated (shared-size.c: their physical extents, each block counted
# once). The first <goldens> folders are golden images. Where the extents cannot be read it says so on stderr
# and falls back to a golden image's allocated bytes and a VM's APFS private size as its own, none shared —
# never more than they occupy, but blind to the blocks clones share once their golden image is gone.
measure_disks() {
  local goldens="$1" args=() dir file out i=0; shift
  for dir; do
    [[ ${#args[@]} -eq 0 ]] || args+=(--)
    while IFS= read -r file; do args+=("$file"); done < <(disk_files "$dir")
  done
  [[ $# -gt 0 ]] || return 0
  if out="$(helper shared-size "${args[@]}")" && [[ "$(wc -l <<<"$out")" -eq $# ]]; then echo "$out"; return; fi
  echo "shared-size: could not read the disks' extents; VM disk use falls back to each one's private size, uncounted the blocks clones share" >&2
  for dir; do
    mapfile -t args < <(disk_files "$dir")
    if [[ ${#args[@]} -eq 0 ]]; then echo "0 0 0"
    else private_size "${args[@]}" | awk -v golden=$(( i < goldens )) '{ p += $1; a += $2 } END { printf "%.0f 0 %.0f\n", golden ? a : p, a }'; fi
    i=$(( i + 1 ))
  done
}

# accessed_at <instance folder> — when its disk (else the folder) was last written.
accessed_at() { date -u -r "$( [[ -f "$1/disk" ]] && echo "$1/disk" || echo "$1")" +%Y-%m-%dT%H:%M:%SZ; }

golden_bytes() { local -x LIMA_HOME; LIMA_HOME="$(lima_home "$1")" || return 1; disk_bytes "$(lima_list "golden-$1" --format '{{.Dir}}' 2>/dev/null)" 2; }

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
  local folders=() names=() goldens sizes=() own shared allocated k build_bytes=0
  local -x LIMA_HOME; LIMA_HOME="$(lima_home "$project")" || return 1   # ASS-578: the project's own folder
  file="$(vms_file "$project")"
  sysctl -n kern.bootsessionuuid >/dev/null 2>&1 || blind=true
  limit="$(vm_disk_limit "$command" "$project")" || return 1
  listing="$({ lima_list --format $'{{.Name}}\t{{.Status}}\t{{.Dir}}' 2>/dev/null || true; } \
    | jq -Rn '[inputs | split("\t") | select(length == 3) | { key: .[0], value: { status: .[1], dir: .[2] } }] | from_entries')"
  sprint="$(sprint_file "$command" "$project" 2>/dev/null)"; [[ -f "$sprint" ]] || sprint=/dev/null   # none: $s[0] is null
  recorded="$(jq -nc --slurpfile s "$sprint" '[$s[0] | (.features, .bugs, .spikes) // [] | .[] | .key as $k | .variations // [] | .[] | select(.vm.name) | { key: .vm.name, value: { ticket: $k, variation: .name } }] | from_entries')"
  # ASS-403: every disk measured at once, the golden images first, then the VMs by generation and name (measure_disks).
  for name in "golden-$project" "golden-$project-build"; do
    dir="$(jq -r --arg n "$name" '.[$n].dir // empty' <<<"$listing")"
    [[ -z "$dir" ]] || folders+=("$dir")
    [[ -z "$dir" || "$name" != "golden-$project" ]] || { current="$(generation_of "$dir")" current_at="$(built_at "$dir")"; }
  done
  goldens=${#folders[@]}
  while IFS=$'\t' read -r name dir generation; do names+=("$name"); folders+=("$dir"); done < <(
    jq -rn --slurpfile v "$file" --slurpfile l <(printf '%s' "$listing") --slurpfile r <(printf '%s' "$recorded") \
      '$l[0] as $l | $v[0] + $r[0] | keys[] | select($l[.]) | "\(.)\t\($l[.].dir)"' \
    | while IFS=$'\t' read -r name dir; do [[ -z "$name" ]] || printf '%s\t%s\t%s\n' "$name" "$dir" "$(generation_of "$dir")"; done \
    | LC_ALL=C sort -t $'\t' -k3,3 -k1,1)
  [[ ${#folders[@]} -eq 0 ]] || mapfile -t sizes < <(measure_disks "$goldens" "${folders[@]}")
  for (( k = 0; k < goldens; k++ )); do
    read -r own shared allocated <<<"${sizes[k]:-0 0 0}"
    golden=$(( golden + own + shared )) build_bytes="$allocated"   # golden-<project>-build, when there is one, the last
  done
  dir="$(jq -r --arg n "golden-$project-build" '.[$n].dir // empty' <<<"$listing")"
  if [[ -n "$dir" ]]; then
    leftover=true; ! build_in_progress "$project" || leftover=false
    build="$(jq -c --arg n "golden-$project-build" --argjson b "$build_bytes" --arg at "$(accessed_at "$dir")" --argjson leftover "$leftover" --argjson blind "$blind" \
      '.[$n].status as $s | { name: $n, state: $s, "disk-bytes": $b, "last-accessed": $at, leftover: $leftover, deletable: ($leftover and $s != "Running" and ($blind | not)) }' <<<"$listing")"
  fi
  for (( k = goldens; k < ${#folders[@]}; k++ )); do
    name="${names[k - goldens]}" dir="${folders[k]}"
    read -r own shared allocated <<<"${sizes[k]:-0 0 0}"
    generation="$(generation_of "$dir")" old=false
    [[ -z "$current" || "$generation" == "$current" ]] || old=true
    measured="$(jq -c --arg n "$name" --argjson b "$own" --argjson sh "$shared" --arg at "$(accessed_at "$dir")" \
      --arg g "$(built_at "$dir")" --arg gen "$generation" --argjson old "$old" \
      '.[$n] = { bytes: $b, shared: $sh, accessed: $at, "built-at": (if $g == "" then null else $g end), generation: (if $gen == "" then null else $gen end), old: $old }' <<<"$measured")"
  done
  update_json "$file" --slurpfile l <(printf '%s' "$listing") --slurpfile r <(printf '%s' "$recorded") --slurpfile m <(printf '%s' "$measured") --argjson blind "$blind" \
    '. as $old | $l[0] as $l | $r[0] as $r
    | $m[0] | with_entries(.key as $n | .value = (($old[$n] // ($r[$n] + { "last-accessed": .value.accessed }))
      + { state: (if $blind and $old[$n].state then $old[$n].state else $l[$n].status end), "disk-bytes": .value.bytes }))'
  local ends="$projects/$project/step-ends.json"; [[ -f "$ends" ]] || ends=/dev/null   # ASS-480: none: $pe[0] is null
  jq -n --slurpfile vms "$file" --slurpfile s "$sprint" --slurpfile pe "$ends" --slurpfile m <(printf '%s' "$measured") --argjson golden "$golden" --argjson build "$build" --arg current "$current_at" --slurpfile e <(engine_files "$project" | { mapfile -t list; engines_by_name ${list[@]+"${list[@]}"} | jq -c 'map_values(.steps // [])'; }) \
    --arg p "$project" --argjson limit "$limit" '
    $s[0] as $sprint | $e[0] as $engines | [($pe[0].ends // {})[] | .vm // empty] as $pending
    | def use($v): [$v["harness-status"] | recurse(.["sub-status"] // empty) | select(.state != null) | . as $l
      | ($engines[$l["state-engine"]] // [] | map(select(.id == $l.state)) | first | .vm) // empty] | last;
    def live($e): first(($sprint // {}) | (.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($e.ticket | ascii_downcase))
      | .variations // [] | .[] | select(.name == $e.variation and (.["is-deleted"] | not))) // null;
    ($vms[0] | to_entries | map({ name: .key } + .value | . + { deletable: (.state != "Running" and (.name | IN($pending[]) | not) and (live(.) as $v | $v == null or (use($v) | . == null or . == "released"))),
        "golden-built-at": $m[0][.name]["built-at"], "old-generation": $m[0][.name].old })
      | sort_by(.["last-accessed"], .name)) as $list
    | ($m[0] | to_entries | group_by(.value.generation) | map({ generation: .[0].value.generation, "golden-built-at": .[0].value["built-at"],
        "old-generation": .[0].value.old, "shared-bytes": (map(.value.shared) | add), vms: map(.key) }) | sort_by(.["golden-built-at"], .generation)) as $generations
    | ($generations | map(.["shared-bytes"]) | add // 0) as $shared
    | { project: $p, "limit-bytes": $limit, "use-bytes": (($list | map(.["disk-bytes"]) | add // 0) + $shared + $golden), "golden-bytes": $golden,
        "shared-bytes": $shared, "golden-built-at": (if $current == "" then null else $current end), "golden-build": $build,
        generations: $generations, vms: $list }'
}

# make_room (ASS-75, ASS-287 AC3; ASS-289: a deletable golden-<project>-build,
# a failed build left over, is deleted first, before any ticket VM): first the project's limit — its use
# (use-bytes: its VMs, the blocks their generations share and its golden images, ASS-403) plus <bytes> —
# unless given volume (a golden image build: not a ticket's VM); then the free space df reports on the
# volume holding LIMA_HOME, which every project's VMs, the golden images and
# whatever else is there share. Either way, when deleting every deletable VM
# of the project's could not make room, it deletes none and returns 3 with the
# reason in $room_short and $room_long (on stderr too); else it deletes them,
# least recently accessed first, until there is room — for the volume, reading
# df again after each, as a deleted clone frees only the blocks no other file
# shares (an estimate beforehand: its frees-bytes, its disk-bytes and, when it is
# the last of its generation to go, the generation's shared-bytes: ASS-403);
# short still once none is left, it returns 3 as well.
make_room() {
  local command="$1" project="$2" need="$3" vm="$4" scope="${5:-}" inventory limit use golden free avail bytes taken
  local -x LIMA_HOME; LIMA_HOME="$(lima_home "$project")" || return 1   # ASS-578: the volume holding the project's folder
  inventory="$(reconcile_vms "$command" "$project")" || return 1
  # .deletable: what may go, in the order it goes — the leftover build, then the VMs, least recently accessed first;
  # each one's frees-bytes, what deleting it gives back (ASS-403): the last of a generation's VMs to go, the ones
  # before it gone too, frees the blocks they shared as well.
  inventory="$(jq -c '.generations as $g | [.vms[] | select(.deletable)] as $d
    | . + { deletable: ([.["golden-build"] // empty | select(.deletable) | { name, "disk-bytes", "frees-bytes": .["disk-bytes"], "last-accessed", build: true }]
      + [range(0; $d | length) as $k | $d[$k] | . as $v | (first($g[] | select(any(.vms[]; . == $v.name))) // { vms: [], "shared-bytes": 0 }) as $gen
        | { name, "disk-bytes", "frees-bytes": (.["disk-bytes"] + (if $gen.vms - [$d[0:$k + 1][].name] == [] then $gen["shared-bytes"] else 0 end)),
            ticket, variation, "last-accessed", build: false }]) }' <<<"$inventory")"
  read -r limit use golden free < <(jq -r '[.["limit-bytes"], .["use-bytes"], .["golden-bytes"], (.deletable | map(.["frees-bytes"]) | add // 0)] | @tsv' <<<"$inventory")
  if [[ "$scope" != volume ]]; then
    if (( use - free + need > limit )); then
      room_short="VM disk limit reached"
      room_long="$project's VMs use $(gb "$use") GB of its $(gb "$limit") GB VM disk limit (vm-disk-limit-gb), and $vm needs $(gb "$need") GB (golden-$project's size); its golden images take $(gb "$golden") GB of it; nothing more may be deleted: every other VM is running or its variation still in flight. Free space by finishing or setting aside variations, or raise vm-disk-limit-gb."
      echo "$command: $room_long" >&2
      return 3
    fi
    taken=$use   # ASS-403: use-bytes has the golden images in it
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
# accessed VM) deleted, and taken out of it; $bytes its frees-bytes (ASS-403).
room_delete() {
  local name ticket variation accessed build
  IFS=$'\t' read -r name bytes accessed build ticket variation < <(jq -r 'first(.deletable[]) | [.name, .["frees-bytes"], .["last-accessed"], .build, .ticket, .variation] | @tsv' <<<"$inventory")
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
  local -x LIMA_HOME; LIMA_HOME="$(lima_home "$2")" || return 1
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
  local -x LIMA_HOME; LIMA_HOME="$(lima_home "$2")" || return 1
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
  local -x LIMA_HOME; LIMA_HOME="$(lima_home "$project")" || return 1
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

# reclaim_all (ASS-288): below disk-free-warn-gb on a volume holding a Lima
# folder, the deletable VMs of every project whose folder that volume holds —
# stopped, their variation not
# in flight: reconcile_vms's deletable, as make_room deletes — are deleted,
# every such project's leftover golden-<project>-build first (ASS-289: a failed
# build's, deletable when stopped and no build is in progress), then the VMs
# least recently accessed first across all of them, until df says the volume
# is back at or above the warn level or none is left. ASS-578: each Lima folder
# in use is on some volume — the harness-wide one's, and each project's own
# (lima-home.bash lima_home) — and each volume is reclaimed so, in turn, from
# the projects whose folder it holds only: deleting a VM on one disk frees
# nothing on another. Each project's inventory
# is read under its VM lock, one project at a time; each deletion takes that
# project's lock again and reconciles first, so a VM started or put back in
# flight since is skipped (no two locks are ever held at once). Each deletion
# is said on stderr with its VM, project, ticket, variation, last access and
# the bytes df says it freed. Prints { dry-run, warn-bytes, free-bytes-before,
# free-bytes, deleted: [{ project, name, kind, ticket, variation, last-accessed,
# disk-bytes, freed-bytes }], short, volumes: [{ mount, lima-home, projects,
# free-bytes-before, free-bytes, short }] } — kind leftover-golden-build (ticket and
# variation null) or ticket-vm; free-bytes-before and free-bytes the fullest
# volume's; short: some volume still below the warn level.
# With dry-run, those it would delete — counting each one's disk-bytes as
# freed — deleting none. A project whose inventory or folder cannot be read is passed
# over, said on stderr.
reclaim_all() {
  local command="$1" dry="${2:-}" warn hold dir project home line mount deleted="[]" volumes="[]" default order=()
  local -A on=() home_of=()
  read -r warn hold < <(disk_levels "$command") || true
  [[ -n "${warn:-}" ]] || return 1
  default="$(lima_home_default)"
  line="$(volume_of "$default" 2>&1)" || { echo "$command: $line" >&2; return 1; }
  mount="${line#*$'\t'}"; order+=("$mount"); home_of[$mount]="$default"; on[$mount]=""
  for dir in "$projects"/*/; do
    project="$(basename "$dir")"
    [[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$dir/project.json" ]] || continue
    home="$(lima_home "$project" 2>&1)" || { echo "$command: $project passed over: $home" >&2; continue; }
    line="$(volume_of "$home" 2>&1)" || { echo "$command: $project passed over: $line" >&2; continue; }
    mount="${line#*$'\t'}"
    [[ -n "${home_of[$mount]+set}" ]] || { order+=("$mount"); home_of[$mount]="$home"; on[$mount]=""; }
    on[$mount]+="$project "
  done
  for mount in "${order[@]}"; do
    # shellcheck disable=SC2086
    reclaim_volume "$command" "$dry" "$warn" "$mount" "${home_of[$mount]}" ${on[$mount]} || return 1
  done
  jq -n --argjson d "$deleted" --argjson v "$volumes" --argjson dry "$( [[ -n "$dry" ]] && echo true || echo false)" --argjson w "$warn" \
    '{ "dry-run": $dry, "warn-bytes": $w, "free-bytes-before": ($v | map(.["free-bytes-before"]) | min), "free-bytes": ($v | map(.["free-bytes"]) | min),
       deleted: $d, short: any($v[]; .short), volumes: $v }'
}

# reclaim_volume <command> <dry> <warn> <mount> <a Lima folder on it> <project…> — reclaim_all's, for one volume: its
# deletions appended to $deleted, and its { mount, lima-home, projects, free-bytes-before, free-bytes, short } to $volumes.
reclaim_volume() {
  local command="$1" dry="$2" warn="$3" mount="$4" free before candidates="[]" project inventory next name kind bytes ticket variation accessed after freed what
  local -x LIMA_HOME="$5"   # volume_free's: the volume holding it
  shift 5
  free="$(volume_free 2>&1)" || { echo "$command: $free" >&2; return 1; }
  before="$free"
  if (( free < warn )); then
    for project; do
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
    echo "$command: deleted $name ($what, last accessed $accessed): $freed bytes freed ($(gib "$freed") GiB), $(gib "$free") GiB free on $mount" >&2
  done
  volumes="$(jq -c --arg m "$mount" --arg h "$LIMA_HOME" --arg ps "$*" --argjson b "$before" --argjson f "$free" --argjson w "$warn" \
    '. + [{ mount: $m, "lima-home": $h, projects: ($ps | split(" ") | map(select(. != ""))), "free-bytes-before": $b, "free-bytes": $f, short: ($f < $w) }]' <<<"$volumes")"
}
# vm_install_deps <command> <vm> <project> — ASS-503: in the VM, each of the project's repositories whose
# pnpm-lock.yaml changed since its deps were installed gets `pnpm install --frozen-lockfile` (in-vm/install-deps.sh),
# once a checkout has moved; its lines on stderr (stdout stays the caller's). Fails (1) when one could not be
# installed, naming it.
vm_install_deps() {
  local command="$1" vm="$2" project="$3" repos=() out
  out="$(jq -r '.repositories[]?.url | sub("\\.git$"; "") | split("/") | last' "$projects/$project/project.json")" || return 1
  [[ -z "$out" ]] || mapfile -t repos <<< "$out"
  [[ ${#repos[@]} -gt 0 ]] || return 0
  # pipefail (the callers'): a failing install fails the pipeline.
  machine_run --workdir / "$vm" -- bash -s -- "${repos[@]}" < "$here_vm/vm/in-vm/install-deps.sh" 2>&1 | sed "s/^/$command: /" >&2 \
    || { echo "$command: dependencies could not be installed in $vm (see above)" >&2; return 1; }
}
source "$here_vm/workstation-variation.bash"
