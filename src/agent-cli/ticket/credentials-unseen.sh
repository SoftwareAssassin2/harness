#!/usr/bin/env bash
# Description: Hand a ticket blocked by a credential the credentials check cannot see to the operator, with Classify's reason — ticket:credentials-unseen <project> <ticket-key> <variation> <run-id>.
set -euo pipefail

# ASS-395 AC5, grouped-blocked's credentials route. Classify said (issue
# "credentials", the Blocked run's structured-output, <run-id>) that a
# missing or failing credential — a keychain item, a token, a login — blocks
# the ticket. Blocked ran a fresh project:check-credentials, and
# project:credentials-status found the project not held: the check cannot see
# this credential, so no hold will stop the project's work until it is fixed
# and nothing will resume the ticket by itself. It goes to Blocked for Human:
# this prints { credentials-held: false, ai-feedback-short, ai-feedback-long }
# — the long one Classify's reasoning and, when it gave one, its human-action
# — logs it in the change log (work.bash blocked_log) and exits 0. Fails (1)
# on bad arguments, a bad variation or an unknown run.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/code.bash"   # upper
source "$here_vm/work.bash"   # blocked_log
assignments="${ASSIGNMENTS_FILE:-$here_vm/../../data/assignments.json}"

command=ticket:credentials-unseen
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <run-id>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" id="$4"
variation_exists "$command" "$project" "$key" "$variation"
found="$(jq -c --arg id "$id" 'first(.["transient-state-engines"] // [] | .[] | select(.id == $id) | .["structured-output"] // {})' "$assignments")"
[[ -n "$found" ]] || { echo "$command: no run $id" >&2; exit 1; }

out="$(jq -c --arg key "$key" '
  (.reasoning // "" | tostring | if . == "" then "no reason given" else rtrimstr(".") end) as $why
  | (.["human-action"] // "" | tostring) as $do
  | { "credentials-held": false,
      "ai-feedback-short": "A credential blocks it that the credentials check cannot see",
      "ai-feedback-long": ("Blocked classified \($key)'"'"'s block as a missing or failing credential: \($why). A fresh credentials check (project:check-credentials) finds nothing missing, so it holds no work until this one is fixed."
        + (if $do == "" then "" else " What to do: \($do)." end) + " Fix the credential, then resolve, or have AI try again.") }' <<< "$found")"
blocked_log "$project" "$key" "$variation" "Check the Credentials" "$(jq -r '.["ai-feedback-long"]' <<< "$out") Handed to the operator."
echo "$out"
