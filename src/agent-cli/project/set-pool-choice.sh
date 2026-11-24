#!/usr/bin/env bash
# Description: Set how a project's steps pick among their run targets (ASS-553): first (the first with a free seat, in list order), most-room (the most headroom now, by measured memory and CPU) or remote-first (the remote machines first, the most headroom among them, the Mac last; the default for worktree targets) — project:set-pool-choice <project> first|most-room|remote-first.
set -euo pipefail

# Writes data/projects/<project>/project.json's dev-environments.pool-choice
# (PROJECTS_DIR overrides the projects folder, used by tests), making
# dev-environments {} first when the project has none. A step's own
# `pool-choice:` in its workflow.yaml wins over it. See src/control/pool-choice.js
# for how headroom is counted, and src/control/run-targets.js poolChoiceOf.
# Control rereads project.json every tick. project.json.lock is held from the
# read to the write (seat-settings.bash). Prints "<project>: pool choice
# <before> → <after>" ("first (default)" for an unset one; the default is remote-first for a step whose candidates include a worktree target). Fails, writing
# nothing, on an unknown project, another value, or a dev-environments that is
# not an object.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../seat-settings.bash"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"

command=project:set-pool-choice
[[ $# -eq 2 ]] || { echo "usage: $command <project> first|most-room|remote-first" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
[[ "$2" == first || "$2" == most-room || "$2" == remote-first ]] || { echo "$command: the pool choice must be first, most-room or remote-first, got '$2'" >&2; exit 1; }
project="$1" choice="$2"

ss_lock "$command" "$projects/$project/project.json"
[[ "$(jq -r '."dev-environments" | type' "$file")" =~ ^(null|object)$ ]] || { echo "$command: $project's dev-environments is not an object; nothing written" >&2; exit 1; }
before="$(jq -r '."dev-environments"."pool-choice" // "first (default)"' "$file")"
write_json "$file" --arg c "$choice" '."dev-environments" = ((."dev-environments" // {}) + { "pool-choice": $c })'
exec 9>&-
echo "$project: pool choice $before → $choice"
