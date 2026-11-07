#!/usr/bin/env bash
# Description: Print an off-board ticket as JSON — ticket:get <project> <key>.
set -euo pipefail

# Prints { key, type, status, title, created, updated, file, description,
# "depends-on", "overlaps-with", acceptance-criteria } (see ticket.bash):
# description is everything after the H1 line, trimmed; "depends-on" is
# always [] or the ticket's dependency keys (ticket:set-dependencies);
# "overlaps-with" is always [] or the ticket's overlap keys
# (ticket:set-overlaps, ASS-196); acceptance-criteria the numbered list
# under `## Acceptance criteria`, each { criteria-number, description }.
# "kept-whole": true and "split-into" (ASS-252) appear only on a ticket kept
# whole (ticket:keep-whole) or split into others (ticket:mark-split).
# The key matches in any case. Fails when the project is missing or has
# no off-board work source, the ticket is missing, or its file is malformed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 2 ]] || { echo "usage: ticket:get <project> <key>" >&2; exit 1; }
file="$(ticket_file ticket:get "$1" "$2")"
ticket_json ticket:get "$file"
