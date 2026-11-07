#!/usr/bin/env bash
# Description: Give a ticket variation its own VM, or make sure its VM is up — vm:create <project> <ticket-key> <variation>; prints { name, ip, created }.
set -euo pipefail

# The Create VM step (ASS-74). The VM, <key>-<variation> in lower case
# (vm.bash), is a copy-on-write clone of the project's golden image
# (golden-<project>, vm:build-golden), which already holds every repository
# of the project at /repos/<basename>. Idempotent:
# - No VM yet: room made for it within the project's VM disk limit (ASS-75,
#   vm.bash make_room: it is charged the golden image's size, and the least
#   recently accessed VMs no variation in flight needs are deleted until it
#   fits); then, entered in the project's inventory (vms.json), `limactl
#   clone` with the ticket's folder as its only mount, read-only, at
#   /mnt/ticket (ASS-182: a VM agent writes the ticket's files only through
#   its agent.sh, the content on stdin) — not the harness repo, not the home
#   folder, no scratch mount — and an ssh port
#   of its own (ssh.localPort, for vm:start's sandbox). When it cannot fit
#   without deleting a VM that runs or whose variation is in flight, nothing
#   is deleted or cloned: it exits 3, the reason on stderr and, on stdout, as
#   { ai-feedback-short, ai-feedback-long } — the Setup group sends the
#   ticket to Blocked for Human with it. A variation whose recorded VM was
#   deleted gets it again, recreated (ticket:set-vm … recreated), said on
#   stderr: whatever was only on its old disk is lost. A clone holds a copy
#   of the image's label (golden-image.json), and is linked to the variation
#   (ticket:set-vm, no IP yet) at once (ASS-234), so a create that fails
#   later leaves a VM control knows as the variation's.
# - A VM reused that was cloned from an older image than the last build
#   marked a fix (vm:build-golden --fix: the label's fixed-at, after the VM's
#   label's built-at, or the VM has none) is, once started, recreated as a
#   deleted one is, said on stderr, while its Setup never completed (no
#   setup-complete marker: nothing of the ticket's work is in it); else it is
#   kept, with a warning on stderr.
# - Then vm:start, every time: started (or taken as it runs), logged in,
#   given a fresh forwarder token and agent.sh, its IP read.
# - Then, in the VM: /mnt/ticket mounted, or the VM is not
#   usable and this fails; each repository present — one project.json lists
#   that the golden image predates (added since it was built: ASS-121,
#   project:add-repository) cloned to /repos/<basename> with the VM's own
#   login, or this fails naming it. Master — origin's
#   default branch — is fetched and checked out in each repository once,
#   the first time; /repos/.vm-create-checked-out marks it done, so a reused
#   VM's working trees (Generate Solution's branches) are never touched,
#   while a checkout that failed part way is tried again.
# - Then ticket:set-vm records { name, ip, created-at } on the variation.
# All of it under the project's VM lock (vm.bash lock_vms), which the
# vm:start it runs shares. Prints { name, ip, created } — created whether
# this run cloned it. Fails (1) naming why otherwise.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 3 ]] || { echo "usage: vm:create <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
variation_exists vm:create "$project" "$key" "$variation"
vm="$(vm_name "$key" "$variation")" golden="golden-$project"
mapfile -t repos < <(jq -r '.repositories[]?.url | (sub("\\.git$"; "") | split("/") | last), .' "$projects/$project/project.json")   # name, url, …

created=false recreated=""
lock_vms vm:create "$project"   # to the end: two vm:creates of one VM (Setup's, control's) make it once
# clone [<why it is recreated>] — $vm cloned from $golden, as above; the image's label copied into it, and linked to the variation at once.
clone() {
  local why
  limactl list "$golden" --format '{{.Status}}' >/dev/null 2>&1 || { echo "vm:create: no golden image $golden: build it with vm:build-golden $project" >&2; exit 1; }
  room=0; make_room vm:create "$project" "$(golden_bytes "$project")" "$vm" || room=$?
  if [[ $room -eq 3 ]]; then jq -nc --arg s "$room_short" --arg l "$room_long" '{ "ai-feedback-short": $s, "ai-feedback-long": $l }'; exit 3; fi
  [[ $room -eq 0 ]] || exit 1
  [[ "$(jq -r --arg key "$key" --arg name "$variation" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
      | first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) | .vm.name // empty' "$(sprint_file vm:create "$project")")" != "$vm" ]] || recreated=recreated
  why="${1:-${recreated:+was deleted}}"
  [[ -z "$why" ]] || echo "vm:create: $vm $why; it is recreated from $golden, and whatever was only on its old disk is lost" >&2
  record_vm "$project" "$vm" "$key" "$variation" Stopped
  mounts="$(jq -nc --arg f "$(ticket_folder vm:create "$project" "$key")" '[{ location: $f, mountPoint: "/mnt/ticket", writable: false }]')"
  ssh="$(free_port)"
  limactl clone --tty=false "$golden" "$vm" --set ".mounts = $mounts | .ssh.localPort = $ssh" >/dev/null 2>&1 \
    || { echo "vm:create: could not clone $golden into $vm" >&2; exit 1; }
  cp "$(dir_of "$golden")/golden-image.json" "$(dir_of "$vm")/" 2>/dev/null || true
  "$agent" ticket:set-vm "$project" "$key" "$variation" "$vm" "" $recreated >/dev/null
  created=true
}
dir_of() { limactl list "$1" --format '{{.Dir}}'; }
# fixed_since — the fix of $golden's last build marked one (vm:build-golden --fix), "<fixed-at> (<fix>)", when $vm was cloned from an older image.
fixed_since() {
  jq -r --slurpfile vm <(cat "$(dir_of "$vm")/golden-image.json" 2>/dev/null || true) \
    'select(.["fixed-at"] and .hash != ($vm[0].hash // null) and .["fixed-at"] > ($vm[0]["built-at"] // "")) | "\(.["fixed-at"]) (\(.fix))"' \
    "$(dir_of "$golden")/golden-image.json" 2>/dev/null || true
}
if ! limactl list "$vm" --format '{{.Status}}' >/dev/null 2>&1; then clone; else fixed="$(fixed_since)"; fi

ip="$(VM_LOCK_HELD=1 "$agent" vm:start "$project" "$key" "$variation" | jq -r .ip)"

if [[ -n "${fixed-}" ]]; then
  if limactl shell --workdir / "$vm" -- bash -c 'test -e "${HARNESS_VM_ROOT-}$1"' - "$setup_marker"; then
    echo "vm:create: $vm was cloned from an older $golden than its fix of $fixed; it is kept, as its Setup completed and the ticket's work may be in it (to take the fix, limactl delete -f $vm, then vm:create)" >&2
  else
    limactl delete -f "$vm" >/dev/null 2>&1 || { echo "vm:create: could not delete $vm" >&2; exit 1; }
    clone "was cloned from an older $golden than its fix of $fixed, and its Setup never completed"
    ip="$(VM_LOCK_HELD=1 "$agent" vm:start "$project" "$key" "$variation" | jq -r .ip)"
  fi
fi

limactl shell --workdir / "$vm" -- bash -s "$vm" "${repos[@]}" <<'EOF' || { echo "vm:create: $vm is not usable" >&2; exit 1; }
set -euo pipefail
R="${HARNESS_VM_ROOT-}"   # empty in a VM; tests run this against a folder standing in for its root
vm="$1"; shift
mountpoint -q "$R/mnt/ticket" || { echo "vm:create: /mnt/ticket is not mounted in $vm" >&2; exit 1; }
names=()
while [ $# -gt 0 ]; do
  name="$1" url="$2"; shift 2; names+=("$name")
  [ -d "$R/repos/$name/.git" ] || git clone -q "$url" "$R/repos/$name" || { echo "vm:create: /repos/$name is missing in $vm, and could not clone $url" >&2; exit 1; }
done
[ ! -e "$R/repos/.vm-create-checked-out" ] || exit 0
for name in "${names[@]}"; do
  cd "$R/repos/$name"
  branch="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/master)"
  { git fetch -q origin && git checkout -q -B "${branch#origin/}" "$branch"; } || { echo "vm:create: could not check out master (${branch#origin/}) in /repos/$name" >&2; exit 1; }
done
touch "$R/repos/.vm-create-checked-out"
EOF

"$agent" ticket:set-vm "$project" "$key" "$variation" "$vm" "$ip" >/dev/null
jq -nc --arg n "$vm" --arg ip "$ip" --argjson c "$created" '{ name: $n, ip: $ip, created: $c }'
