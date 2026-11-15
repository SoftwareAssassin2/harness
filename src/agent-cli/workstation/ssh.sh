#!/usr/bin/env bash
# Description: Run a command on a project's GCP workstation over its open SSH connection — workstation:ssh <project> <id> [--] [<argv…>]; its stdin, output and exit code passed through.
set -euo pipefail

# ASS-433: a session over the workstation's one connection (workstation:
# connect), as workstation.bash workstation_ssh runs it for every command run
# there (ASS-434's setup, ASS-435's machine backend): argv quoted for the
# workstation's shell, run in the user's home; a login shell without argv.
# Never opens a connection of its own (each would need a live Google token):
# fails with 255, saying to connect first, when none is open.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../workstation.bash"

command=workstation:ssh
[[ $# -ge 2 ]] || { echo "usage: $command <project> <id> [--] [<argv…>]" >&2; exit 1; }
project="$1" id="$2"; shift 2
[[ "${1-}" != -- ]] || shift
workstation_settings "$command" "$project" "$id" >/dev/null
workstation_alive "$project" "$id" || { echo "$command: $project's workstation $id has no open connection: workstation:connect $project $id first" >&2; exit 255; }
workstation_ssh "$project" "$id" "$@"
