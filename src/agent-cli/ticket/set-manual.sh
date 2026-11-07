#!/usr/bin/env bash
# Description: Mark a ticket as worked by hand, or hand it back to control — ticket:set-manual <project> <ticket-key> on|off [<note>].
set -euo pipefail

# ASS-166: a ticket the operator works by hand (with Claude, outside the
# harness). on writes "worked-manually": { by, since, note } on the ticket —
# so on every variation of it — in the project's active sprint, or its
# backlog.json when the sprint does not list it (sprint.bash backlog_too):
# by is the operator ($USER), since the time now (UTC), note the <note> or
# null. off removes it, handing the ticket back to control where it stands.
# While it is set control leaves the ticket alone (src/control/engine.js
# isManual: no dispatch, no moves, no runs about it, no gap resolution;
# ticket:sync updates its data without holding a requirements change or
# pausing it). It is no pause: is-paused and the pre-emption marks are left
# as they are, and a pause set or cleared leaves it. A move into a done step
# clears it (sprint.bash sync_paired_status). Fails, writing nothing, on
# anything but on or off, a note with off, or an unknown ticket.
backlog_too=1
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

[[ ( $# -eq 3 && ( "$3" == on || "$3" == off ) ) || ( $# -eq 4 && "$3" == on ) ]] || { echo "usage: ticket:set-manual <project> <ticket-key> on|off [<note>]" >&2; exit 1; }

update_whole_ticket ticket:set-manual "$1" "$2" --arg on "$3" --arg by "${USER:-operator}" --arg note "${4:-}" '
  if $on == "on" then .["worked-manually"] = { by: $by, since: $at, note: (if $note == "" then null else $note end) }
  else del(.["worked-manually"]) end'
