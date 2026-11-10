#!/usr/bin/env bash
# Description: Switch a project's wait-for-dependencies on or off — project:set-wait-for-dependencies <project> <on|off>.
set -euo pipefail

# Writes data/projects/<project>/project.json's wait-for-dependencies: true for
# on, false for off (absent is off; PROJECTS_DIR overrides the projects folder,
# used by tests). Control reads it every tick (ASS-195, dependencies.js holdOf):
# while it is on, a sprint variation whose ticket depends on a ticket that is
# not done — in the sprint, the backlog, another project or the downloader's
# outside-tickets.json — is held at its step, any but a done or a person's one,
# with no slot, seat or running VM (ASS-355; ASS-195 held at Committed alone);
# the dashboard shows it too. Fails, writing nothing, on an unknown project or value.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

command=project:set-wait-for-dependencies
usage() { echo "usage: $command <project> <on|off>" >&2; exit 1; }
[[ $# -eq 2 ]] || usage
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; usage; }
[[ "$2" == on || "$2" == off ]] || { echo "$command: the value must be on or off, got '$2'" >&2; usage; }
on="$([[ "$2" == on ]] && echo true || echo false)"
update_json "$projects/$1/project.json" --argjson on "$on" '.["wait-for-dependencies"] = $on'
jq -nc --arg project "$1" --argjson on "$on" '{ project: $project, "wait-for-dependencies": $on }'
