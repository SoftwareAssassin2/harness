#!/usr/bin/env bash
# Description: Print a saved command output from the ticket's work folder as a dark monospace <pre> HTML page, verbatim — work:output-page <project> <ticket-key> <variation> <name>.
set -euo pipefail

# Take Screenshots shoots a ticket with no visible UI from the raw output its
# Test step saved (work:write test-output-<n>.txt, ASS-230): this renders the
# variation's own file (work.bash work_file) byte for byte, only &, < and >
# escaped, so what the screenshot shows is what the command printed — no
# header typed, no line cut. Fails, printing nothing, on a refused name or a
# missing file.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"

command=work:output-page
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <name>" >&2; exit 1; }
file="$(work_file "$command" "$@")"
[[ -f "$file" ]] || { echo "$command: no $(basename "$file") in $2's work folder" >&2; exit 1; }
# [>], not >/: data-writes-lint would read >/ as a redirect.
escaped="$(sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/[>]/\&gt;/g' "$file"; printf .)"
printf '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#1e1e1e;color:#d4d4d4}pre{margin:0;padding:16px;font:14px/1.4 monospace;white-space:pre-wrap}</style><pre>%s</pre>\n' "${escaped%.}"
