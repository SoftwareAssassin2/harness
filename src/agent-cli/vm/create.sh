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
#   of its own (ssh.localPort, for vm:start's sandbox): free now, and pinned
#   by no other instance under LIMA_HOME (vm.bash free_port, ASS-467). When it cannot fit
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
# - Then (ASS-468 AC10) each repository's git hooks set to refuse a commit
#   on its default branch, naming the ticket's branch
#   (workstation/on-workstation/git-hooks.sh), every time.
# - Then ticket:set-vm records { name, ip, created-at } on the variation.
# All of it under the project's VM lock (vm.bash lock_vms), which the
# vm:start it runs shares. Prints { name, ip, created } — created whether
# this run cloned it. Fails (1) naming why otherwise.
#
# ASS-551: on a substrate run target (local-substrate, workstation-substrate,
# cloud-vm-substrate: HARNESS_RUN_TARGET, which control sets for the step, else
# the variation's recorded run-target, code:hand-over's) the variation's
# machine is its own Substrate sandbox, so creating it means making or resuming
# that: substrate:sandbox-up on the machine whose cluster holds it — the one its
# sandbox record names, else the Mac for local-substrate, else its seat's
# workstation or cloud VM (seats.json). Control has brought it up before the
# step already (src/control/sandboxes.js sandboxWaits); sandbox-up is
# idempotent, so this works the same run by hand. Then each repository
# project.json lists that the sandbox image predates (added since it was built,
# project:add-repository) is cloned into its /repos through the Mac
# (substrate/relay.bash relay_clone: a sandbox fetches nothing itself), and its
# repositories' git hooks set as for a VM (ASS-468 AC10). No VM, no
# ticket:set-vm: sandbox-up records the variation's `sandbox`. Prints
# { name, machine, ip: null, created, sandbox: true }, name the sandbox's
# machine (substrate:<project>:<machine>:<actor>). Before ASS-551 Create VM
# listed no substrate target, so on a project whose run targets were substrate
# ones alone every new ticket waited at it for ever (found by ASS-543).
#
# ASS-435, ASS-468: a project whose dev-environments mode is workstation or
# vm+workstation (dev-environments.bash) runs a variation's steps on its GCP
# workstations, each step claiming a free one for its length and giving it
# back at its end (workstation:claim, workstation:release; control's
# src/control/workstation-steps.js), so Create VM claims nothing: it records
# the pool on the variation — the first workstation in list order whose
# gcloud login is live, connected and set up first when no setup has
# recorded its home folder yet (workstation-variation.bash wsv_place) —
# through ticket:set-vm with kind workstation and the workstation's shared
# root, <home>/harness, as its folder, and prints { name: <workstation id>,
# machine, ip: null, created }. With none usable, vm+workstation falls back
# to a VM, as below; workstation mode fails, naming why each is not. A
# variation that records a VM stays in its VM here, whatever the mode (its
# steps run where its seat is, ASS-469: a workstation seat's on that
# workstation). --vm makes or reuses the variation's VM whatever the mode:
# control's way to give a vm+workstation variation a VM for a step it runs
# there — it holds a VM seat, or the step is a planning one (ASS-468 AC4,
# ASS-469); the VM is recorded as its vm and kept for its later steps.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 3 || ( $# -eq 4 && "$4" == --vm ) ]] || { echo "usage: vm:create <project> <ticket-key> <variation> [--vm]" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3" force_vm="${4:-}"
variation_exists vm:create "$project" "$key" "$variation"

# ASS-551: on a substrate run target, the variation's sandbox (above).
# shellcheck disable=SC2016
on_target="$(jq -r --arg key "$key" --arg name "$variation" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
  | first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not)))
  | "\((($ENV.HARNESS_RUN_TARGET // "" | if . == "" then null else . end) // .["run-target"].target // ""))\t\(.sandbox.machine // "")"' "$(sprint_file vm:create "$project")")"
target="${on_target%%$'\t'*}" host="${on_target#*$'\t'}"
if [[ -z "$force_vm" && "$target" == *-substrate ]]; then
  source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate/relay.bash"
  if [[ -z "$host" && "$target" == local-substrate ]]; then host=mac
  elif [[ -z "$host" ]]; then
    host="$(jq -r --arg key "$key" --arg name "$variation" 'first(.seats[]? | select((.key | ascii_upcase) == $key and .variation == $name) | .workstation // empty) // ""' "$projects/$project/seats.json" 2>/dev/null || true)"
    [[ -n "$host" ]] || { echo "vm:create: $key $variation runs on $target but holds no seat on a machine yet (control places it, then makes its sandbox)" >&2; exit 1; }
  fi
  up="$("$agent" substrate:sandbox-up "$project" "$key" "$variation" "$host" | tail -n 1)" \
    || { echo "vm:create: $key $variation's sandbox could not be made or resumed on $host (substrate:sandbox-up above)" >&2; exit 1; }
  box="$(jq -r .machine <<< "$up")"
  mapfile -t repos < <(jq -r '.repositories[]?.url | (sub("\\.git$"; "") | split("/") | last), .' "$projects/$project/project.json")   # name, url, …
  have="$(machine_run --workdir / "$box" -- bash -c 'for d in "${HARNESS_VM_ROOT-}"/repos/*/; do [ -e "$d.git" ] && basename "$d"; done; true' </dev/null)" \
    || { echo "vm:create: $box is not usable" >&2; exit 1; }
  names=()
  for ((i = 0; i < ${#repos[@]}; i += 2)); do
    names+=("${repos[i]}")
    grep -qxF "${repos[i]}" <<< "$have" && continue
    relay_clone vm:create "$box" "${repos[i]}" "${repos[i+1]}" || exit 1
    echo "vm:create: ${repos[i]} cloned into $box's /repos through the Mac (its sandbox image predates it)" >&2
  done
  slug="$key"; [[ "$variation" == A ]] || slug="$key.$variation"
  machine_run --workdir / "$box" -- bash -s -- install "the ticket's branch for this repository, change/$slug-<id> (agent.sh ticket:merge-request-plan names it)" "${names[@]+"${names[@]}"}" \
    < "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../workstation/on-workstation/git-hooks.sh" \
    || { echo "vm:create: could not set $box's repositories' git hooks" >&2; exit 1; }
  jq -c --arg n "$box" '{ name: $n, machine: $n, ip: null, created: (.created == true), sandbox: true }' <<< "$up"
  exit 0
fi

recorded="$(variation_status vm:create "$project" "$key" "$variation" >/dev/null && jq -r --arg key "$key" --arg name "$variation" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
  | first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) | .vm // {} | if (.name // "") == "" then "" elif (.kind // "lima") | IN("workstation", "cloud-vm") then "workstation:" else .name end' "$(sprint_file vm:create "$project")")"
mode="$(dev_environments_mode vm:create "$project")"
if [[ -z "$force_vm" && "$mode" != vm && ( -z "$recorded" || "$recorded" == workstation:* ) ]]; then
  rc=0; wsv_place "$project" "$key" "$variation" || rc=$?
  if [[ $rc -eq 0 ]]; then
    wsm_parts "${wsv_machine#*:}" || exit 1
    # ASS-481: a cloud VM of the pool recorded as kind cloud-vm.
    "$agent" ticket:set-vm "$project" "$key" "$variation" "$wsm_id" "" --kind "${wsv_machine%%:*}" --folder "$wsm_folder" >/dev/null
    echo "vm:create: $key $variation runs its steps on $project's ${wsv_machine%%:*} $wsm_id, each claiming it while it runs" >&2
    jq -nc --arg n "$wsm_id" --arg m "$wsv_machine" --argjson c "$( [[ -z "$recorded" ]] && echo true || echo false )" '{ name: $n, machine: $m, ip: null, created: $c }'
    exit 0
  fi
  [[ "$mode" != workstation ]] || { echo "vm:create: $project runs its tickets on workstations alone, and $wsv_why" >&2; exit 1; }
  echo "vm:create: $wsv_why; $key $variation gets a VM" >&2
fi
vm="$(vm_name "$key" "$variation")" golden="golden-$project"
mapfile -t repos < <(jq -r '.repositories[]?.url | (sub("\\.git$"; "") | split("/") | last), .' "$projects/$project/project.json")   # name, url, …

created=false recreated=""
lock_vms vm:create "$project"   # to the end: two vm:creates of one VM (Setup's, control's) make it once
# clone [<why it is recreated>] — $vm cloned from $golden, as above; the image's label copied into it, and linked to the variation at once.
clone() {
  local why
  lima_list "$golden" --format '{{.Status}}' >/dev/null 2>&1 || { echo "vm:create: no golden image $golden: build it with vm:build-golden $project" >&2; exit 1; }
  room=0; make_room vm:create "$project" "$(golden_bytes "$project")" "$vm" || room=$?
  if [[ $room -eq 3 ]]; then jq -nc --arg s "$room_short" --arg l "$room_long" '{ "ai-feedback-short": $s, "ai-feedback-long": $l }'; exit 3; fi
  [[ $room -eq 0 ]] || exit 1
  [[ "$(jq -r --arg key "$key" --arg name "$variation" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
      | first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) | .vm.name // empty' "$(sprint_file vm:create "$project")")" != "$vm" ]] || recreated=recreated
  why="${1:-${recreated:+was deleted}}"
  [[ -z "$why" ]] || echo "vm:create: $vm $why; it is recreated from $golden, and whatever was only on its old disk is lost" >&2
  record_vm "$project" "$vm" "$key" "$variation" Stopped
  mounts="$(jq -nc --arg f "$(ticket_folder vm:create "$project" "$key")" '[{ location: $f, mountPoint: "/mnt/ticket", writable: false }]')"
  lock_ports vm:create || exit 1   # until the clone's lima.yaml pins it (ASS-467)
  ssh="$(free_port)" || exit 1
  limactl clone --tty=false "$golden" "$vm" --set ".mounts = $mounts | .ssh.localPort = $ssh" >/dev/null 2>&1 \
    || { echo "vm:create: could not clone $golden into $vm" >&2; exit 1; }
  unlock_ports
  cp "$(dir_of "$golden")/golden-image.json" "$(dir_of "$vm")/" 2>/dev/null || true
  "$agent" ticket:set-vm "$project" "$key" "$variation" "$vm" "" $recreated >/dev/null
  created=true
}
dir_of() { lima_list "$1" --format '{{.Dir}}'; }
# fixed_since — the fix of $golden's last build marked one (vm:build-golden --fix), "<fixed-at> (<fix>)", when $vm was cloned from an older image.
fixed_since() {
  jq -r --slurpfile vm <(cat "$(dir_of "$vm")/golden-image.json" 2>/dev/null || true) \
    'select(.["fixed-at"] and .hash != ($vm[0].hash // null) and .["fixed-at"] > ($vm[0]["built-at"] // "")) | "\(.["fixed-at"]) (\(.fix))"' \
    "$(dir_of "$golden")/golden-image.json" 2>/dev/null || true
}
if ! machine_status "$vm" >/dev/null 2>&1; then clone; else fixed="$(fixed_since)"; fi

ip="$(VM_LOCK_HELD=1 "$agent" vm:start "$project" "$key" "$variation" | jq -r .ip)"

if [[ -n "${fixed-}" ]]; then
  if machine_run --workdir / "$vm" -- bash -c 'test -e "${HARNESS_VM_ROOT-}$1"' - "$setup_marker"; then
    echo "vm:create: $vm was cloned from an older $golden than its fix of $fixed; it is kept, as its Setup completed and the ticket's work may be in it (to take the fix, limactl delete -f $vm, then vm:create)" >&2
  else
    limactl delete -f "$vm" >/dev/null 2>&1 || { echo "vm:create: could not delete $vm" >&2; exit 1; }
    clone "was cloned from an older $golden than its fix of $fixed, and its Setup never completed"
    ip="$(VM_LOCK_HELD=1 "$agent" vm:start "$project" "$key" "$variation" | jq -r .ip)"
  fi
fi

machine_run --workdir / "$vm" -- bash -s "$vm" "${repos[@]}" <<'EOF' || { echo "vm:create: $vm is not usable" >&2; exit 1; }
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

# ASS-468 AC10: no commit on a repository's default branch in the VM — its git hooks refuse one, naming the ticket's
# branch (workstation/on-workstation/git-hooks.sh; vm:step-start sets them again, idempotent).
slug="$key"; [[ "$variation" == A ]] || slug="$key.$variation"
names=(); for ((i = 0; i < ${#repos[@]}; i += 2)); do names+=("${repos[i]}"); done
machine_run --workdir / "$vm" -- bash -s -- install "the ticket's branch for this repository, change/$slug-<id> (agent.sh ticket:merge-request-plan names it)" "${names[@]+"${names[@]}"}" \
  < "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../workstation/on-workstation/git-hooks.sh" \
  || { echo "vm:create: could not set $vm's repositories' git hooks" >&2; exit 1; }

"$agent" ticket:set-vm "$project" "$key" "$variation" "$vm" "$ip" >/dev/null
jq -nc --arg n "$vm" --arg ip "$ip" --argjson c "$created" '{ name: $n, ip: $ip, created: $c }'
