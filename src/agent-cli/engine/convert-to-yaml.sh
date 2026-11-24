#!/usr/bin/env bash
# Description: The one-off migration of state-engine.json engines to workflow.yaml — engine:convert-to-yaml [--dry-run] [--project <project> | --all].
set -euo pipefail

# ASS-524: each <name>/state-engine.json in the engines folders chosen is
# written as the workflow.yaml beside it, holding the same engine (it is read
# back and compared, key order included, before anything is written), and the
# JSON is removed (src/workflow/engine-file.js convertEngines). Without
# options: the shared engines/; --project <project>: that project's own,
# data/projects/<project>/engines/; --all: engines/ and every project's own.
# --dry-run only says what would happen. It is idempotent: an engine already
# converted is "already"; a JSON beside a workflow.yaml holding the same engine
# is removed; a workflow.yaml that differs from the JSON beside it is an
# error, both left as they are. Prints "<status> <folder>[: <detail>]" per
# engine (converted, would-convert, removed-json, already, error) and fails
# when any is an error, the others converted all the same. Control reads the
# converted engines on its next tick, as it rereads any changed engine.
# ENGINES_DIR and PROJECTS_DIR override the folders (tests).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../engine.bash"   # engines_dir, engine_projects_dir, engine_cli

usage() { echo "usage: engine:convert-to-yaml [--dry-run] [--project <project> | --all]" >&2; exit 1; }
dry=() dirs=() scope=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry=(--dry-run); shift ;;
    --project) [[ $# -ge 2 && -z "$scope" ]] || usage; scope=project
      [[ "$2" =~ ^[A-Za-z0-9_-]+$ && -d "$engine_projects_dir/$2" ]] || { echo "engine:convert-to-yaml: no project $2" >&2; exit 1; }
      dirs+=("$engine_projects_dir/$2/engines"); shift 2 ;;
    --all) [[ -z "$scope" ]] || usage; scope=all
      dirs+=("$engines_dir")
      for d in "$engine_projects_dir"/*/; do [[ -d "$d" ]] && dirs+=("${d%/}/engines"); done
      shift ;;
    *) usage ;;
  esac
done
[[ -n "$scope" ]] || dirs=("$engines_dir")
node "$engine_cli" convert ${dry[@]+"${dry[@]}"} "${dirs[@]}"
