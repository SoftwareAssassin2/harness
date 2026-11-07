#!/usr/bin/env bash
# Description: Create the ticket's branch in the project's workspace — code:create-branch <project> <ticket-key> <variation>.
set -euo pipefail

# The branch change/<KEY> (change/<KEY>.<variation> for a variation other
# than A) in the workspace (see code.bash): origin fetched, an existing
# branch of that name in any case reused (one only on origin tracked), else
# made from origin's default branch. Records build.branch and
# build.branch-url (the branch's page on its forge, branch_url) on the variation in the active
# sprint and prints { "branch", "created" }. Fails, writing nothing, when the
# project, workspace, ticket or variation is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

[[ $# -eq 3 ]] || { echo "usage: code:create-branch <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
workspace="$(workspace_of code:create-branch "$project")"
build_of code:create-branch "$project" "$key" "$variation" >/dev/null
wanted="$(branch_name "$key" "$variation")"

git -C "$workspace" fetch --quiet origin 2>/dev/null || echo "code:create-branch: could not fetch origin; going on with what is here" >&2
branch="$(find_branch "$workspace" "$wanted")"
created=false
if [[ -z "$branch" ]]; then
  base="$(default_branch "$workspace")"
  git -C "$workspace" branch --quiet "$wanted" "origin/$base" 2>/dev/null || git -C "$workspace" branch --quiet "$wanted" "$base"
  branch="$wanted" created=true
elif ! git -C "$workspace" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$workspace" branch --quiet --track "$branch" "origin/$branch"     # on origin only: tracked here now
fi

set_build code:create-branch "$project" "$key" "$variation" "$(jq -nc --arg b "$branch" --arg url "$(branch_url "$workspace" "$branch")" '{ branch: $b, "branch-url": $url }')"
jq -nc --arg b "$branch" --argjson c "$created" '{ branch: $b, created: $c }'
