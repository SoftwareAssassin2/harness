#!/usr/bin/env bash
# Description: Whether Split's agent recorded a proposal since the ticket last moved to Split — ticket:split-proposed <project> <ticket-key>.
set -euo pipefail

# ASS-265: the family's backlog refinement's Check the Proposal, between
# Split (the split-ticket prompt, at the operator's Split at Too Large) and
# Awaiting Split Decision. The ticket's split-proposal.json
# (ticket:propose-split) counts when its proposed-at is no earlier than the
# ticket's last move to Split — the last state change into "split" of its
# live variations, in the backlog or the active sprint, whichever lists it —
# or, with no such move recorded, whenever it was made: a proposal left from
# an earlier Split the operator rejected is not this one's. Prints { ticket,
# proposed, proposed-at } and exits 0 when it counts; otherwise says why and
# exits 1, so the ticket goes back to Too Large rather than to a gate showing
# no proposal, or a stale one.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
backlog_too=1
source "$here/../sprint.bash"
source "$here/../work.bash"

command=ticket:split-proposed
[[ $# -eq 2 ]] || { echo "usage: $command <project> <ticket-key>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
file="$(work_path "$command" "$project" "$key" - split-proposal.json)"
[[ -f "$file" ]] || { echo "$command: $key has no split proposal (ticket:propose-split)" >&2; exit 1; }
at="$(jq -r '.["proposed-at"] // empty' "$file" 2>/dev/null)" || at=""
[[ -n "$at" ]] || { echo "$command: $key's split proposal is not one ticket:propose-split wrote" >&2; exit 1; }

# The ticket's last move to Split, "" when none is recorded.
since="$(jq -r --arg key "$key" '
  [(.features, .bugs, .spikes, .tickets) // [] | .[] | select(.key | ascii_upcase == $key)
   | .variations // [] | .[] | select(.["is-deleted"] | not) | .["state-changes"] // [] | .[] | select(.["to-state"] == "split") | .timestamp]
  | max // ""' "$(ticket_file "$command" "$project" "$key")")"
[[ -z "$since" || ! "$at" < "$since" ]] || { echo "$command: $key's split proposal is from before its last move to Split ($at, moved $since)" >&2; exit 1; }
jq -nc --arg t "$key" --arg at "$at" '{ ticket: $t, proposed: true, "proposed-at": $at }'
