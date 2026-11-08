#!/usr/bin/env bash
# Description: Replace a ticket's requirements, keeping its acceptance criteria — ticket:set-requirements <project> <ticket-key> [<file>], the Markdown stdin's or <file>'s.
set -euo pipefail

# Grooming folds a settled answer into an off-board ticket's requirements
# (ASS-180), host-only: stdin — or, given <file> (ASS-298: a confined host
# agent can't pipe or redirect into agent.sh without re-sandboxing it, so it
# stages the body in a file of its own and passes the path, the call a bare
# one), that file — is the Markdown sections after the title, no H1
# and no `## Acceptance criteria` (that is ticket:set-acceptance-criteria -).
# Off-board ticket (its key carries the off-board key prefix, see home_project):
# rewrites the ticket file through off-board.sh ticket:update-requirements
# (keeping the acceptance criteria) and mirrors the harness's description in
# sprint.json/backlog.json with one requirements-history line, all under the
# project's tickets.lock, so the next ticket:sync sees no change (see
# set_offboard_description). Jira ticket: writes nothing and exits 0 saying to
# post the answer as a comment. Fails, writing nothing, on a body with an H1
# or a `## Acceptance criteria` section, a <file> that is no file, an empty
# body, or a key that is neither.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"

command=ticket:set-requirements
[[ $# -eq 2 || $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> [<file>] < markdown" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"

from=stdin
if [[ $# -eq 3 ]]; then
  from="$3"
  [[ -f "$from" ]] || { echo "$command: no file $from: nothing written" >&2; exit 1; }
  exec < "$from"
fi
body="$(cat; echo x)"; body="${body%x}"
[[ -n "$body" ]] || { echo "$command: nothing on $from: nothing written" >&2; exit 1; }
grep -qE '^# ' <<< "$body" && { echo "$command: the body has an H1 line (^# ); the title is kept — send the sections after it, nothing written" >&2; exit 1; } || true
grep -qE '^## Acceptance criteria *$' <<< "$body" && { echo "$command: the body has a '## Acceptance criteria' section; change the criteria with ticket:set-acceptance-criteria $project $2 - instead, nothing written" >&2; exit 1; } || true

home="$(off_board_home "$project")"
prefix=""
if [[ -n "$home" ]]; then prefix="$(off_board_prefix "$command" "$home")"; fi
if [[ -n "$prefix" && "$key" == "$prefix-"* ]]; then
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
  printf '%s' "$body" | replace_file "$tmp"
  lock_tickets "$command" "$home"
  set_offboard_description "$command" "$home" "$key" ticket:update-requirements "$tmp" || { echo "$command: the off-board write failed; nothing written" >&2; exit 1; }
  jq -nc --arg key "$key" '{ key: $key }'
elif [[ "$(ticket_system "$command" "$project")" == jira ]]; then
  echo "$project is a Jira project; nothing written — post the settled answers with ticket:post-comment" >&2
  exit 0
else
  echo "$command: $key is not an off-board ticket" >&2
  exit 1
fi
