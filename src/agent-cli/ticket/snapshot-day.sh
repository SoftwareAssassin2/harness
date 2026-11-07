#!/usr/bin/env bash
# Description: Keep a day's last sprint.json as a snapshot — ticket:snapshot-day <project> <YYYY-MM-DD>.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# Copies the project's active sprint file (data/projects/<project>/sprints/
# sprint-<n>/sprint.json, <n> the is-active entry of sprints.json; PROJECTS_DIR
# overrides the projects folder, used by tests) to sprints/days/<date>.json,
# making the folder. The downloader calls it with the date of the previous
# day's last download (its UTC day, ASS-294), before the first download of a new day, so the
# snapshot is the day's final data. A copy, not a locked edit: the file is
# only read, and a writer replaces it atomically (see json-file.bash), so the
# copy is always a whole file; it is written beside the snapshot and renamed
# into place (replace_file), so a reader never sees half of it. Exit 2, copying nothing, when that day
# is already kept; 1 on a bad date, project or sprint.
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 2 ]] || { echo "usage: ticket:snapshot-day <project> <YYYY-MM-DD>" >&2; exit 1; }
# The project and the date become path segments, so neither may climb out of the projects folder.
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:snapshot-day: invalid project '$1'" >&2; exit 1; }
[[ "$2" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "ticket:snapshot-day: the date must be YYYY-MM-DD, not '$2'" >&2; exit 1; }

number="$(jq -r 'first(.list[] | select(.["is-active"]) | .number) // empty' "$projects/$1/sprints.json")"
[[ -n "$number" ]] || { echo "ticket:snapshot-day: project '$1' has no active sprint" >&2; exit 1; }
sprint="$projects/$1/sprints/sprint-$number/sprint.json"
[[ -f "$sprint" ]] || { echo "ticket:snapshot-day: no file '$sprint'" >&2; exit 1; }

day="$projects/$1/sprints/days/$2.json"
[[ ! -e "$day" ]] || { echo "ticket:snapshot-day: $day already exists" >&2; exit 2; }
mkdir -p "$(dirname "$day")"
replace_file "$day" < "$sprint"
echo "snapshot $day"
