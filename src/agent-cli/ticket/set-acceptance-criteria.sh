#!/usr/bin/env bash
# Description: Replace a ticket's acceptance criteria — ticket:set-acceptance-criteria <project> <ticket-key> <variation> <json-file|-> | <project> <ticket-key> - < json.
set -euo pipefail

# Two forms. The 4-arg form writes the file's array (stdin's for "-", ASS-182:
# how a VM, whose /mnt/ticket is read-only, gives it) as one variation's
# acceptance-criteria in the project's active sprint (see sprint.bash),
# whatever state it is in: each an object with criteria-number (a number) and
# description (a string), given dev-status and testing-status "Incomplete"
# when it has none.
#
# The 3-arg `-` form (ASS-180, host-only) replaces the ticket's own acceptance
# criteria from stdin — the whole [{ criteria-number, description }] list,
# each description a non-empty, single-line string. An off-board ticket (its
# key carries the off-board key prefix): rewrites the `## Acceptance criteria`
# section of the ticket file through off-board.sh ticket:replace-acceptance-criteria
# and mirrors the harness's description with one requirements-history line, all
# under tickets.lock (see set_offboard_description), touching no variation's
# acceptance-criteria. A Jira ticket: writes nothing, exits 0 saying to post a
# comment. Fails, writing nothing, when the file/stdin is not such an array,
# or the ticket or variation is missing.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"

command=ticket:set-acceptance-criteria
usage="usage: $command <project> <ticket-key> <variation> <json-file|-> | <project> <ticket-key> - (JSON on stdin)"

if [[ $# -eq 3 && "${3:-}" == - ]]; then
  project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
  input="$(cat; echo x)"; input="${input%x}"
  printf '%s' "$input" | jq -se 'length == 1 and (.[0] | type == "array" and all(.[]; type == "object"
      and (.["criteria-number"] | type) == "number"
      and (.description | type) == "string" and (.description | test("\\S")) and ((.description | test("\n")) | not)))' >/dev/null 2>&1 \
    || { echo "$command: stdin must be a JSON array of { criteria-number (number), description (non-empty, single-line string) }: nothing written" >&2; exit 1; }

  home="$(off_board_home "$project")"
  prefix=""
  if [[ -n "$home" ]]; then prefix="$(off_board_prefix "$command" "$home")"; fi
  if [[ -n "$prefix" && "$key" == "$prefix-"* ]]; then
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    printf '%s' "$input" | replace_file "$tmp"
    lock_tickets "$command" "$home"
    set_offboard_description "$command" "$home" "$key" ticket:replace-acceptance-criteria "$tmp" || { echo "$command: the off-board write failed; nothing written" >&2; exit 1; }
    jq -nc --arg key "$key" '{ key: $key }'
  elif [[ "$(ticket_system "$command" "$project")" == jira ]]; then
    echo "$project is a Jira project; nothing written — post the settled answers with ticket:post-comment" >&2
    exit 0
  else
    echo "$command: $key is not an off-board ticket" >&2
    exit 1
  fi
  exit 0
fi

[[ $# -eq 4 ]] || { echo "$usage" >&2; exit 1; }
file="$4"; [[ "$file" != - ]] || file=/dev/stdin
[[ "$4" == - || -f "$4" ]] || { echo "$command: no file $4" >&2; exit 1; }
criteria="$(jq -c '
  if type == "array" and all(.[]; type == "object" and (.["criteria-number"] | type) == "number" and (.description | type) == "string")
  then map(. + { "dev-status": (.["dev-status"] // "Incomplete"), "testing-status": (.["testing-status"] // "Incomplete") }) else empty end' "$file" 2>/dev/null || true)"
[[ -n "$criteria" ]] || { echo "$command: $4 must hold an array of { criteria-number, description }" >&2; exit 1; }

update_whole_ticket "$command" "$1" "$2" --arg name "$3" --argjson criteria "$criteria" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | .variations |= map(if .name == $name then .["acceptance-criteria"] = $criteria else . end)'
