#!/usr/bin/env bash
# Description: Say on the ticket that it is ready to build — ticket:announce-ready <project> <ticket-key>.
set -euo pipefail

# For a Jira project, a comment on the ticket (ticket:post-comment): groomed
# with nothing left to ask, and approved by the operator. Any other project's
# ticket (an off-board one) gets nothing: Ready shows on the dashboard only.
# Prints { ticket, announced }.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../ticket-system.bash"

[[ $# -eq 2 ]] || { echo "usage: ticket:announce-ready <project> <ticket-key>" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
announced=false
if [[ "$(ticket_system ticket:announce-ready "$1")" == jira ]]; then
  note="$(mktemp)"
  printf 'Ready: groomed with nothing left to ask, and approved by the operator. It can go into a sprint.\n' > "$note"
  "$here/../../../agent.sh" ticket:post-comment "$1" "$key" "$note" >/dev/null
  rm -f "$note"
  announced=true
fi
jq -nc --arg t "$key" --argjson a "$announced" '{ ticket: $t, announced: $a }'
