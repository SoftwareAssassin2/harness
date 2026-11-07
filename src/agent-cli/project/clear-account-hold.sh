#!/usr/bin/env bash
# Description: Clear a project's account hold — project:clear-account-hold <project>; control starts its agents again.
set -euo pipefail

# Removes "account-hold" from data/projects/<project>/project.json (see
# project:set-account-hold); nothing to remove is fine. PROJECTS_DIR overrides
# the projects folder, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 1 ]] || { echo "usage: project:clear-account-hold <project>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:clear-account-hold: invalid project '$1'" >&2; exit 1; }

update_json "$projects/$1/project.json" 'del(.["account-hold"])'
