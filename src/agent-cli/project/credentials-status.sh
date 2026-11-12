#!/usr/bin/env bash
# Description: Whether a project's work is held by its credentials, and why — project:credentials-status <project> [--fail-when-held]; prints { held, since, problems }.
set -euo pipefail

# ASS-395. Reads data/projects/<project>/credentials-hold.json, which
# project:check-credentials records (control runs it at start and every few
# minutes, src/control/credentials.js), and prints
#   { "held": true, "since": "<UTC>", "problems": [{ credential, problem, fix }, …] }
# or { "held": false, "since": null, "problems": [] } — never a check of its
# own, so it is cheap for a step or an agent to ask (Blocked's Classify: a
# credential cause waits on this hold rather than going to Blocked for Human).
# With --fail-when-held it exits 3 while held, for a script step's exit-code
# condition. PROJECTS_DIR overrides the projects folder. Fails on a bad project.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"
command=project:credentials-status

fail_when_held=0
[[ $# -eq 2 && "$2" == --fail-when-held ]] && { fail_when_held=1; set -- "$1"; }
[[ $# -eq 1 ]] || { echo "usage: $command <project> [--fail-when-held]" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
[[ -f "$projects/$1/project.json" ]] || { echo "$command: no project $1" >&2; exit 1; }

record="$projects/$1/credentials-hold.json"
if [[ -f "$record" ]] && jq -e '(.problems | length) > 0' "$record" >/dev/null 2>&1; then
  jq -c '{ held: true, since: (.since // null), problems }' "$record"
  [[ $fail_when_held -eq 0 ]] || exit 3
else
  jq -cn '{ held: false, since: null, problems: [] }'
fi
