#!/usr/bin/env bash
# Description: Back up a project's Hindsight memory — memory:backup <project>; control runs it daily.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/transfer.bash"

# The project's bank exported through Hindsight's transfer export into
# hindsight-backups/<project>/<UTC time>.zip (see transfer.bash), then the
# daily backups beyond the last 14 removed, oldest first. Prints
# { project, archive, bytes, removed: [<path>] }. Fails, keeping every backup
# it had, when the project has no Hindsight or it does not answer or export.
[[ $# -eq 1 ]] || { echo "usage: memory:backup <project>" >&2; exit 1; }
memory_config memory:backup "$1"
folder="$backups_root/$1"
archive="$folder/$(utc_stamp).zip"
memory_export memory:backup "$1" "$archive"

removed=()
while IFS= read -r old; do rm -f "$folder/$old"; removed+=("$folder/$old"); done \
  < <(ls "$folder" | grep -E "$backup_name" | sort -r | tail -n "+$(( backups_kept + 1 ))" | sort)
jq -n --arg p "$1" --arg a "$archive" --argjson bytes "$(wc -c <"$archive")" '{ project: $p, archive: $a, bytes: $bytes, removed: $ARGS.positional }' --args ${removed[@]+"${removed[@]}"}
