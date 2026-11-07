#!/usr/bin/env bash
# Description: Record the Claude account an agent runs on — assignments:set-account <agent-name> <email|-> <org|-> <subscription|-> [subscription|api].
set -euo pipefail

# Writes account { email, org, subscription } (null for -) on the agent's
# assignment in assignments.json (in data/), as control reads it from
# claude auth status when it starts the agent (ASS-25), and, given, the
# payment-method control chose for it (ASS-217: subscription or api), which
# assignments:remove carries onto its dispatch. Fails, writing nothing, when
# the agent has no assignment or the payment method is neither.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# ASSIGNMENTS_FILE overrides the path, used by tests.
file="${ASSIGNMENTS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/assignments.json}"

[[ $# -eq 4 || $# -eq 5 ]] || { echo "usage: assignments:set-account <agent-name> <email|-> <org|-> <subscription|-> [subscription|api]" >&2; exit 1; }
[[ $# -eq 4 || "$5" == subscription || "$5" == api ]] || { echo "assignments:set-account: the payment method must be subscription or api, got '$5'" >&2; exit 1; }

update_json "$file" --arg name "$1" --arg email "$2" --arg org "$3" --arg subscription "$4" --arg payment "${5:-}" '
  def given: if . == "-" then null else . end;
  if any(.assignments[]; .["agent-name"] == $name) then . else error("assignments:set-account: no assignment for \($name)") end
  | .assignments |= map(if .["agent-name"] == $name then
      .account = { email: ($email | given), org: ($org | given), subscription: ($subscription | given) }
      | if $payment == "" then . else .["payment-method"] = $payment end
    else . end)'
