#!/usr/bin/env bash
# Description: Undo ticket:delete's soft delete — ticket:restore <project> <ticket-key>.
set -euo pipefail

# ASS-104: drops is-deleted and deleted-timestamp from the ticket wherever
# the project lists it deleted (its active sprint, backlog.json), so control
# and the dashboard see it again — its VM started again when its step wants
# one. What ticket:delete stopped or closed stays so: its agents and runs are
# gone (control dispatches its step afresh), its merge requests closed, its
# worktree removed. Prints { key, restored: [sprint|backlog…] }. Fails,
# writing nothing, when no file lists it deleted.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 2 ]] || { echo "usage: ticket:restore <project> <ticket-key>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$project/project.json" ]] || { echo "ticket:restore: no project '$project'" >&2; exit 1; }

# The sprint chosen and written inside the project's tickets.lock (ASS-179, sprint.bash lock_tickets).
lock_tickets ticket:restore "$project"
restored=()
for where in sprint backlog; do
  if [[ "$where" == sprint ]]; then file="$(sprint_file ticket:restore "$project" 2>/dev/null || true)"; else file="$projects/$project/backlog.json"; fi
  [[ -f "$file" ]] && jq -e --arg k "$key" 'any((.features, .bugs, .spikes, .tickets) // [] | .[]; (.key | ascii_upcase == $k) and .["is-deleted"] == true)' "$file" >/dev/null || continue
  update_json "$file" --arg k "$key" '((.features, .bugs, .spikes, .tickets) // empty) |= map(if .key | ascii_upcase == $k then del(.["is-deleted"], .["deleted-timestamp"]) else . end)'
  restored+=("$where")
done
[[ ${#restored[@]} -gt 0 ]] || { echo "ticket:restore: $key is not deleted in $project" >&2; exit 1; }
jq -nc --arg key "$key" --args '{ key: $key, restored: $ARGS.positional }' "${restored[@]}"
