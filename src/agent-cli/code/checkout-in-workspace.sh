#!/usr/bin/env bash
# Description: Put the workspace at the ticket's branch for an agent that needs the app — code:checkout-in-workspace <project> <ticket-key> <variation>.
set -euo pipefail

# The workspace (the project's local-pc checkout, see code.bash) is the one
# place the application runs, so a step that needs it (run-in-dev-container)
# has it to itself, at the ticket's branch: the workspace checks out the
# branch's commit detached — the branch itself stays with the variation's
# worktree, where the agent runs and commits — and project.json's local-pc
# environment records the branch as active-branch, and as return-to where
# the workspace was before (its branch, or its commit when detached) — kept
# from the first checkout while one is held. Prints { "branch" }.
# code:release-workspace puts the workspace back there. One holder at a time
# (ASS-173): the check, the checkout and the claim are made under the
# project's workspace.lock, which code:release-workspace takes too. Fails,
# changing nothing, when another branch holds the workspace, the workspace has
# uncommitted changes to tracked files, the branch is not yet made, or the
# project, workspace, ticket or variation is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

[[ $# -eq 3 ]] || { echo "usage: code:checkout-in-workspace <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
workspace="$(workspace_of code:checkout-in-workspace "$project")"
build="$(build_of code:checkout-in-workspace "$project" "$key" "$variation")"
branch="$(jq -r '.branch // empty' <<< "$build")"
[[ -n "$branch" ]] || { echo "code:checkout-in-workspace: $key $variation has no branch yet; run code:create-branch first" >&2; exit 1; }

lock_on 8 "$projects/$project/workspace.lock" code:checkout-in-workspace "${JSON_LOCK_TIMEOUT:-30}"
held="$(jq -r 'first(.["local-environments"][]? | select(.type == "local-pc") | .["active-branch"]) // empty' "$projects/$project/project.json")"
[[ -z "$held" || "$held" == "$branch" ]] || { echo "code:checkout-in-workspace: the workspace is held by $held" >&2; exit 1; }
[[ -z "$(git -C "$workspace" status --porcelain --untracked-files=no)" ]] || { echo "code:checkout-in-workspace: the workspace $workspace has uncommitted changes" >&2; exit 1; }

was="$(git -C "$workspace" symbolic-ref --quiet --short HEAD || git -C "$workspace" rev-parse HEAD)"
git -C "$workspace" checkout --quiet --detach "$branch"
update_json "$projects/$project/project.json" --arg branch "$branch" --arg was "$was" '
  .["local-environments"] |= map(if .type == "local-pc" then .["active-branch"] = $branch | .["return-to"] //= $was else . end)'
jq -nc --arg b "$branch" '{ branch: $b }'
