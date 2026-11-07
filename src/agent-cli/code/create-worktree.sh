#!/usr/bin/env bash
# Description: Create the ticket's worktree on its branch — code:create-worktree <project> <ticket-key> <variation>.
set -euo pipefail

# The worktree <workspace>/.worktrees/<KEY> (or <KEY>.<variation>, see
# code.bash) on the variation's build.branch (code:create-branch first): one
# already there on that branch is kept; .worktrees/ is excluded from git
# (.git/info/exclude) when the repo does not ignore it. The worktree is
# linked by relative paths, so it works from the dev container too, where
# the workspace is mounted elsewhere (git 2.48+ on both sides). Records
# build.worktree (the folder's name) and build.worktree-folder (its absolute
# path) on the variation and prints { "worktree", "folder", "created" }.
# A worktree it creates is readied with project.json's worktree-setup (a shell
# command run in the worktree, e.g. installing dependencies, through
# in_project: in the dev container when the project has one), when set; when
# it fails the worktree is removed, so a retry creates and readies it afresh.
# Fails, writing nothing, when the branch is not yet made, the folder holds
# something else, or the project, workspace, ticket or variation is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

[[ $# -eq 3 ]] || { echo "usage: code:create-worktree <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
workspace="$(workspace_of code:create-worktree "$project")"
branch="$(build_of code:create-worktree "$project" "$key" "$variation" | jq -r '.branch // empty')"
[[ -n "$branch" ]] || { echo "code:create-worktree: $key $variation has no branch yet; run code:create-branch first" >&2; exit 1; }
folder="$(worktree_folder "$workspace" "$key" "$variation")"

created=false
if [[ -e "$folder" ]]; then
  on="$(git -C "$folder" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [[ "$on" == "$branch" ]] || { echo "code:create-worktree: $folder exists but is not a worktree on $branch" >&2; exit 1; }
else
  mkdir -p "$(dirname "$folder")"
  git -C "$workspace" check-ignore -q .worktrees 2>/dev/null || echo ".worktrees/" >> "$(git -C "$workspace" rev-parse --absolute-git-dir)/info/exclude"
  git -C "$workspace" worktree add --quiet --relative-paths "$folder" "$branch"
  created=true
  setup="$(jq -r '."worktree-setup" // empty' "$projects/$project/project.json")"
  if [[ -n "$setup" ]] && ! in_project code:create-worktree "$project" "$folder" "$setup" >&2; then
    git -C "$workspace" worktree remove --force "$folder"
    echo "code:create-worktree: worktree-setup failed in $folder ($setup); the worktree was removed" >&2
    exit 1
  fi
fi

set_build code:create-worktree "$project" "$key" "$variation" "$(jq -nc --arg w "$(basename "$folder")" --arg f "$folder" '{ worktree: $w, "worktree-folder": $f }')"
jq -nc --arg w "$(basename "$folder")" --arg f "$folder" --argjson c "$created" '{ worktree: $w, folder: $f, created: $c }'
