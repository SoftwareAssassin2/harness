#!/usr/bin/env bash
# Description: Save a screenshot, the PNG on stdin, in the ticket's work folder — work:add-screenshot <project> <ticket-key> <variation> <merge-request-id|-> <name>.png < png.
set -euo pipefail

# Take Screenshots runs in the variation's VM, whose /mnt/ticket is read-only
# (ASS-182), so each image comes here: screenshots/<merge-request-id>/<name>.png
# — one merge request's — or, for "-", screenshots/<name>.png, the ticket's
# own; where Add Screenshots and the review at Human Review (src/tui/review.js)
# read them. <name> is plain, ^[a-z0-9][a-z0-9-]*\.png$; the folder must be in
# the ticket's work folder (work.bash work_path). Written whole, byte for byte,
# through a temp file renamed over it (json-file.bash replace_file). Fails,
# writing nothing, on a refused id or name, or nothing on stdin.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"

command=work:add-screenshot
[[ $# -eq 5 ]] || { echo "usage: $command <project> <ticket-key> <variation> <merge-request-id|-> <name>.png < png" >&2; exit 1; }
[[ "$4" == - || "$4" =~ ^[1-9][0-9]*$ ]] || { echo "$command: invalid merge request id '$4': a positive whole number, or -" >&2; exit 1; }
[[ "$5" =~ ^[a-z0-9][a-z0-9-]*\.png$ ]] || { echo "$command: invalid name '$5': a plain name, ^[a-z0-9][a-z0-9-]*\\.png\$" >&2; exit 1; }
folder="$(work_path "$command" "$1" "$2" "$3" screenshots)"
[[ "$4" == - ]] || folder+="/$4"
mkdir -p "$folder"
replace_file "$folder/$5" || { echo "$command: nothing on stdin (or the write failed): $5 not saved" >&2; exit 1; }
