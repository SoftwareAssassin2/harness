#!/usr/bin/env bash
# Description: Start a run of a state engine — transient-state-engine:create <project> <state-engine> <state> <parent-json> [<output-json>].
set -euo pipefail

# Appends { id (a new uuid), project, state-engine, state, start-time,
# last-heartbeat (now, UTC), parent, is-done: false, structured-output: null }
# to transient-state-engines in assignments.json (in data/) and prints
# it. <state-engine> is "<engine>" or "<engine>/<key>", a *-steps list inside
# an engine (see engine.bash); <state> must be one of its steps. <parent> is
# the JSON object of what spawned the run: for a ticket step's own engine
# { work-item, variation, state-engine, state }; for a trigger { trigger,
# work-item?, variation? }. Given <output-json>, an object, the run starts
# with it as its structured-output (ASS-124: a ticket entered part way into
# a sub-engine brings what was found). Then the project's active sprint's connected-flows
# — one { name, run-count } per engine its execution engine reaches
# (connected_engines), 0 until it runs — is brought up to date, and the run's
# engine (not a *-steps list's run, whose step starts the engine) counted
# once more (ASS-7). Fails, writing nothing, on an unknown project,
# engine, list or step, or a parent or output that is not an object. ASSIGNMENTS_FILE,
# ENGINES_DIR and PROJECTS_DIR override the paths, used by tests.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../json-file.bash"
source "$here/../engine.bash"
file="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"

[[ $# -eq 4 || $# -eq 5 ]] || { echo "usage: transient-state-engine:create <project> <state-engine> <state> <parent-json> [<output-json>]" >&2; exit 1; }
project="$1" engine="$2" state="$3" parent="$4" output="${5:-null}"
# The project becomes a path segment, so it may not climb out of the projects folder.
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "transient-state-engine:create: invalid project '$project'" >&2; exit 1; }
[[ -f "$projects/$project/project.json" ]] || { echo "transient-state-engine:create: no project $project" >&2; exit 1; }
steps="$(engine_steps_of transient-state-engine:create "$engine" "$project")"
jq -e --arg state "$state" 'any(.[]; .id == $state)' <<< "$steps" > /dev/null || { echo "transient-state-engine:create: $engine has no step $state" >&2; exit 1; }
jq -e 'type == "object"' <<< "$parent" > /dev/null 2>&1 || { echo "transient-state-engine:create: the parent must be a JSON object" >&2; exit 1; }
[[ $# -eq 4 ]] || jq -e 'type == "object"' <<< "$output" > /dev/null 2>&1 || { echo "transient-state-engine:create: the output must be a JSON object" >&2; exit 1; }

record="$(jq -nc --arg id "$(uuidgen | tr '[:upper:]' '[:lower:]')" --arg project "$project" --arg engine "$engine" --arg state "$state" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson parent "$parent" --argjson output "$output" \
  '{ id: $id, project: $project, "state-engine": $engine, state: $state, "start-time": $at, "last-heartbeat": $at, parent: $parent, "is-done": false, "structured-output": $output }')"
update_json "$file" --argjson record "$record" '.["transient-state-engines"] = (.["transient-state-engines"] // []) + [$record]'

# connected-flows, in the active sprint (none: nothing to count), chosen inside
# the project's tickets.lock (ASS-179, sprint.bash lock_tickets).
source "$here/../sprint.bash"
lock_tickets transient-state-engine:create "$project"
sprint="$(sprint_file transient-state-engine:create "$project" 2>/dev/null || true)"
if [[ -n "$sprint" && -f "$sprint" ]]; then
  connected="$(connected_engines "$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json")" "$project" | jq -Rsc 'split("\n") | map(select(. != ""))')"
  update_json "$sprint" --argjson connected "$connected" --arg ran "$([[ "$engine" == */* ]] && echo "" || echo "$engine")" '
    (.["connected-flows"] // []) as $old
    | .["connected-flows"] = ([$connected[] as $n | { name: $n, "run-count": (first($old[] | select(.name == $n) | .["run-count"]) // 0) }]
        + [$old[] | select(.name | IN($connected[]) | not)])
    | if $ran == "" then . else
        (if any(.["connected-flows"][]; .name == $ran) then . else .["connected-flows"] += [{ name: $ran, "run-count": 0 }] end)
        | .["connected-flows"] |= map(if .name == $ran then .["run-count"] += 1 else . end) end'
fi
jq . <<< "$record"
