#!/usr/bin/env bash
# Description: Set a ticket's status in its ticket system — ticket:set-ticket-system-status <project> <ticket-key> <status> [--dry-run].
set -euo pipefail

# Writes ticket-system-status on the whole ticket in the project's active
# sprint (see sprint.bash), with when it was set (ticket-system-status-at, UTC
# to the second: ticket:sync keeps a status set after its list was read,
# ASS-128), then: an off-board ticket (its key carries the
# project's off-board key prefix, see ticket-system.bash) has its file's status
# set with `off-board.sh ticket:update-status`; else, for a Jira project,
# the issue is transitioned with `acli jira workitem transition --key <KEY>
# --status <status>`. With --dry-run nothing is written or run: what would be
# is printed. Fails, writing nothing, when the ticket is missing from the
# sprint.
#
# ASS-576: the Jira transition runs first, and only a transition acli made
# sets ticket-system-status: acli can exit 0 on a transition it refused
# (`✗ Failure: … unauthorized`), so a non-zero exit or acli's failure marker
# (acli_failed, ticket-system.bash) is a failure. Then the status is left as it
# was, the transition recorded on the ticket as pending-ticket-system-status
# { status, from (the status now), at, error (acli's message) }, acli's message
# said on stderr, and the command exits 1; control retries it (transition-retry.js).
# A transition made drops any pending one.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"

usage() { echo "usage: ticket:set-ticket-system-status <project> <ticket-key> <status> [--dry-run]" >&2; exit 1; }
[[ $# -eq 3 || ( $# -eq 4 && "$4" == --dry-run ) ]] || usage
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" status="$3"
system="$(ticket_system ticket:set-ticket-system-status "$project")"
prefix="$(off_board_prefix ticket:set-ticket-system-status "$project")"
# An off-board ticket (the project's off-board key prefix) lives in the harness: its file takes the status, Jira is never asked.
off_board=0; [[ -n "$prefix" && "$key" == "$prefix-"* ]] && off_board=1

if [[ $# -eq 4 ]]; then
  echo "ticket:set-ticket-system-status: would set ticket-system-status of $key to \"$status\" in $project's active sprint"
  if [[ $off_board -eq 1 ]]; then echo "ticket:set-ticket-system-status: would run: off-board.sh ticket:update-status $project $key \"$status\""
  elif [[ "$system" == jira ]]; then echo "ticket:set-ticket-system-status: would run: acli jira workitem transition --key $key --status \"$status\""; fi
  exit 0
fi

if [[ $off_board -eq 0 && "$system" == jira ]]; then
  code=0; out="$(acli_run ticket:set-ticket-system-status jira workitem transition --key "$key" --status "$status" 2>&1)" || code=$?
  [[ -z "$out" ]] || echo "$out" >&2
  if acli_failed "$code" "$out"; then
    update_whole_ticket ticket:set-ticket-system-status "$project" "$key" --arg status "$status" --arg error "$out" \
      '.["pending-ticket-system-status"] = { status: $status, from: (.["ticket-system-status"] // null), at: $at, error: $error }'
    echo "ticket:set-ticket-system-status: $key not transitioned to \"$status\" (pending)" >&2
    exit 1
  fi
fi
update_whole_ticket ticket:set-ticket-system-status "$project" "$key" --arg status "$status" '.["ticket-system-status"] = $status | .["ticket-system-status-at"] = $at | del(.["pending-ticket-system-status"])'
if [[ $off_board -eq 1 ]]; then off_board_run ticket:set-ticket-system-status ticket:update-status "$project" "$key" "$status" >/dev/null; fi
