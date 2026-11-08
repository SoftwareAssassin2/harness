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
# Prints { waits-on, status,
# landed } and exits 0 once landed; exits 3 when it is Done without a merge
# (closed without its fix merged: a failed fix attempt); 1 until then. When
# the variation waits on nothing, or is missing, exit 4, printing why as { ai-feedback-short, ai-feedback-long } (ASS-107 AC7: the
# fix cannot be waited on).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"

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
jq -nc --argjson w "$waits" --arg s "$status" --argjson l "$landed" '{ "waits-on": $w, status: $s, landed: $l }'
[[ "$landed" == true ]] && exit 0
[[ "$status" == Done ]] && { echo "ticket:fix-landed: $fix is Done without its fix merged" >&2; exit 3; }
exit 1
