#!/usr/bin/env bash
# Description: Switch a project's background work off for a test run, or back on — project:set-background-work <project> <on|off>.
set -euo pipefail

# Writes data/projects/<project>/project.json's background-work: false for off,
# true for on (absent is on; PROJECTS_DIR overrides the projects folder, used
# by tests). Control reads it every tick (ASS-127): while it is off it starts
# none of the project's check-health, check-variation-appeal or
# check-ticket-health runs and holds those already going (moves.js isPaused);
# a sprint ticket's gap resolution and its Blocked step go on. Fails, writing
# nothing, on an unknown project or value.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

command=project:set-background-work
[[ $# -eq 2 ]] || { echo "usage: $command <project> <on|off>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
[[ "$2" == on || "$2" == off ]] || { echo "$command: the value must be on or off, got '$2'" >&2; exit 1; }
update_json "$projects/$1/project.json" --argjson on "$([[ "$2" == on ]] && echo true || echo false)" '.["background-work"] = $on'
echo "$1: background work $2"
