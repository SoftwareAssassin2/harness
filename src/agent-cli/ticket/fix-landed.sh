#!/usr/bin/env bash
# Description: Whether the fix a ticket variation waits on has landed — ticket:fix-landed <project> <ticket-key> <variation>.
set -euo pipefail

# Reads the variation's "waits-on" (ticket:wait-on) and finds that ticket in
# its own project's active sprint, else its backlog. Landed is its ticket
# system status Done with a live variation that went through a merge step —
# merge-pull-request (harness-development) or ensure-auto-merge
# (a GitLab project's own engine) — anywhere in its state changes: top level
# (flat harness-development) or nested in a sub-state-change at any depth
# (grouped/v2 engines, whose merge lives in the release sub-engine; ASS-309).
# A Done ticket with no merge step has landed too when a commit whose subject
# starts "<KEY>:" (the key exactly: ASS-33 is not ASS-335) is reachable from
# the default branch of its project's workspace — code.bash's workspace_of
# (the project's local-pc checkout) and default_branch (origin's default
# branch), read as the local branch and as origin's, last fetched: a ticket
# built by hand and committed straight to the default branch, with no merge
# step (ASS-340). That reads a host checkout, so it is for control's host;
# where the workspace is missing or not a git checkout (inside a VM, say), or
# neither branch can be read, no commit is found and it is not landed.
# Prints { waits-on, status,
# landed } and exits 0 once landed; exits 3 when it is Done without a merge
# or such a commit (closed without its fix merged: a failed fix attempt); 1
# until then. When
# the variation waits on nothing, or is missing, exit 4, printing why as { ai-feedback-short, ai-feedback-long } (ASS-107 AC7: the
# fix cannot be waited on).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../code.bash"

# committed <project> <ticket-key> — whether a commit whose subject starts
# "<ticket-key>:" is reachable from the default branch of the project's
# workspace, locally or on origin as last fetched; fails when none is, or the
# workspace or branch cannot be read.
committed() {
  local workspace branch ref refs=()
  workspace="$(workspace_of ticket:fix-landed "$1" 2>/dev/null)" || return 1
  branch="$(default_branch "$workspace")"
  for ref in "refs/heads/$branch" "refs/remotes/origin/$branch"; do
    git -C "$workspace" rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1 && refs+=("$ref")
  done
  [[ ${#refs[@]} -gt 0 ]] || return 1
  git -C "$workspace" log --fixed-strings --grep="$2:" --format=%s "${refs[@]}" 2>/dev/null \
    | awk -v prefix="$2:" 'index($0, prefix) == 1 { found = 1 } END { exit !found }'
}

[[ $# -eq 3 ]] || { echo "usage: ticket:fix-landed <project> <ticket-key> <variation>" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
waits="$(jq -c --arg key "$key" --arg name "$3" '
  first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_upcase == $key)) // {} | .variations // [] | map(select(.name == $name)) | first | .["waits-on"] // empty' "$(sprint_file ticket:fix-landed "$1")")"
[[ -n "$waits" ]] || {
  jq -nc --arg l "$key $3 waits on no fix ticket, so it cannot wait for one to land." '{ "ai-feedback-short": "The fix ticket cannot be waited on", "ai-feedback-long": $l }'
  echo "ticket:fix-landed: $key $3 waits on no ticket" >&2; exit 4; }
home="$(jq -r .project <<< "$waits")" fix="$(jq -r .ticket <<< "$waits")"
files=("$(sprint_file ticket:fix-landed "$home")")
backlog="$(dirname "$(dirname "$(dirname "${files[0]}")")")/backlog.json"
[[ -f "$backlog" ]] && files+=("$backlog")
found="$(jq -cs --arg key "$fix" '
  first(.[] | (.features, .bugs, .spikes, .tickets) // [] | .[] | select(.key | ascii_upcase == $key))
  | { status: (.["ticket-system-status"] // null),
      merged: any(.variations // [] | .[] | select(.["is-deleted"] | not) | .["state-changes"] // [] | .[] | .. | objects | select(has("from-state")); .["from-state"] | IN("merge-pull-request", "ensure-auto-merge")) }' "${files[@]}")"
status="$(jq -r '.status // "unknown"' <<< "${found:-null}")"
merged="$(jq -r '.merged // false' <<< "${found:-null}")"
landed=false
[[ "$status" == Done && "$merged" == true ]] && landed=true
[[ "$status" == Done && "$landed" == false ]] && committed "$home" "$fix" && landed=true
jq -nc --argjson w "$waits" --arg s "$status" --argjson l "$landed" '{ "waits-on": $w, status: $s, landed: $l }'
[[ "$landed" == true ]] && exit 0
[[ "$status" == Done ]] && { echo "ticket:fix-landed: $fix is Done without its fix merged" >&2; exit 3; }
exit 1
