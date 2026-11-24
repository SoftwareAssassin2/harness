#!/usr/bin/env bash
# Description: End a ticket variation's step on a project's GCP workstation and free it — a completed step's leftovers committed, the rest discarded, committed work pushed, every repository back on master at the latest — workstation:release <project> <id> [--force] [--completed <step>] [--slot <n>]; prints what it did.
set -euo pipefail

# ASS-468 AC3, AC9, AC10: a step's end, whatever its outcome (success,
# failure, stop, its agent killed), run by control once none of the holder's
# steps runs on the workstation (src/control/workstation-steps.js), with
# --completed "<the step>" when the step completed (its agent's turn ended
# without error, its script exited 0). In every shared repository
# (step-trees.sh end): what is not committed — changes and untracked files,
# never the ignored dependency and build caches — is, for a completed step on
# a branch other than master, committed there with a message naming the
# ticket and the step (each step commits its own work; this safety net is
# logged as a warning by control), else discarded, each file named; then the
# variation's own planned branch's commits GitLab lacks pushed to that branch
# (ASS-478: never another ticket's, never one GitLab deleted after its merge;
# never forced; a rejected push said, its commits kept on the local branch
# for the variation's next step; ASS-480: another ticket's local branch
# that has parted from GitLab's, so a push of it would be rejected, is set
# aside under refs/harness/stray/<branch>/<time>, its local branch deleted,
# and listed in set-aside for control to report on that ticket); master never pushed — a local master ahead of
# GitLab's is reset to it, the discarded commits named — and checked out at
# GitLab's latest. Only once every tree is clean: the step's Docker
# containers (working in the shared repositories or the ticket's copy, or
# mounting them), their anonymous volumes and their compose projects' named
# volumes and networks removed, the ticket's copy emptied, the credentials
# and forwarder token in the runtime folder removed (env, gitconfig, npmrc,
# gh, glab, agent-token; setup's agent-url stays), the vm-tokens.json binding
# dropped, the variation's `workstation` and the holder cleared. A tree that
# cannot be made clean keeps the workstation held (fails, 1), so no other
# variation gets it dirty. Each action is logged on stderr; prints {
# released: { ticket, variation, folder, migrated }, pushed: [{ repository,
# branch, commits }], push-failed: [{ repository, branch, why }], committed:
# [{ repository, branch, files }], discarded: [{ repository, branch, files
# }], master-reset: [{ repository, branch, commits }], unclean: […],
# set-aside: [{ repository, branch, ref, commits, why }], exit }
# (released null with no holder).
#
# AC7, the migration: a holder from before ASS-468 records its own folder,
# ~/harness/<KEY>-<variation> (ASS-435): its trees are pushed and cleaned
# the same way there (its step did not complete: what it left uncommitted is
# discarded, named), then the folder is removed whole with its containers.
#
# Refused while an assignment is on the holder's variation (an agent at
# work) unless --force. Under the project's pool lock (descriptor 7), so a
# claim never races it. Needs the connection open (workstation:connect):
# fails, the holder kept, when it is not. Nothing outside ~/harness and the
# runtime folder is touched, nor ~/harness's bin, lib, tools, env,
# setup.json and golden-image.
#
# ASS-529: a machine takes several tickets' steps at once, each in a folder of
# its own (a slot, workstation-variation.bash): --slot <n> ends the step of the
# holder of slot n (0, the shared root, without it) and frees that slot alone;
# the other slots' steps go on, and the project's credentials in the runtime
# folder stay while any is held.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

command=workstation:release
usage="usage: $command <project> <id> [--force] [--completed <step>] [--slot <n>]"
force="" wsv_completed=incomplete wsv_message="" wsv_slot=0 args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) force=1; shift ;;
    --completed) [[ $# -ge 2 && -n "$2" ]] || { echo "$usage" >&2; exit 1; }; wsv_completed=completed step="$2"; shift 2 ;;
    --slot) [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { echo "$usage" >&2; exit 1; }; wsv_slot="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
[[ ${#args[@]} -eq 2 ]] || { echo "$usage" >&2; exit 1; }
project="${args[0]}" id="${args[1]}"
workstation_settings "$command" "$project" "$id" >/dev/null
wsv_pool_lock "$command" "$project"
holder="$(workstation_entry "$project" "$id" | jq -c --argjson n "$wsv_slot" "$wsv_holders"' | map(select(.slot == $n)) | first // empty')"
if [[ -n "$holder" && -z "$force" ]] && wsv_busy "$project" "$(jq -r .ticket <<< "$holder")" "$(jq -r .variation <<< "$holder")"; then
  echo "$command: $(jq -r '"\(.ticket) \(.variation)"' <<< "$holder") still has an agent at work on $project's workstation $id; --force to free it anyway" >&2
  exit 1
fi
[[ "$wsv_completed" != completed || -z "$holder" ]] || wsv_message="$(jq -r --arg s "$step" '"\(.ticket) \(.variation) \($s): what the step left uncommitted, committed by the harness at its end (ASS-468)"' <<< "$holder")"
wsv_release "$command" "$project" "$id"
