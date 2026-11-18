#!/usr/bin/env bash
# Description: Print as JSON every ticket waiting on the operator — the dashboard's Operator Needed set, each { key, title, variation, step, reason, choices }: an open blocking question's where and index for question:answer, each choice's agent.sh argv — for each project or the one named — ticket:operator-needed [<project>].
set -euo pipefail

# ASS-506. The operator's Claude session walks the operator through these one
# at a time, without the dashboard. operator-needed.js loads the projects as
# the dashboard does (src/tui/load.js) and asks the dashboard's own
# neededTickets (src/notify/detect.js: operatorNeeded on each live sprint,
# reasonOf for why), so the two never disagree. Read-only: it writes nothing —
# not data/operator-needed-seen.json, the notifier's — and needs no harness
# running. Fails on a bad or unknown project.
# PROJECTS_DIR, ASSIGNMENTS_FILE and ENGINES_DIR override the paths, used by tests.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"
assignments="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"
engines="${ENGINES_DIR:-$here/../../../engines}"

[[ $# -le 1 ]] || { echo "usage: ticket:operator-needed [<project>]" >&2; exit 1; }
if [[ $# -eq 1 ]]; then
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:operator-needed: invalid project '$1'" >&2; exit 1; }
  [[ -f "$projects/$1/project.json" ]] || { echo "ticket:operator-needed: no project $1" >&2; exit 1; }
fi
exec node "$here/operator-needed.js" "$projects" "$assignments" "$engines" "$@"
