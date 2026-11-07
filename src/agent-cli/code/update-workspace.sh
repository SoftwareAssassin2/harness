#!/usr/bin/env bash
# Description: Bring the project's workspace up to date with its default branch — code:update-workspace <project>.
set -euo pipefail

# Fast-forwards the workspace (the project's local-pc checkout, see code.bash)
# to origin's default branch: `git pull --ff-only`. For the harness, whose
# workspace is the checkout it runs from, this is how a merged fix reaches the
# running code before it restarts. Local changes the update does not touch
# stay as they are (the harness's own data files are always changing); git
# refuses one that would overwrite them. Never stashes, commits, discards or
# merges. Prints { "branch", "head" }. Fails, changing nothing, when the
# update would overwrite a local change, the workspace is not on the default
# branch, or it cannot fast-forward; or the project or workspace is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

[[ $# -eq 1 ]] || { echo "usage: code:update-workspace <project>" >&2; exit 1; }
workspace="$(workspace_of code:update-workspace "$1")"
branch="$(default_branch "$workspace")"
on="$(git -C "$workspace" symbolic-ref --quiet --short HEAD || echo detached)"
[[ "$on" == "$branch" ]] || { echo "code:update-workspace: the workspace is on $on, not $branch" >&2; exit 1; }
git -C "$workspace" pull --quiet --ff-only origin "$branch" || { echo "code:update-workspace: could not fast-forward $workspace to origin/$branch" >&2; exit 1; }
jq -nc --arg b "$branch" --arg h "$(git -C "$workspace" rev-parse HEAD)" '{ branch: $b, head: $h }'
