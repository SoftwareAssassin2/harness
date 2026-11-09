#!/usr/bin/env bash
# Description: Bring the project's workspace up to date with its default branch — code:update-workspace <project>.
set -euo pipefail

# Fast-forwards the workspace (the project's local-pc checkout, see code.bash)
# to origin's default branch: the branch fetched into a private
# refs/update-workspace/<branch>, then `git merge --ff-only`. None of the
# shared refs/remotes/origin/* are written, so a concurrent plain
# `git fetch origin` in the same workspace (code/create-branch.sh for another
# ticket, another update) cannot race us on the tracking refs ("cannot lock
# ref ... is at X but expected Y", ASS-319); --refmap= is required, as without
# it the fetch would also update the matching refs/remotes/origin/*
# opportunistically from the remote's refmap, which races just the same. For
# the harness, whose workspace is the checkout it runs from, this is how a
# merged fix reaches the running code before it restarts. Local changes the
# update does not touch stay as they are (the harness's own data files are
# always changing); git refuses one that would overwrite them. Never stashes,
# commits, discards or makes a merge commit. Prints { "branch", "head" }.
# Fails, changing nothing, when the default branch cannot be fetched from
# origin, the update would overwrite a local change, the workspace is not on
# the default branch, or it cannot fast-forward; or the project or workspace
# is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

[[ $# -eq 1 ]] || { echo "usage: code:update-workspace <project>" >&2; exit 1; }
workspace="$(workspace_of code:update-workspace "$1")"
branch="$(default_branch "$workspace")"
on="$(git -C "$workspace" symbolic-ref --quiet --short HEAD || echo detached)"
[[ "$on" == "$branch" ]] || { echo "code:update-workspace: the workspace is on $on, not $branch" >&2; exit 1; }
git -C "$workspace" fetch --quiet --refmap= origin "+refs/heads/$branch:refs/update-workspace/$branch" || { echo "code:update-workspace: could not fetch $branch from origin" >&2; exit 1; }
git -C "$workspace" merge --quiet --ff-only "refs/update-workspace/$branch" || { echo "code:update-workspace: could not fast-forward $workspace to origin/$branch" >&2; exit 1; }
jq -nc --arg b "$branch" --arg h "$(git -C "$workspace" rev-parse HEAD)" '{ branch: $b, head: $h }'
