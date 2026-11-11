#!/usr/bin/env bash
# Description: Ask the dashboard to open a ticket's screen — notify:open-ticket <project> <ticket-key>; what a click on an Operator Needed notification runs.
set -euo pipefail

# ASS-383: terminal-notifier's -execute runs this when the operator clicks an
# Operator Needed notification. It writes { project, key, at } to
# data/open-ticket-request.json through update_json (json-file.bash: under its
# lock, a temp file renamed into place, so the dashboard never reads half of
# one), replacing any request still there — and the dashboard, which watches it,
# switches to that project and opens the ticket's screen, then removes it.
# Only a project id and ticket key of plain characters are taken: nothing else
# of the ticket ever reaches a shell. OPEN_TICKET_REQUEST_FILE overrides the
# path, used by tests. Fails, writing nothing, on a bad project or key.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
file="${OPEN_TICKET_REQUEST_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/open-ticket-request.json}"

[[ $# -eq 2 ]] || { echo "usage: notify:open-ticket <project> <ticket-key>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "notify:open-ticket: invalid project '$1'" >&2; exit 1; }
[[ "$2" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { echo "notify:open-ticket: invalid ticket key '$2'" >&2; exit 1; }
update_json --create "$file" --arg project "$1" --arg key "$2" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{ project: $project, key: $key, at: $at }'
