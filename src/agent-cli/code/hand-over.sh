#!/usr/bin/env bash
# Description: Hand a ticket variation's branch over to the run target its next step runs on (ASS-540): pushed from where its last step ran, pulled where the next runs, and the target recorded — code:hand-over <project> <ticket-key> <variation> <target>.
set -euo pipefail

# Control runs this before a step's work starts on a run target other than the
# one the variation last ran on (its `run-target` { target, at }), or on a Mac
# target whose place is not ready (src/control/run-target-places.js). Agents
# commit at a step's end; what is left uncommitted where the last step ran is
# committed here ("<KEY>: work left uncommitted on <target>"), so nothing is
# lost on the way. Then:
#
# - Leaving a Mac target (local-worktree: the variation's worktree,
#   build.worktree-folder; local-workspace: the project's checkout): its branch
#   is pushed to origin. Leaving local-workspace also gives the workspace back:
#   it returns to where it was (its local-pc environment's return-to) and its
#   active-branch claim is cleared.
# - Leaving a machine for a Mac target: the branch checked out in the machine's
#   checkout of the workspace's repository (/repos/<repo>, through machine.bash
#   machine_run) is pushed to origin, and it is the branch the Mac uses
#   (recorded as build.branch).
# - Onto local-worktree: the branch made when there is none (code:create-branch),
#   ASS-553: in the harness's own clone (code.bash harness_clone), never the
#   operator's checkout — a worktree the variation made earlier in the
#   workspace is kept and used —
#   the worktree created on first use (code:create-worktree, which records
#   build.worktree-folder and runs worktree-setup), then fast-forwarded to
#   origin's branch.
# - Onto local-workspace: the workspace, which one ticket holds at a time per
#   project (its local-pc environment's active-branch, under workspace.lock),
#   checks the branch out (a worktree of the variation on it is removed first,
#   its work pushed already), fast-forwarded to origin's.
# - Onto a machine from a Mac target: its checkout of the repository fetches
#   origin and checks the branch out, fast-forwarded.
# - ASS-554 (worktree steps: Plan and Review on local-worktree, Build in a
#   sandbox or VM): a branch on the Mac with nothing of its own (no commit
#   beyond origin's default branch: Plan wrote only work files) is not pushed,
#   and nothing is brought into the machine for it. Back on local-worktree after
#   Build made the ticket's own branches (change/<KEY>-<id>), the variation's
#   worktree is moved onto the branch the machine used (code:create-worktree).
#   Branches pulled into a sandbox are its change/<KEY>-<id> ones (relay.bash),
#   so a worktree step that commits does so on a branch Build has made.
# - Between two machine targets (local-vm, workstation, cloud-vm, and ASS-553's
#   workstation-worktree and cloud-vm-worktree, whose steps claim the machine
#   in the variation's own folder there):
#   nothing moves here — their steps push and claim as they did before
#   (workstation-steps.js) — and only the target is recorded.
# - ASS-535: onto or off a Substrate sandbox (local-substrate,
#   workstation-substrate, cloud-vm-substrate), which has no forge credentials
#   of its own: the variation's own branches move through the Mac
#   (substrate/relay.bash) — out of the sandbox or the local VM it leaves
#   (leftovers committed, pushed to origin from the Mac), into the sandbox or
#   the local VM it goes to (fetched from origin on the Mac, brought in as
#   bundles, checked out); a workstation or cloud VM it leaves has pushed
#   already, and one it goes to claims as before; a Mac target's side is as
#   above. The sandbox (or VM) gone to must be there: control makes it first.
# - ASS-577: a ticket's Lima VM is stopped between its steps (ASS-527), so the
#   VM a hand-over reads its branches out of (or brings them into) is
#   normally stopped, and Lima refuses a shell into a stopped instance. Found
#   stopped, it is started here (vm:start: credentials in, so it can push),
#   the branches bundled or pushed, and stopped again (vm:stop) — on failure
#   too — only when this started it. Control asks the memory hold (ASS-398,
#   run-target-places.js handOverWaits) before running a hand-over that would
#   start one: under it the hand-over is not run at all (it waits, no failure
#   counted). A VM the variation records that no longer exists (deleted, or
#   reclaimed for disk) is said so plainly, and its branches are taken from the
#   forge: whatever change/<KEY>… branches origin has (the last step's push),
#   the rest of what the VM held named as lost — never retried forever.
#
# Prints { "from", "to", "branch", "folder" } (folder: the Mac place, or null),
# ASS-577: with "started-vm" (the Lima VM this started) and "stopped-again"
# (whether it was stopped again) when it started one, and "missing-vm" (the VM
# found gone) and "lost" (what of it could not be recovered) when one was gone.
# Fails, recording nothing, when a push or a fast-forward fails (diverged), the
# workspace is held by another ticket or has uncommitted changes, or the
# project, ticket or variation is missing; control holds the step and tries
# again (backoff.js).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"
here_code="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
unset HARNESS_RUN_TARGET

command=code:hand-over
targets="local-substrate workstation-substrate cloud-vm-substrate local-vm workstation cloud-vm workstation-worktree cloud-vm-worktree local-worktree local-workspace"
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <target>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" to="$4"
[[ " $targets " == *" $to "* ]] || { echo "$command: '$to' is not a run target ($targets)" >&2; exit 1; }
from="$(variation_field '.["run-target"].target // ""' "$command" "$project" "$key" "$variation" | jq -r .)"
on_mac() { [[ "$1" == local-worktree || "$1" == local-workspace ]]; }
on_sandbox() { [[ "$1" == *-substrate ]]; }
# machine_at <target> — the variation's machine on that target (its sandbox on a substrate one, machine.bash $machine_of).
machine_at() { HARNESS_RUN_TARGET="$1" vm_of "$command" "$project" "$key" "$variation"; }
# No target recorded yet (control records only moves onto or off the Mac): on its machine when it has one.
if [[ -z "$from" && -n "$(vm_of "$command" "$project" "$key" "$variation")" ]]; then from=local-vm; fi

# record — the variation's run-target, { target, at }.
record() {
  update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --arg to "$to" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    .variations |= map(if .name == $name and (.["is-deleted"] | not) then .["run-target"] = { target: $to, at: $at } else . end)'
}
done_with() {
  stop_started
  jq -nc --arg f "$from" --arg t "$to" --arg b "${1:-}" --arg d "${2:-}" --arg s "${started_vm:-}" --arg again "${stopped_again:-}" --arg m "${missing_vm:-}" --arg l "${lost:-}" '
    def n: if . == "" then null else . end;
    { from: ($f | n), to: $t, branch: ($b | n), folder: ($d | n) }
    + (if $s == "" then {} else { "started-vm": $s, "stopped-again": ($again == "yes") } end)
    + (if $m == "" then {} else { "missing-vm": $m, lost: ($l | n) } end)'
}

# ASS-577: the ticket's Lima VM, stopped between steps, started for the hand-over and stopped again (see above).
source "$here_code/../substrate/relay.bash"
started_vm="" stopped_again="" missing_vm="" lost=""
# stop_started — the VM this started, stopped again (once); a stop that fails is said, and left to control's VM lifecycle.
stop_started() {
  [[ -n "$started_vm" && -z "$stopped_again" ]] || return 0
  if "$here_code/../../../agent.sh" vm:stop "$project" "$started_vm" >/dev/null; then stopped_again=yes
  else stopped_again=no; echo "$command: could not stop $started_vm again; control's VM lifecycle stops it" >&2; fi
}
trap stop_started EXIT
# lima_ready <vm> — the machine ready for the hand-over: a Lima VM (no kind: prefix) found stopped is started (vm:start);
# 0 ready (or not a Lima VM: nothing to do), 3 when there is no such VM (no instance in the project's Lima folder, ASS-578); exits, saying
# why, when it won't start or its state can't be read.
lima_ready() {
  local vm="$1" status home
  [[ -n "$vm" && "$vm" != *:* ]] || return 0
  home="$(lima_home "$project")" || exit 1
  # Gone only when Lima has no instance folder for it either: a limactl that fails for another reason is no reason to
  # take the forge's branches over what the VM holds.
  if ! status="$(machine_status "$vm" 2>/dev/null)"; then
    [[ ! -e "$home/$vm" ]] || { echo "$command: could not read the state of $key $variation's Lima VM $vm" >&2; exit 1; }
    return 3
  fi
  [[ "$status" != Running ]] || return 0
  "$here_code/../../../agent.sh" vm:start "$project" "$key" "$variation" >/dev/null \
    || { echo "$command: could not start $key $variation's stopped Lima VM $vm to hand its branches over" >&2; exit 1; }
  started_vm="$vm"
}
# forge_branches — "<repo>\t<branch>" for each of the variation's own branches (relay.bash relay_slug) on the origin of
# each of the project's repositories.
forge_branches() {
  local url name re
  re="$(relay_slug "$key" "$variation")"
  while IFS= read -r url; do
    [[ -n "$url" ]] || continue
    name="$(basename "${url%.git}")"
    git ls-remote --heads "$url" 2>/dev/null | awk '{ sub("^refs/heads/", "", $2); print $2 }' | { grep -E "$re" || true; } | sed "s|^|$name"$'\t'"|"
  done < <(jq -r '.repositories[]?.url // empty' "$projects/$project/project.json")
}
# forge_fallback <vm> — the VM the variation records is gone: said plainly; its branches are those on the forge, and what
# could not be recovered is said (lost) — so the hand-over goes on, never retried for a VM that will not come back.
forge_fallback() {
  local found
  missing_vm="$1"; found="$(forge_branches)"
  if [[ -n "$found" ]]; then
    lost="whatever $1 held that was never pushed (on the forge: $(awk -F '\t' '{ printf "%s%s %s", (NR > 1 ? ", " : ""), $1, $2 }' <<< "$found"))"
  else lost="all of $key $variation's work in $1: none of its branches is on the forge"; fi
  echo "$command: $key $variation's Lima VM $1 no longer exists; its branches are taken from the forge instead; lost: $lost" >&2
}

# ASS-535: machine to machine with a sandbox on either side: the branches relayed through the Mac.
if [[ "$from" != "$to" ]] && { on_sandbox "$to" || on_sandbox "$from"; } && ! on_mac "$to" && { [[ -z "$from" ]] || ! on_mac "$from"; }; then
  moved="" vm="" ready=0
  if [[ "$from" == local-vm ]] || on_sandbox "$from"; then
    vm="$(machine_at "$from")"
    if [[ -n "$vm" ]]; then
      lima_ready "$vm" || ready=$?
      if [[ $ready -eq 3 ]]; then forge_fallback "$vm"   # ASS-577: relay_in below fetches them from origin
      else moved="$(relay_out "$command" "$project" "$key" "$variation" "$vm" "$from")" || exit 1; fi
      [[ "$vm" != "$started_vm" ]] || stop_started
    fi
  fi
  if [[ "$to" == local-vm ]] || on_sandbox "$to"; then
    vm="$(machine_at "$to")"
    [[ -n "$vm" ]] || { echo "$command: $key $variation has no machine on $to to hand over to (control makes its sandbox first)" >&2; exit 1; }
    lima_ready "$vm" || { echo "$command: $key $variation's Lima VM $vm no longer exists to hand over to (vm:create makes it)" >&2; exit 1; }
    moved+=$'\n'"$(relay_in "$command" "$project" "$key" "$variation" "$vm")" || exit 1
  fi
  record; done_with "$(awk -F '\t' 'NF > 1 { print $2; exit }' <<< "$moved")"; exit 0
fi

# Machine to machine (or a first target that is a machine): only recorded.
if ! on_mac "$to" && { [[ -z "$from" ]] || ! on_mac "$from"; }; then record; done_with; exit 0; fi

workspace="$(workspace_of "$command" "$project")"
repo="$(basename "$(git -C "$workspace" remote get-url origin)")"; repo="${repo%.git}"
build="$(build_of "$command" "$project" "$key" "$variation")"
branch="$(jq -r '.branch // empty' <<< "$build")"
default="$(default_branch "$workspace")"
leftovers() { echo "$key: work left uncommitted on $1"; }

# commit_and_push <folder> <target> — what is left committed, the branch checked out there pushed to origin.
# ASS-554: unless it holds nothing of its own (no commit beyond origin's default branch, nothing left): a worktree
# step (worktree: true) that wrote only work files — Plan's, before Build has made the ticket's branches — has a branch
# that is only a place to stand, and pushing it would put a stray branch on the forge for every ticket planned.
commit_and_push() {
  local dir="$1" was="$2" b
  b="$(git -C "$dir" symbolic-ref --quiet --short HEAD || true)"
  [[ -n "$b" && "$b" != "$default" ]] || { echo "$command: $dir is on ${b:-a detached HEAD}, not the ticket's branch" >&2; exit 1; }
  if [[ -n "$(git -C "$dir" status --porcelain)" ]]; then git -C "$dir" add -A && git -C "$dir" commit --quiet -m "$(leftovers "$was")"; fi
  branch="$b"
  if git -C "$dir" rev-parse --verify --quiet "origin/$default" >/dev/null && [[ "$(git -C "$dir" rev-list --count "origin/$default..HEAD")" == 0 ]] \
    && ! git -C "$dir" show-ref --verify --quiet "refs/remotes/origin/$b"; then return 0; fi
  git -C "$dir" push --quiet origin "HEAD:refs/heads/$b" || { echo "$command: could not push $b from $dir" >&2; exit 1; }
}

# Leaving where the last step ran.
if [[ "$from" == local-worktree ]]; then
  folder="$(jq -r '.["worktree-folder"] // empty' <<< "$build")"
  [[ -n "$folder" && -d "$folder" ]] && commit_and_push "$folder" "$from"
elif [[ "$from" == local-workspace ]]; then
  commit_and_push "$workspace" "$from"
  back="$(jq -r 'first(.["local-environments"][]? | select(.type == "local-pc") | .["return-to"]) // empty' "$projects/$project/project.json")"
  git -C "$workspace" checkout --quiet "${back:-$default}"
  update_json "$projects/$project/project.json" '.["local-environments"] |= map(if .type == "local-pc" then del(.["active-branch"], .["return-to"]) else . end)'
elif on_sandbox "$from"; then
  # ASS-535: out of a sandbox through the Mac (relay.bash); the workspace's repository's branch is the one the Mac uses.
  vm="$(machine_at "$from")"
  [[ -n "$vm" ]] || { echo "$command: $key $variation ran on $from but has no sandbox to hand over from" >&2; exit 1; }
  moved="$(relay_out "$command" "$project" "$key" "$variation" "$vm" "$from")" || exit 1
  b="$(awk -F '\t' -v r="$repo" '$1 == r { print $2; exit }' <<< "$moved")"
  if [[ -n "$b" ]]; then branch="$b"; set_build "$command" "$project" "$key" "$variation" "$(jq -nc --arg b "$branch" '{ branch: $b }')"; fi
elif [[ -n "$from" ]]; then
  vm="$(vm_of "$command" "$project" "$key" "$variation")"
  [[ -n "$vm" ]] || { echo "$command: $key $variation ran on $from but has no machine to hand over from" >&2; exit 1; }
  ready=0; lima_ready "$vm" || ready=$?
  if [[ $ready -eq 3 ]]; then
    # ASS-577: its Lima VM gone: the branch the Mac uses is the one recorded, else the workspace repository's on the forge.
    forge_fallback "$vm"
    [[ -n "$branch" ]] || branch="$(awk -F '\t' -v r="$repo" '$1 == r { print $2; exit }' <<< "$(forge_branches)")"
  else
  # In the machine's checkout: leftovers committed, its branch pushed; it names the branch.
  b="$(machine_run --workdir "/repos/$repo" "$vm" -- bash -c '
    set -e; b="$(git symbolic-ref --quiet --short HEAD)"; [ -n "$b" ] && [ "$b" != "$1" ] || { echo "on ${b:-a detached HEAD}, not a ticket branch" >&2; exit 1; }
    if [ -n "$(git status --porcelain)" ]; then git add -A; git commit --quiet -m "$2"; fi
    git push --quiet origin "HEAD:refs/heads/$b" >&2; echo "$b"' hand-over "$default" "$(leftovers "$from")" < /dev/null)" \
    || { echo "$command: could not push the branch from $vm (/repos/$repo)" >&2; exit 1; }
  branch="$b"
  set_build "$command" "$project" "$key" "$variation" "$(jq -nc --arg b "$branch" '{ branch: $b }')"
  fi
  [[ "$vm" != "$started_vm" ]] || stop_started
fi

# Onto the next. ASS-553: the checkout it is brought into — the workspace for local-workspace; a worktree the variation
# already has (made before the switch) its own checkout; else the harness's own clone (local-worktree, and a machine's
# branch named), so the operator's checkout is fetched and branched only by local-workspace.
wt="$(jq -r '.["worktree-folder"] // empty' <<< "$build")"
if [[ "$to" == local-workspace ]]; then repo_dir="$workspace" clone_flag=()
elif [[ "$to" == local-worktree && -n "$wt" && -d "$wt" ]] && worktree_repo "$wt" >/dev/null 2>&1; then repo_dir="$(worktree_repo "$wt")" clone_flag=(); [[ "$repo_dir" == "$(cd "$workspace" && pwd -P)" ]] || clone_flag=(--harness-clone)
else repo_dir="$(harness_clone "$command" "$project")" clone_flag=(--harness-clone); fi
git -C "$repo_dir" fetch --quiet origin 2>/dev/null || echo "$command: could not fetch origin; going on with what is here" >&2
if [[ -z "$branch" ]]; then branch="$("$here_code/create-branch.sh" "$project" "$key" "$variation" ${clone_flag[@]+"${clone_flag[@]}"} | jq -r .branch)"; fi
if ! git -C "$repo_dir" show-ref --verify --quiet "refs/heads/$branch"; then
  if git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/$branch"; then git -C "$repo_dir" branch --quiet --track "$branch" "origin/$branch"
  else git -C "$repo_dir" branch --quiet "$branch" "origin/$default" 2>/dev/null || git -C "$repo_dir" branch --quiet "$branch" "$default"; fi
fi
[[ "$(jq -r '.branch // empty' <<< "$(build_of "$command" "$project" "$key" "$variation")")" == "$branch" ]] || set_build "$command" "$project" "$key" "$variation" "$(jq -nc --arg b "$branch" '{ branch: $b }')"

# fast_forward <folder> — the branch checked out there brought up to origin's (when origin has it).
fast_forward() {
  git -C "$1" show-ref --verify --quiet "refs/remotes/origin/$branch" || return 0
  git -C "$1" merge --quiet --ff-only "origin/$branch" || { echo "$command: $branch in $1 has diverged from origin's; not handed over" >&2; exit 1; }
}

case "$to" in
  local-worktree)
    made="$("$here_code/create-worktree.sh" "$project" "$key" "$variation" --harness-clone)"
    folder="$(jq -r .folder <<< "$made")"
    # One made here is the run target's: removed once the ticket is done (run-target-places.js removeDoneWorktrees).
    [[ "$(jq -r .created <<< "$made")" != true ]] || set_build "$command" "$project" "$key" "$variation" '{ "worktree-by": "run-target" }'
    fast_forward "$folder"
    ;;
  local-workspace)
    lock_on 8 "$projects/$project/workspace.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}"
    held="$(jq -r 'first(.["local-environments"][]? | select(.type == "local-pc") | .["active-branch"]) // empty' "$projects/$project/project.json")"
    [[ -z "$held" || "$held" == "$branch" ]] || { echo "$command: the workspace is held by $held" >&2; exit 1; }
    [[ -z "$(git -C "$workspace" status --porcelain --untracked-files=no)" ]] || { echo "$command: the workspace $workspace has uncommitted changes" >&2; exit 1; }
    # A worktree of the variation on the branch in the workspace (its work pushed above) gives the branch up to it.
    # ASS-553: one in the harness's own clone holds no branch of the workspace's, and is kept for its next local-worktree.
    wt="$(jq -r '.["worktree-folder"] // empty' <<< "$(build_of "$command" "$project" "$key" "$variation")")"
    if [[ -n "$wt" && -d "$wt" && "$(worktree_repo "$wt" 2>/dev/null)" == "$(cd "$workspace" && pwd -P)" ]]; then
      remove_worktree "$wt"
      set_build "$command" "$project" "$key" "$variation" '{ "worktree": null, "worktree-folder": null }'
    fi
    was="$(git -C "$workspace" symbolic-ref --quiet --short HEAD || git -C "$workspace" rev-parse HEAD)"
    git -C "$workspace" checkout --quiet "$branch"
    fast_forward "$workspace"
    update_json "$projects/$project/project.json" --arg branch "$branch" --arg was "$was" '
      .["local-environments"] |= map(if .type == "local-pc" then .["active-branch"] = $branch | .["return-to"] //= $was else . end)'
    folder="$workspace"
    ;;
  *-substrate)
    # ASS-535: into a sandbox through the Mac (relay.bash): it fetches nothing itself.
    vm="$(machine_at "$to")"
    [[ -n "$vm" ]] || { echo "$command: $key $variation has no sandbox to hand over to ($to; control makes it first)" >&2; exit 1; }
    relay_in "$command" "$project" "$key" "$variation" "$vm" >/dev/null || exit 1
    folder=""
    ;;
  *)
    vm="$(vm_of "$command" "$project" "$key" "$variation")"
    [[ -n "$vm" ]] || { echo "$command: $key $variation has no machine to hand over to ($to)" >&2; exit 1; }
    lima_ready "$vm" || { echo "$command: $key $variation's Lima VM $vm no longer exists to hand over to (vm:create makes it)" >&2; exit 1; }
    # ASS-554: nothing of the branch on origin (a worktree step's branch with no work of its own, not pushed): nothing
    # to bring; the machine's checkout stays as it is.
    if ! git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/$branch"; then record; done_with "$branch" ""; exit 0; fi
    machine_run --workdir "/repos/$repo" "$vm" -- bash -c '
      set -e; git fetch --quiet origin
      if git show-ref --verify --quiet "refs/heads/$1"; then git checkout --quiet "$1"; git merge --quiet --ff-only "origin/$1"
      else git checkout --quiet -b "$1" "origin/$1"; fi' hand-over "$branch" < /dev/null >&2 \
      || { echo "$command: could not bring $branch up to date in $vm (/repos/$repo)" >&2; exit 1; }
    folder=""
    ;;
esac
record
done_with "$branch" "$folder"
