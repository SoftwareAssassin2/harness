#!/usr/bin/env bash
# Description: Record the account id the downloader is signed in to the ticket system as — project:set-ticket-system-account-id <project> <account-id>.
set -euo pipefail

# Writes the account id, and nothing else (no newline), to
# data/projects/<project>/ticket-system-account-id (PROJECTS_DIR overrides
# the projects folder, used by tests). The downloader calls it once a cycle,
# before its syncs, when acli's signed-in Jira account differs from the one
# recorded (ASS-344). A ticket's ticket-system-assignment-id (ticket:sync) is
# the same kind of id, so whether a ticket is still the signed-in user's is
# that file's content == its ticket-system-assignment-id, nothing fetched.
# No file: no Jira account recorded yet. Fails, writing nothing, unless the
# id is an Atlassian account id (letters, digits, colons, dashes and
# underscores, at most 128) and the project has a project.json.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 2 ]] || { echo "usage: project:set-ticket-system-account-id <project> <account-id>" >&2; exit 1; }
# The project becomes a path segment, so it may not climb out of the projects folder.
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:set-ticket-system-account-id: invalid project '$1'" >&2; exit 1; }
[[ "$2" =~ ^[A-Za-z0-9:_-]{1,128}$ ]] || { echo "project:set-ticket-system-account-id: not an account id: '$2'" >&2; exit 1; }

[[ -f "$projects/$1/project.json" ]] || { echo "project:set-ticket-system-account-id: no project $1" >&2; exit 1; }

# Written beside and renamed over, so a reader never sees half of it.
printf '%s' "$2" | replace_file "$projects/$1/ticket-system-account-id"
