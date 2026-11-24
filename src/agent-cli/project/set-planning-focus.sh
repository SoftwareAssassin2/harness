#!/usr/bin/env bash
# Description: Switch a project's focus on planning on or off: control sends seats and agents to tickets at planning steps first — project:set-planning-focus <project> <on|off>.
set -euo pipefail

# ASS-531. Writes data/projects/<project>/planning-focus.json whole — { on, by, at }: on or off, who ($USER) and when
# (UTC) — through update_json, so under its lock and by a temp file renamed over it (PROJECTS_DIR overrides the
# projects folder, used by tests). Not project.json: that is the operator's hand-edited config. Control reads the file
# every tick (src/control/planning-focus-file.js): while on, it ranks every variation at a planning step ahead of every
# other when giving seats and dispatching agents, its usual ranking within each group, nothing running cut off, and
# max-tickets-ready-for-build does not hold planning back; off, ranking is as without the switch. No restart needed
# either way; it survives restarts. The dashboard's sprint screen flips it with P. Fails, writing nothing, on an
# unknown project or value.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

command=project:set-planning-focus
[[ $# -eq 2 ]] || { echo "usage: $command <project> <on|off>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
[[ "$2" == on || "$2" == off ]] || { echo "$command: the value must be on or off, got '$2'" >&2; exit 1; }
update_json --create "$projects/$1/planning-focus.json" --argjson on "$([[ "$2" == on ]] && echo true || echo false)" --arg by "${USER:-operator}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{ on: $on, by: $by, at: $at }'
echo "$1: planning focus $2"
