#!/usr/bin/env bash
# Description: End a run of a state engine — transient-state-engine:remove <id>.
set -euo pipefail

# Removes the run from assignments.json's transient-state-engines (at the repo
# root) and prints it. A root run (no run for a parent) takes its folder with
# it — data/projects/<project>/work/run-<id>, what its chain's work without a
# ticket left that no ticket adopted (see ticket:adopt-run-folder) — so nothing
# stray stays. Fails, writing nothing, when there is no such run.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../json-file.bash"
file="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"

[[ $# -eq 1 ]] || { echo "usage: transient-state-engine:remove <id>" >&2; exit 1; }
record="$(jq -c --arg id "$1" 'first(.["transient-state-engines"][]? | select(.id == $id)) // empty' "$file")"
[[ -n "$record" ]] || { echo "transient-state-engine:remove: no transient state engine $1" >&2; exit 1; }

update_json "$file" --arg id "$1" '.["transient-state-engines"] |= map(select(.id != $id))'
project="$(jq -r '.project // ""' <<< "$record")"
if [[ "$(jq -r '.parent["transient-state-engine"] // ""' <<< "$record")" == "" && "$project" =~ ^[A-Za-z0-9_-]+$ && "$1" =~ ^[0-9a-f-]+$ && -d "$projects/$project/work" ]]; then
  # Under the run's lock (ASS-179), as ticket:adopt-run-folder moves it and agent:dispatch makes it.
  lock_on 5 "$projects/$project/work/run-$1.lock" transient-state-engine:remove "${JSON_LOCK_TIMEOUT:-30}"
  rm -rf "$projects/$project/work/run-$1"
  exec 5>&-
fi
jq . <<< "$record"
