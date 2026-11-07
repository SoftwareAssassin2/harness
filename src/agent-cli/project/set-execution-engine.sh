#!/usr/bin/env bash
# Description: Switch a project to another execution engine, or back — project:set-execution-engine <project> <engine>.
set -euo pipefail

# How a project moves onto its grouped engine and rolls back off it (ASS-68,
# engines/grouped-engines.md), each project on its own. A variation's
# harness-status names the engine it stands in, which the commands that move
# it read (sync_paired_status, ticket:accept-ticket-system-status), so the
# switch is two writes:
#  1. The project's active sprint (none: nothing to do): every variation not
#     deleted whose harness-status names an engine gets <engine> instead, at
#     its top level (a sub-status is its sub-engine's), and its
#     gate-when-leaving-state entries "<old>/<step>" become "<engine>/<step>".
#     Each one's state must be a step of <engine>'s `steps`, and not one that
#     hands the ticket back where it came from (follow-return-to-state:
#     Blocked, Blocked for Human — that step is the old engine's), or nothing
#     is written: move it, or let it finish, first. Backlog, Committed and
#     Done are the current and grouped engines' common ground.
#  2. data/projects/<project>/project.json's execution-state-engine: <engine>.
# A stop between the two leaves project.json naming <old>: a rerun finds the
# sprint switched already, writes it unchanged, and finishes (ASS-178).
# Prints "<project>: <old> → <engine>". Switch with control stopped or the
# project paused, so no run is under way. Fails, writing nothing, on an
# invalid project, an unknown engine, or a variation the engine cannot hold.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"

command=project:set-execution-engine
[[ $# -eq 2 ]] || { echo "usage: $command <project> <engine>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
project="$1" engine="$2"
steps="$(engine_steps_of "$command" "$engine" "$project")"
old="$(jq -r '.["execution-state-engine"] // ""' "$projects/$project/project.json")"

if jq -e 'any(.list[]?; .["is-active"])' "$projects/$project/sprints.json" >/dev/null 2>&1; then
  update_json "$(sprint_file "$command" "$project")" --arg engine "$engine" --arg old "$old" --arg command "$command" --argjson steps "$steps" '
    ($steps | map(.id)) as $ids
    | ($steps | map(select(any(.["exit-events"][]?; .["follow-return-to-state"])) | .id)) as $returning
    | def live: .["is-deleted"] != true and .["harness-status"]["state-engine"] != null;
      def at: [(.features, .bugs, .spikes) // [] | .[] | .key as $k | .variations // [] | .[] | select(live) | { v: "\($k) \(.name) is at \(.["harness-status"].state)", state: .["harness-status"].state }];
      (at | map(select(.state | IN($ids[]) | not) | .v)) as $missing
    | (at | map(select(.state | IN($returning[])) | .v)) as $back
    | if $missing != [] then error("\($command): \($missing | join(", ")), which \($engine) has no step for: move it first")
      elif $back != [] then error("\($command): \($back | join(", ")), which returns it to a step of \($old): let it finish first")
      else . end
    | (.features, .bugs, .spikes) |= (if . == null then . else map(.variations |= (if . == null then . else map(if live then
        .["harness-status"]["state-engine"] = $engine
        | .["gate-when-leaving-state"] |= (if . == null then . else map(if startswith("\($old)/") then "\($engine)/\(ltrimstr("\($old)/"))" else . end) end)
      else . end) end)) end)'
fi
update_json "$projects/$project/project.json" --arg engine "$engine" '.["execution-state-engine"] = $engine'
echo "$project: ${old:--} → $engine"
