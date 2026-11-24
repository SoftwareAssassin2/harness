#!/usr/bin/env bash
# Description: Set how a project's tickets keep apart on a shared workstation or cloud VM (ASS-529): one-at-a-time (the default: test and CI steps one at a time per machine) or separate (each ticket its own COMPOSE_PROJECT_NAME and HARNESS_PORT_OFFSET) — project:set-ticket-isolation <project> one-at-a-time|separate.
set -euo pipefail

# ASS-546 AC3: writes data/projects/<project>/project.json's
# dev-environments.ticket-isolation (PROJECTS_DIR overrides the projects
# folder, used by tests), making dev-environments {} first when the project
# has none (mode vm, as before). The value is written even when it is the
# default, so the file says what was chosen. See
# src/control/dev-environments.js for what each value does. Control rereads
# project.json every tick. project.json.lock is held from the read to the
# write (seat-settings.bash). Prints "<project>: ticket isolation <before> →
# <after>" ("one-at-a-time (default)" for an unset one). Fails, writing
# nothing, on an unknown project, another value, or a dev-environments that is
# not an object.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../seat-settings.bash"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"

command=project:set-ticket-isolation
[[ $# -eq 2 ]] || { echo "usage: $command <project> one-at-a-time|separate" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
[[ "$2" == one-at-a-time || "$2" == separate ]] || { echo "$command: the isolation must be one-at-a-time or separate, got '$2'" >&2; exit 1; }
project="$1" isolation="$2"

ss_lock "$command" "$projects/$project/project.json"
[[ "$(jq -r '."dev-environments" | type' "$file")" =~ ^(null|object)$ ]] || { echo "$command: $project's dev-environments is not an object; nothing written" >&2; exit 1; }
before="$(jq -r '."dev-environments"."ticket-isolation" // "one-at-a-time (default)"' "$file")"
write_json "$file" --arg i "$isolation" '."dev-environments" = ((."dev-environments" // {}) + { "ticket-isolation": $i })'
exec 9>&-
echo "$project: ticket isolation $before → $isolation"
