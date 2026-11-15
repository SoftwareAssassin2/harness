#!/usr/bin/env bash
# Description: Add a non-secret VM-setup declaration a ticket's VM lacked to ~/.harness/vm-credentials.json, and set the ticket's VM up with it at once — vm:credentials-declare <project> <ticket-key> <variation> npm-registry <@scope> <gitlab-project-id>; prints JSON.
set -euo pipefail

# ASS-427 AC2/AC5: a block where the credential is valid but the VM is not set
# up to use it (ABC-897: a project declared no gitlab npm-registries, so
# vm:credentials wrote no /run/harness/npmrc and pnpm reached the @example
# registry anonymously, 401) is fixed by Blocked's Repair the VM, not the
# credentials hold: the declaration vm:credentials writes the VM's files from
# is the source every later VM is set up from, so no rebuild is needed. The
# one kind an agent may add:
#   npm-registry <@scope> <id> — gitlab's "npm-registries": { "<@scope>":
#     "<id>" }, the GitLab project whose package registry serves the scope
#     (a number); written into /run/harness/npmrc with ${GITLAB_TOKEN} as its
#     auth (vm-credentials.bash). Never a token: the project must declare
#     gitlab already, its keychain item the operator's.
# Added only, never changed: a scope declared with another id is refused (the
# operator's decision), one declared with the same id changes nothing. The
# file is edited under its lock (json-file.bash update_json: its mode, 600,
# kept), the project's other entries and every other project's as they were.
# Then, the same change in the ticket's VM: vm:credentials <project> <vm>
# writes its /run/harness files again from the declaration (the keychain read
# by the harness, as at every VM start: no secret passes through the agent),
# when the variation has a VM running (applied true; false, saying why, when
# it has none or it is not running — it gets it when it next starts). Logged
# in the variation's change log (work.bash blocked_log, "Repair the VM").
# Prints { project, kind, scope, id, declared (added now), applied }. Exits 3,
# changing nothing, when the project declares no gitlab credential, or the
# scope another id; 1 on bad arguments or an unknown ticket or variation; and
# 1 when the VM's credentials could not be written (the declaration stays:
# every later VM has it).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/work.bash"

command=vm:credentials-declare title="Repair the VM"
usage="usage: $command <project> <ticket-key> <variation> npm-registry <@scope> <gitlab-project-id>"
[[ $# -eq 6 && "$4" == npm-registry ]] || { echo "$usage" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3" scope="$5" id="$6"
[[ "$scope" =~ ^@[a-z0-9._-]+$ ]] || { echo "$command: '$scope' is not an npm scope (@name, lower case)" >&2; exit 1; }
[[ "$id" =~ ^[0-9]+$ ]] || { echo "$command: '$id' is not a GitLab project id (a number)" >&2; exit 1; }
variation_exists "$command" "$project" "$key" "$variation"
file="$HOME/.harness/vm-credentials.json"
refuse() { blocked_log "$project" "$key" "$variation" "$title" "vm:credentials-declare refused: $1"; echo "$command: $1" >&2; exit 3; }
[[ -f "$file" ]] || refuse "no $file: which credentials $project's VMs get is the operator's to declare"
jq -e --arg p "$project" '.[$p].gitlab["keychain-service"] | strings | length > 0' "$file" >/dev/null 2>&1 \
  || refuse "$project declares no gitlab credential in $file, so an npm registry there would have no token: the operator declares gitlab (its keychain item) first"
was="$(jq -r --arg p "$project" --arg s "$scope" '.[$p].gitlab["npm-registries"][$s] // empty | tostring' "$file")"
[[ -z "$was" || "$was" == "$id" ]] || refuse "$project already declares $scope as GitLab project $was, not $id: changing it is the operator's decision"
declared=false
if [[ -z "$was" ]]; then
  update_json "$file" --arg p "$project" --arg s "$scope" --arg id "$id" '.[$p].gitlab["npm-registries"] = ((.[$p].gitlab["npm-registries"] // {}) + { ($s): $id })'
  declared=true
fi

applied=false why=""
if vm="$(running_vm "$command" "$project" "$key" "$variation" 2>&1)"; then
  "$agent" vm:credentials "$project" "$vm" >/dev/null || {
    blocked_log "$project" "$key" "$variation" "$title" "vm:credentials-declare: $scope → GitLab project $id declared in $file$( [[ $declared == true ]] || echo ' (already)'), but vm:credentials $project $vm failed: its VM is not set up with it yet."
    echo "$command: declared, but vm:credentials $project $vm failed" >&2
    exit 1
  }
  applied=true
else
  why="${vm#"$command: "}"
fi
blocked_log "$project" "$key" "$variation" "$title" "vm:credentials-declare: gitlab npm-registries $scope → GitLab project $id $( [[ $declared == true ]] && echo "added to $file" || echo "already in $file"): every later VM of $project gets it as it starts. $( [[ $applied == true ]] && echo "Applied in $vm now (vm:credentials: its /run/harness files written again)." || echo "Not applied in its VM now: $why.")"
jq -nc --arg p "$project" --arg s "$scope" --arg id "$id" --argjson d "$declared" --argjson a "$applied" --arg why "$why" \
  '{ project: $p, kind: "npm-registry", scope: $s, id: $id, declared: $d, applied: $a } + (if $why == "" then {} else { "not-applied": $why } end)'
