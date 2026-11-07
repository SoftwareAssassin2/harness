#!/usr/bin/env bash
# Description: Start the requirements-changed workflow for a sprint ticket variation (ASS-79) — ticket:requirements-changed <project> <ticket-key> <variation>.
set -euo pipefail

# The seam ticket:take-new (ASS-78) calls for each live variation whose
# current step is flagged "recheck-on-requirements-change": the ticket's
# description has just been replaced, and the variation's work so far must be
# re-checked against it. The variation leaves the step it is in for its
# engine's requirements-changed (ticket:change-state), a transient workflow
# as Blocked is: it revises the acceptance criteria, judges the work against
# them, and hands the variation back to that step (follow-return-to-state)
# when all pass, else to Root Cause Analysis. A run the variation's old step
# had going is left behind, as on any move by hand. Prints
# "<KEY>.<variation>: requirements-changed from <step>". Fails, writing
# nothing, when the variation is unknown or its engine has no
# requirements-changed step.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:requirements-changed <project> <ticket-key> <variation>" >&2; exit 1; }
IFS=$'\t' read -r engine state < <(variation_status ticket:requirements-changed "$1" "$2" "$3" | head -n 1) || true
[[ -n "${state:-}" ]] || exit 1
[[ -n "$engine" ]] || engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$1/project.json")"
engine_steps_of ticket:requirements-changed "$engine" "$1" | jq -e 'any(.[]; .id == "requirements-changed")' > /dev/null \
  || { echo "ticket:requirements-changed: $engine has no requirements-changed step" >&2; exit 1; }

"$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/change-state.sh" "$1" "$2" "$3" "$state" requirements-changed > /dev/null
echo "$2.$3: requirements-changed from $state"
