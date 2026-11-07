#!/usr/bin/env bash
# Description: List a project's off-board tickets as JSON — ticket:list <project>.
set -euo pipefail

# Prints an array of every ticket in the project's folder as ticket:get
# prints it (see ticket.bash), in key-number order; [] when the folder is
# empty or missing. A malformed file is skipped with a warning on stderr.
# Fails when the project is missing or has no off-board work source.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"

[[ $# -eq 1 ]] || { echo "usage: ticket:list <project>" >&2; exit 1; }
folder="$(ticket_folder ticket:list "$1")"

while read -r file; do
  ticket_json ticket:list "$file" || echo "ticket:list: skipping $file" >&2
done < <(ticket_files "$folder") | jq -s '.'
