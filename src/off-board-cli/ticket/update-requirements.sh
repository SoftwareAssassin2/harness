#!/usr/bin/env bash
# Description: Replace an off-board ticket's requirements, keeping its acceptance criteria — ticket:update-requirements <project> <key> <body-file>.
set -euo pipefail

# Replaces every section after the H1 title of the ticket's file (see
# ticket.bash) with the body file's Markdown, except `## Acceptance criteria`:
# that section is kept as it was, as the last section, and one in the body
# file is dropped. Stamps updated. Prints { key }. Fails, writing nothing,
# when the project is missing or has no off-board work source, the ticket or
# the body file is missing, or the ticket's file is malformed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:update-requirements <project> <key> <body-file>" >&2; exit 1; }
[[ -f "$3" ]] || { echo "ticket:update-requirements: no file $3" >&2; exit 1; }
file="$(ticket_file ticket:update-requirements "$1" "$2")"

rewrite_ticket ticket:update-requirements "$file" --rawfile body "$3" '
  (ac_start as $s | if $s < 0 then [] else .[$s:next_heading($s + 1)] end) as $kept
  | ($body | lines | ac_start as $s | if $s < 0 then . else .[:$s] + .[next_heading($s + 1):] end | strip_blank) as $new
  | .[:h1 + 1] + (if $new == [] then [] else [""] + $new end) + (if $kept == [] then [] else [""] + $kept end)'
jq -n --arg key "$(ticket_key "$file")" '{ key: $key }'
