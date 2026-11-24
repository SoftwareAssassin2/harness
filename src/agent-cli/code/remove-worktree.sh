#!/usr/bin/env bash
# Description: Remove the worktree a ticket variation's local-worktree run target made, once the ticket is done (ASS-540) — code:remove-worktree <project> <ticket-key> <variation>.
set -euo pipefail

# The variation's build.worktree-folder removed from its checkout
# (git worktree remove --force; the branch stays, pushed by its steps and by
# code:hand-over) and its build.worktree, worktree-folder and worktree-by
# cleared. Control runs it for a done variation whose worktree code:hand-over
# made for local-worktree (build.worktree-by run-target): a worktree an engine's
# own code:create-worktree step made is left alone. A folder already gone is
# only cleared. Prints { "removed": <folder or null> }. Fails, changing
# nothing, when the project, workspace, ticket or variation is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

command=code:remove-worktree
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
build="$(build_of "$command" "$project" "$key" "$variation")"
folder="$(jq -r '.["worktree-folder"] // empty' <<< "$build")"
# ASS-553: removed from the checkout it belongs to — the harness's own clone (code.bash harness_clone), or the
# workspace for one made before.
if [[ -n "$folder" && -d "$folder" ]]; then
  remove_worktree "$folder"
fi
set_build "$command" "$project" "$key" "$variation" '{ "worktree": null, "worktree-folder": null, "worktree-by": null }'
jq -nc --arg f "$folder" '{ removed: (if $f == "" then null else $f end) }'
