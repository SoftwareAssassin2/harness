#!/usr/bin/env bash
# Description: Validate the engines a project sees (or engines/ alone), and (ASS-551) that each machine step its tickets can reach has a run target the project allows — engine:validate <project|-> [<engine>].
set -euo pipefail

# ASS-524: every workflow.yaml the project sees (engines/'s and its own, its
# own over engines/'s of the same name, as control reads them), or the one
# <engine>, checked by src/workflow/validate.js: one line per error,
# "<engine>: <error>", a file that does not parse given as its file, line and
# reason (AC4). ASS-551: for a <project>, then also every machine-using step
# its tickets can reach (from its execution engine, its switched-off steps
# off) that can run on none of its run targets, as control finds them
# (src/control/run-targets.js projectRunTargetProblems): "<engine>: step
# "<id>" can run on none of project <project>'s run targets: <why>"; with
# <engine>, only that engine's. Prints "<n> engines valid" and exits 0 when
# there are none; else exits 1. <project> "-" checks engines/ alone.
# ENGINES_DIR and PROJECTS_DIR override the folders (tests).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../engine.bash"   # engines_dir, engine_projects_dir

[[ $# -ge 1 && $# -le 2 ]] || { echo "usage: engine:validate <project|-> [<engine>]" >&2; exit 1; }
project="$1"
[[ "$project" == - || "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "engine:validate: invalid project '$1'" >&2; exit 1; }
own="" json=""
if [[ "$project" != - ]]; then
  own="$engine_projects_dir/$project/engines" json="$engine_projects_dir/$project/project.json"
  [[ -f "$json" ]] || { echo "engine:validate: no project $project ($json)" >&2; exit 1; }
fi
exec node "$here/validate.js" "$(cd "$here/../../.." && pwd -P)" "$engines_dir" "$own" "${2:-}" "$json"
