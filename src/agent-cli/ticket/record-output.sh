#!/usr/bin/env bash
# Description: Keep what a step's run returned on the ticket variation — ticket:record-output <project> <ticket-key> <variation> <field> <json-object> [append].
set -euo pipefail

# Merges the object into the variation's <field> (an object; made when
# missing) in the project's active sprint (see sprint.bash), with "timestamp"
# (UTC, now) — so the verdict of a sub-engine such as local testing
# ({ is-approved, summary }) stays with the ticket (control calls it for a
# step with record-output-as). Given append, the object with its timestamp
# is added to the end of <field>, a list (made when missing; ASS-107:
# Blocked's runs, kept for the next stay to learn from, for a step with
# append-output-to). Fails, writing nothing,
# unless the JSON is an object, or when the ticket or variation is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ $# -eq 5 || ( $# -eq 6 && "$6" == append ) ]] || { echo "usage: ticket:record-output <project> <ticket-key> <variation> <field> <json-object> [append]" >&2; exit 1; }
[[ "$4" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:record-output: the field must be one word, like local-testing" >&2; exit 1; }
jq -e 'type == "object"' <<< "$5" >/dev/null 2>&1 || { echo "ticket:record-output: the output must be a JSON object" >&2; exit 1; }

update_whole_ticket ticket:record-output "$1" "$2" --arg name "$3" --arg field "$4" --argjson output "$5" --argjson append "$([[ $# -eq 6 ]] && echo true || echo false)" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | .variations |= map(if .name != $name then .
      elif $append then .[$field] = ((.[$field] // [] | if type == "array" then . else [] end) + [$output + { timestamp: $at }])
      else .[$field] = ((.[$field] // {} | if type == "object" then . else {} end) + $output + { timestamp: $at }) end)'
