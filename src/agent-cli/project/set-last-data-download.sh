#!/usr/bin/env bash
# Description: Record when the downloader last pulled a project's data — project:set-last-data-download <project> <iso-time>.
set -euo pipefail

# Writes the time, and nothing else, to data/projects/<project>/last-data-download
# (PROJECTS_DIR overrides the projects folder, used by tests). The downloader calls it at
# the end of each cycle; the next cycle compares it with the day to decide
# whether to snapshot the sprint (ticket:snapshot-day). Fails, writing
# nothing, unless the time is ISO 8601 UTC (YYYY-MM-DDTHH:MM:SS[.fff]Z) and
# the project has a project.json.
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 2 ]] || { echo "usage: project:set-last-data-download <project> <iso-time>" >&2; exit 1; }
# The project becomes a path segment, so it may not climb out of the projects folder.
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:set-last-data-download: invalid project '$1'" >&2; exit 1; }
[[ "$2" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] || { echo "project:set-last-data-download: the time must be ISO 8601 UTC, like 2026-10-11T03:04:05Z" >&2; exit 1; }

[[ -f "$projects/$1/project.json" ]] || { echo "project:set-last-data-download: no project $1" >&2; exit 1; }

# Written beside and renamed over, so a reader never sees half of it.
file="$projects/$1/last-data-download"
printf '%s' "$2" > "$file.$$" && mv -f "$file.$$" "$file"
