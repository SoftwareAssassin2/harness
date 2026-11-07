#!/usr/bin/env bash
# Description: Set the states a ticket variation is gated on leaving — ticket:set-gate-when-leaving-state <project> <ticket-key> <variation> [<engine>/<state>…].
set -euo pipefail

# Writes the variation's "gate-when-leaving-state" in the project's active
# sprint (see sprint.bash): the states given, in order — none clears it to [].
# Each is named <engine>/<state> (ASS-67), at every level: a step of the
# project's execution state engine or of any engine it reaches through its
# state-engine steps (connected_engines, engine.bash). At each, once its work
# there is done, it waits for a human to approve the move on — except a
# timer script step's (a poll), which no gate holds (ASS-236: an approval
# would replay a stale poll's move hours late). Whatever state the variation is in. Fails, writing nothing, on a state none of those
# engines has, or an unknown ticket or variation.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -ge 3 ]] || { echo "usage: ticket:set-gate-when-leaving-state <project> <ticket-key> <variation> [<engine>/<state>…]" >&2; exit 1; }

[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:set-gate-when-leaving-state: invalid project '$1'" >&2; exit 1; }
engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$1/project.json" 2>/dev/null || true)"
known=""
if [[ -n "$engine" ]]; then
  for name in "$engine" $(connected_engines "$engine" "$1"); do
    known+="$(engine_steps_of ticket:set-gate-when-leaving-state "$name" "$1" 2>/dev/null | jq -r --arg name "$name" '.[] | "\($name)/\(.id)"' || true)"$'\n'
  done
fi
for state in "${@:4}"; do
  grep -qxF -- "$state" <<<"$known" ||
    { echo "ticket:set-gate-when-leaving-state: no state $state in the project's state engines" >&2; exit 1; }
done

gates="$(jq -nc '$ARGS.positional' --args "${@:4}")"
update_whole_ticket ticket:set-gate-when-leaving-state "$1" "$2" --arg name "$3" --argjson gates "$gates" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | .variations |= map(if .name == $name then .["gate-when-leaving-state"] = $gates else . end)'
