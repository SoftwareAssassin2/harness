#!/usr/bin/env bash
# Description: Recreate a ticket variation's VM from its project's current golden image, keeping its pushed work — vm:recreate <project> <ticket-key> <variation>; prints vm:create's JSON.
set -euo pipefail

# ASS-392 AC2: grouped-blocked's Repair Image, once the golden image is
# repaired (or was fine and the ticket's VM is what broke), puts the ticket
# on a VM cloned from the image as it is now. vm:delete will not delete a VM
# whose variation is in flight, and vm:create keeps one whose Setup
# completed; this is the one way the variation's own VM is replaced while it
# is blocked. Under the project's VM lock (vm.bash lock_vms), to the end:
#   - refused (exit 3, nothing touched) while a golden image build of the
#     project runs (vm.bash build_in_progress: golden-build.lock held, or
#     golden-build-run.json's build still going) — wait for it — or with no
#     golden-<project> to clone;
#   - when the VM's Setup completed (vm.bash $setup_marker), the ticket's work
#     may be in it: it is started if stopped (vm:start), and every /repos/<name>
#     must be clean (git status --porcelain: no change, no untracked file) with
#     no commit on any local branch that no remote has (git log --branches
#     --not --remotes); else refused (exit 3), naming each, nothing deleted —
#     the operator's call. A VM that cannot be started or read is refused too;
#   - each repository's branch and commit is noted, the VM stopped (forced)
#     and deleted as vm:delete deletes one (delete_vm), then vm:create clones
#     it afresh from golden-<project> (the variation keeps its name: it says
#     "recreated") and starts it;
#   - in the new VM each repository is put back where it was — fetched, and
#     its branch checked out at the noted commit (detached when it was) — and,
#     when Setup had completed, vm:mark-setup-complete marks it again (which
#     proves the new VM can run an agent: claude on its PATH).
# Logged in the variation's change log (work.bash blocked_log, "Repair
# Image"). A VM never made (Setup failed before it) is simply created.
# Exits 0 printing vm:create's { name, ip, created }; 3 refused; 1 failed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/work.bash"

command=vm:recreate
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
variation_exists "$command" "$project" "$key" "$variation"
vm="$(vm_name "$key" "$variation")" golden="golden-$project"
refuse() { blocked_log "$project" "$key" "$variation" "Repair Image" "vm:recreate refused: $1"; echo "$command: $1" >&2; exit 3; }
lock_vms "$command" "$project"
! build_in_progress "$project" || refuse "$golden is being built now; wait for it to finish (vm:golden-wait $project), then recreate $vm"
limactl list "$golden" --format '{{.Status}}' >/dev/null 2>&1 || refuse "there is no $golden to clone $vm from: build it first"

setup=false where=""
if limactl list "$vm" --format '{{.Status}}' >/dev/null 2>&1; then
  if [[ "$(limactl list "$vm" --format '{{.Status}}')" != Running ]]; then
    VM_LOCK_HELD=1 "$agent" vm:start "$project" "$key" "$variation" >/dev/null 2>&1 \
      || refuse "$vm could not be started to check it for the ticket's unsaved work; the operator decides whether to delete it"
  fi
  # One line "setup <true|false>", then "repo <name> <branch or -> <commit>" or "unsaved <name>: <why>" per repository.
  where="$(limactl shell --workdir / "$vm" -- bash -c '
    R="${HARNESS_VM_ROOT-}"
    if [ -e "$R$1" ]; then echo "setup true"; else echo "setup false"; fi
    for d in "$R"/repos/*/; do
      [ -d "$d.git" ] || continue
      name="$(basename "$d")"
      [ -z "$(git -C "$d" status --porcelain 2>/dev/null)" ] || echo "unsaved $name: changes not committed"
      [ -z "$(git -C "$d" log --branches --not --remotes --oneline 2>/dev/null | head -1)" ] || echo "unsaved $name: commits no remote has"
      echo "repo $name $(git -C "$d" symbolic-ref --short -q HEAD || echo -) $(git -C "$d" rev-parse HEAD)"
    done' - "$setup_marker")" || refuse "could not read $vm's repositories; the operator decides whether to delete it"
  [[ "$(head -1 <<< "$where")" != "setup true" ]] || setup=true
  unsaved="$(sed -n 's/^unsaved //p' <<< "$where")"
  [[ "$setup" != true || -z "$unsaved" ]] \
    || refuse "$vm holds the ticket's work not on any remote — $(paste -sd ';' - <<< "$unsaved" | sed 's/;/; /g'); push or save it first, or the operator deletes it"
  limactl stop -f "$vm" >/dev/null 2>&1 || true
  delete_vm "$command" "$project" "$vm" || { echo "$command: could not delete $vm" >&2; exit 1; }
fi

out="$(VM_LOCK_HELD=1 "$agent" vm:create "$project" "$key" "$variation")" || { echo "$command: vm:create failed after $vm was deleted" >&2; exit 1; }
put_back="$(sed -n 's/^repo //p' <<< "$where")"
if [[ "$setup" == true && -n "$put_back" ]]; then
  limactl shell --workdir / "$vm" -- bash -c '
    R="${HARNESS_VM_ROOT-}" failed=0
    while read -r name branch commit; do
      d="$R/repos/$name"
      [ -d "$d/.git" ] || continue
      git -C "$d" fetch -q origin || { echo "could not fetch /repos/$name" >&2; failed=1; continue; }
      if [ "$branch" = - ]; then git -C "$d" checkout -q --detach "$commit"; else git -C "$d" checkout -q -B "$branch" "$commit"; fi \
        || { echo "could not check out $branch at $commit in /repos/$name" >&2; failed=1; }
    done
    exit $failed' - <<< "$put_back" || { echo "$command: $vm was recreated, but its repositories could not all be put back as they were" >&2; exit 1; }
fi
if [[ "$setup" == true ]]; then
  "$agent" vm:mark-setup-complete "$project" "$key" "$variation" >/dev/null || { echo "$command: $vm was recreated, but its Setup could not be marked complete again" >&2; exit 1; }
fi
generation="$(generation_of "$(limactl list "$vm" --format '{{.Dir}}')")"
blocked_log "$project" "$key" "$variation" "Repair Image" "vm:recreate: $vm recreated from $golden (generation ${generation:-unknown})$([[ "$setup" == true ]] && echo ", its repositories put back on their branches and its Setup marked complete again" || true)."
echo "$out"
