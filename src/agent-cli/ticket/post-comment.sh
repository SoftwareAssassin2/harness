#!/usr/bin/env bash
# Description: Post a file, or stdin ("-"), as a comment on a ticket in its ticket system — ticket:post-comment <project> <ticket-key> <file|->.
set -euo pipefail

# For a Jira project (see ticket-system.bash), `acli jira workitem comment
# create --key <KEY> --body-file <file>`; nothing is written locally, and for
# any other project nothing is posted. "-" takes the comment on stdin (ASS-182:
# how a VM, whose /mnt/ticket is read-only, gives it). Fails when the file is
# missing or stdin empty.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../ticket-system.bash"
source "$here/../json-file.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:post-comment <project> <ticket-key> <file|->" >&2; exit 1; }
body="$3"
if [[ "$body" == - ]]; then
  body="$(mktemp)"; trap 'rm -f "$body"' EXIT
  replace_file "$body" || { echo "ticket:post-comment: nothing on stdin" >&2; exit 1; }
fi
[[ -f "$body" ]] || { echo "ticket:post-comment: no file $body" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"

if [[ "$(ticket_system ticket:post-comment "$1")" == jira ]]; then
  acli_run ticket:post-comment jira workitem comment create --key "$key" --body-file "$body"
else
  echo "ticket:post-comment: $1 has no Jira; nothing posted" >&2
fi
