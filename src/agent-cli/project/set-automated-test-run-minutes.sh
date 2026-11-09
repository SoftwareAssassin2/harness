#!/usr/bin/env bash
# Description: Set the time limit on each test command run by a project's automated testing — project:set-automated-test-run-minutes <project> <minutes|none>.
set -euo pipefail

# Writes data/projects/<project>/project.json's automated-test-run-minutes:
# the minutes (above 0, a fraction too), or null for none (PROJECTS_DIR
# overrides the projects folder, used by tests). Absent is 30.
# automated-tests:verify-success reads it each run (ASS-329, run_minutes in
# automated-tests.bash): each run of a ticket's test command — on its branch,
# on master, the re-run — is stopped once it passes the limit, with
# everything it started, in the VM or dev container too, and counts as a
# failed run, its results saying "timed out after N minutes".
# Fails, writing nothing, on an unknown project or value.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

command=project:set-automated-test-run-minutes
[[ $# -eq 2 ]] || { echo "usage: $command <project> <minutes|none>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
[[ "$2" == none ]] || { [[ "$2" =~ ^[0-9]+(\.[0-9]+)?$ ]] && awk -v m="$2" 'BEGIN { exit !(m > 0) }'; } \
  || { echo "$command: the limit must be a number of minutes above 0, or none, got '$2'" >&2; exit 1; }
update_json "$projects/$1/project.json" --argjson minutes "$([[ "$2" == none ]] && echo null || echo "$2")" '.["automated-test-run-minutes"] = $minutes'
[[ "$2" == none ]] && echo "$1: test command runs never time out" || echo "$1: each test command run stopped after $2 minutes"
