#!/usr/bin/env bash
# Description: Hold a project's gates on human steps with no human choice for the operator, or approve them automatically — project:set-hold-gates-with-no-human-choice <project> <on|off>.
set -euo pipefail

# Writes data/projects/<project>/project.json's hold-gates-with-no-human-choice:
# true for on, false for off (absent is off; PROJECTS_DIR overrides the
# projects folder, used by tests). Control reads it when a human step passes
# by itself with nothing to choose (its has-variations false exit, the
# ticket's one variation) while the variation gates leaving it (ASS-220,
# moves.js NO_CHOICE): off, the gate is approved automatically; on, the move
# is held at the gate for the operator's Approve. Fails, writing nothing, on
# an unknown project or value.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

command=project:set-hold-gates-with-no-human-choice
[[ $# -eq 2 ]] || { echo "usage: $command <project> <on|off>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
[[ "$2" == on || "$2" == off ]] || { echo "$command: the value must be on or off, got '$2'" >&2; exit 1; }
update_json "$projects/$1/project.json" --argjson on "$([[ "$2" == on ]] && echo true || echo false)" '.["hold-gates-with-no-human-choice"] = $on'
echo "$1: hold gates with no human choice $2"
