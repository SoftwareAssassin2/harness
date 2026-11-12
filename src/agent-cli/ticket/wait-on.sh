#!/usr/bin/env bash
# Description: Record the fix ticket a ticket variation waits on, or - to stop waiting — ticket:wait-on <project> <ticket-key> <variation> <fix-ticket-key|-> [<no-ticket-reason> <no-ticket-why>].
set -euo pipefail

# Writes the variation's "waits-on": { project, ticket } in the project's
# active sprint — the fix ticket and the project its key names (key_project,
# see ticket-system.bash: a harness ticket's prefix names the harness
# project, a Jira key its board's) — for ticket:fix-landed to check. The one
# dependency a product ticket has on the harness. Prints { ticket, variation,
# waits-on }. Fails, writing nothing, on an unknown ticket or variation; and,
# printing why as { ai-feedback-short, ai-feedback-long } for Blocked to
# hand the ticket to a human with (ASS-107 AC7), on a fix key that is the
# ticket's own — no fix ticket was raised: Blocked's run gives a ticket
# step's command its own work item when it has no fix key — (exit 3) or one
# no project claims (exit 1). A fix key of - removes the variation's
# waits-on, for a wait the operator abandons (ASS-253), printing waits-on null.
# ASS-316: on the own-key refusal, optional 5th/6th arguments name why no fix
# ticket was raised — no-ticket-reason (analysis-did-not-hold|create-failed)
# and a one-line why — naming the reason in the feedback; - or an unknown
# reason (no reason given) keeps the generic text. Ignored on every other path.
# ASS-342: beside waits-on it writes the variation's "wait-began": { at, the
# time it began waiting (UTC), inputs, { <name>: SHA-256, or null while
# missing } of each of the variation's own input files in its work folder
# then (work.bash work_inputs: automated-tests-<variation>.json,
# demo-plan-<variation>.json) } — for ticket:fix-landed to tell a fix made by
# re-recording one of them after the wait began; {} when the ticket has no
# work folder. Each wait records it afresh; - removes it with waits-on.
# ASS-390 AC6: `--merge-request <url>` instead of a fix key — Blocked's
# Repair Project's fix merge request ({fix-merge-request}), which must be one
# merge-request:create-fix recorded in the variation's fix-merge-requests —
# writes waits-on { merge-request: <url>, key, repository, branch } and
# wait-began as above, for ticket:fix-landed to read from its forge. None
# named (-) or one not recorded so is refused (exit 1), printing why as {
# ai-feedback-short, ai-feedback-long }. The change log says what it waits on
# (work.bash blocked_log, AC3), for a fix ticket too.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"
source "$here/../work.bash"

if [[ $# -eq 5 && "$4" == --merge-request ]]; then
  why() { jq -nc --arg s "$1" --arg l "$2" '{ "ai-feedback-short": $s, "ai-feedback-long": $l }'; echo "ticket:wait-on: $2" >&2; }
  url="${5%/}" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
  [[ "$url" != - && -n "$url" ]] || { why "No fix merge request to wait on" "Repair Project said it fixed $key's block but named no fix merge request, so there is nothing to wait on."; exit 1; }
  found="$(jq -c --arg key "$key" --arg name "$3" --arg u "$url" '
    first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase))) // {} | .variations // []
    | map(select(.name == $name and (.["is-deleted"] | not))) | first // {} | first(.["fix-merge-requests"] // [] | .[] | select((.url // "" | rtrimstr("/")) == $u)) // empty' \
    "$(sprint_file ticket:wait-on "$1")")"
  [[ -n "$found" ]] || { why "The fix merge request cannot be waited on" "$url is not a fix merge request opened for $key $3 (merge-request:create-fix), so it is not waited on."; exit 1; }
  waits="$(jq -c '{ "merge-request": .url, key, repository, branch }' <<< "$found")"
  inputs="$(work_input_digests ticket:wait-on "$1" "$2" "$3")"
  update_whole_ticket ticket:wait-on "$1" "$2" --arg name "$3" --argjson waits "$waits" --argjson inputs "$inputs" '
    if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
    | .variations |= map(if .name == $name then .["waits-on"] = $waits | .["wait-began"] = { at: $at, inputs: $inputs } else . end)'
  blocked_log "$1" "$key" "$3" "Wait on the Fix Merge Request" "Waits for the fix merge request $(jq -r .key <<< "$found") ($url) to merge, polled every few minutes; it needs a person's review and approval. Nothing else changed."
  jq -nc --arg t "$key" --arg v "$3" --argjson w "$waits" '{ ticket: $t, variation: $v, "waits-on": $w }'
  exit 0
fi

[[ $# -eq 4 || $# -eq 6 ]] || { echo "usage: ticket:wait-on <project> <ticket-key> <variation> <fix-ticket-key|-|--merge-request <url>> [<no-ticket-reason> <no-ticket-why>]" >&2; exit 1; }
fix="$(tr '[:lower:]' '[:upper:]' <<< "$4")"
reason="${5:--}"
no_ticket_why="${6:--}"
has='if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end'
[[ "$fix" != - ]] || {
  update_whole_ticket ticket:wait-on "$1" "$2" --arg name "$3" "$has"' | .variations |= map(if .name == $name then del(.["waits-on"], .["wait-began"]) else . end)'
  jq -nc --arg t "$(tr '[:lower:]' '[:upper:]' <<< "$2")" --arg v "$3" '{ ticket: $t, variation: $v, "waits-on": null }'
  exit 0; }
why() { jq -nc --arg s "$1" --arg l "$2" '{ "ai-feedback-short": $s, "ai-feedback-long": $l }'; echo "ticket:wait-on: $2" >&2; }
if [[ "$fix" == "$(tr '[:lower:]' '[:upper:]' <<< "$2")" ]]; then
  case "$reason" in
    analysis-did-not-hold) why "No fix ticket: the analysis did not hold" "No fix ticket: the analysis did not hold - $no_ticket_why";;
    create-failed) why "No fix ticket: ticket:create failed" "No fix ticket: ticket:create failed - $no_ticket_why";;
    *) why "No fix ticket was raised" "No fix ticket was raised for $fix's block (the analysis did not hold, or creating it failed); it does not resume as if fixed.";;
  esac
  exit 3
fi
home="$(key_project ticket:wait-on "$fix")"
[[ -n "$home" ]] || { why "The fix ticket cannot be waited on" "$fix names no project, so $2 cannot wait on it."; exit 1; }
waits="$(jq -nc --arg p "$home" --arg t "$fix" '{ project: $p, ticket: $t }')"
inputs="$(work_input_digests ticket:wait-on "$1" "$2" "$3")"
update_whole_ticket ticket:wait-on "$1" "$2" --arg name "$3" --argjson waits "$waits" --argjson inputs "$inputs" "$has"' | .variations |= map(if .name == $name then .["waits-on"] = $waits | .["wait-began"] = { at: $at, inputs: $inputs } else . end)'
blocked_log "$1" "$(tr '[:lower:]' '[:upper:]' <<< "$2")" "$3" "Wait on the Fix" "Waits for the fix ticket $fix (project $home) to land. Nothing else changed."
jq -nc --arg t "$(tr '[:lower:]' '[:upper:]' <<< "$2")" --arg v "$3" --argjson w "$waits" '{ ticket: $t, variation: $v, "waits-on": $w }'
