#!/usr/bin/env bash
# Description: An engine as JSON, for jq (engines are workflow.yaml) — engine:show <project|-> <engine> [--path].
set -euo pipefail

# ASS-524: engines are YAML (engines/<engine>/workflow.yaml, or a project's
# own under data/projects/<project>/engines/<engine>/, found first for that
# project: engine.bash engine_path), and jq reads only JSON, so this prints
# the engine as JSON, on one line, read by the harness's one loader
# (src/workflow/engine-file.js) — what a jq over the old state-engine.json
# read, e.g. `./agent.sh engine:show <project> <engine> | jq '.steps[].id'`.
# <project> "-" looks only in engines/. --path prints the file's path instead.
# Fails for no such engine, or naming the file, line and reason for a
# workflow.yaml that does not parse. ENGINES_DIR and PROJECTS_DIR override
# the folders (tests).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../engine.bash"

usage() { echo "usage: engine:show <project|-> <engine> [--path]" >&2; exit 1; }
[[ $# -eq 2 || ( $# -eq 3 && "$3" == --path ) ]] || usage
project="$1" engine="$2"
[[ "$project" == - ]] && project=""
[[ -z "$project" || "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "engine:show: invalid project '$1'" >&2; exit 1; }
file="$(engine_file engine:show "$engine" "$project")"
if [[ $# -eq 3 ]]; then echo "$file"; else engine_json "$file"; fi
