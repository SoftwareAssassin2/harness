#!/usr/bin/env bash
# Description: Give the workspace back once the agent that needed the app is done — code:release-workspace <project> <ticket-key> <variation>.
set -euo pipefail

# Undoes code:checkout-in-workspace: the workspace is checked out at its
# local-pc environment's return-to again — the branch it was on, never left
# detached — and active-branch and return-to become null. Never stashes,
# commits or discards work. Prints { "released": <bool> }, false when it was
# not held for this variation — checked under the project's workspace.lock
# (ASS-173, see code:checkout-in-workspace), so it never clears another's
# claim. Fails, changing nothing, when the workspace
# has uncommitted changes to tracked files, or the project, workspace, ticket
# or variation is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

[[ $# -eq 3 ]] || { echo "usage: code:release-workspace <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
workspace="$(workspace_of code:release-workspace "$project")"
branch="$(build_of code:release-workspace "$project" "$key" "$variation" | jq -r '.branch // empty')"
lock_on 8 "$projects/$project/workspace.lock" code:release-workspace "${JSON_LOCK_TIMEOUT:-30}"
held="$(jq -r 'first(.["local-environments"][]? | select(.type == "local-pc") | .["active-branch"]) // empty' "$projects/$project/project.json")"

released=false
if [[ -n "$branch" && "$held" == "$branch" ]]; then
  [[ -z "$(git -C "$workspace" status --porcelain --untracked-files=no)" ]] || { echo "code:release-workspace: the workspace $workspace has uncommitted changes" >&2; exit 1; }
  back="$(jq -r 'first(.["local-environments"][]? | select(.type == "local-pc") | .["return-to"]) // empty' "$projects/$project/project.json")"
  [[ -z "$back" ]] || git -C "$workspace" checkout --quiet "$back"
  update_json "$projects/$project/project.json" '
    .["local-environments"] |= map(if .type == "local-pc" then .["active-branch"] = null | .["return-to"] = null else . end)'
  released=true
fi
jq -nc --argjson r "$released" '{ released: $r }'
