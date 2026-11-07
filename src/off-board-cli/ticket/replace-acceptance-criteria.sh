#!/usr/bin/env bash
# Description: Replace an off-board ticket's whole acceptance criteria list from a file — ticket:replace-acceptance-criteria <project> <key> <json-file>.
set -euo pipefail

# Replaces the numbered list under `## Acceptance criteria` in the ticket's
# file (see ticket.bash) with the file's list, `<criteria-number>.
# <description>` a line, creating the section at the end when it is missing
# (as ticket:add-acceptance-criteria does). The file must hold a JSON array of
# { criteria-number (number), description (a non-empty, single-line string) }.
# Stamps updated. Prints { key }. Fails, writing nothing, when the project is
# missing or has no off-board work source, the ticket or the file is missing,
# or the file is malformed.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:replace-acceptance-criteria <project> <key> <json-file>" >&2; exit 1; }
[[ -f "$3" ]] || { echo "ticket:replace-acceptance-criteria: no file $3" >&2; exit 1; }
file="$(ticket_file ticket:replace-acceptance-criteria "$1" "$2")"
lines="$(jq -c '
  if type == "array" and all(.[]; type == "object"
      and (.["criteria-number"] | type) == "number"
      and (.description | type) == "string" and (.description | test("\\S")) and ((.description | test("\n")) | not))
  then [.[] | "\(.["criteria-number"]). \(.description)"] else empty end' "$3" 2>/dev/null || true)"
[[ -n "$lines" ]] || { echo "ticket:replace-acceptance-criteria: $3 must hold an array of { criteria-number (number), description (non-empty, single-line string) }" >&2; exit 1; }

rewrite_ticket ticket:replace-acceptance-criteria "$file" --argjson lines "$lines" '
  ac_start as $s
  | if $s < 0 then strip_blank + ["", "## Acceptance criteria", ""] + $lines
    else next_heading($s + 1) as $e | .[:$s] + ["## Acceptance criteria", ""] + $lines + [""] + .[$e:] end'
jq -n --arg key "$(ticket_key "$file")" '{ key: $key }'
