#!/usr/bin/env bash
# Description: Create an assignment's agent records — assignments:create <project> <state-engine> <state> <prompt> <agent-count> <run-in-dev-container> <work-item|-> <variation|-> <transient-state-engine-id|-> [<problem>|-].
set -euo pipefail

# <agent-count> records in assignments.json (in data/) sharing one new
# assignment-id: the first is the pen-holder (is-lead); each is named by the
# free names of agent-names.json — [{ name, franchise-name }] — (free: no
# record has it) used longest ago by agent-names-last-used.json — { <name>:
# <when last used, ISO> }, a name not in it never used, the file missing none
# used — never-used first, ties in random order, each then recorded there
# (only there: agent-names.json is never written) as used at the start-time;
# each is
# given a model round robin over harness.json's claude models from after the
# one in the last-model-used file in data/ (plain text, just the
# model; missing, the first model), which becomes the last model handed out —
# skipping those the prompt's prompt.json supported-models does not name, unless
# it names none of them or has none, when all take their turn. A record is status
# Starting with no process, start-time and last-heartbeat now (UTC),
# working-in-dev-container as given, the state-engine and prompt named, and its
# context: work-item and variation (- for null), the transient-state-engine id,
# or both for a step of a ticket's own state engine; a <problem> (- for none)
# fills the prompt's {problem}. Given a work-item and variation, each agent is
# logged as dispatched ({ dispatched-to, timestamp, completed-timestamp: null,
# cost-usd: null, tokens: null }) on the variation's latest state change in the
# project's active sprint (see sprint.bash), the variation at <state> — but for
# a sub-engine step (transient id given too) on the latest change whatever the
# state — or, for a backlog ticket at a step of its refinement engine (ASS-144),
# on its latest change in the project's backlog.json. Prints the records as a JSON array. Fails, writing nothing, on a count below 1, an
# unknown project, engine or prompt, no context, too few free names, or the
# variation elsewhere. Writes the records, the sprint, last-model-used, then
# agent-names-last-used.json, made if missing. ASSIGNMENTS_FILE, HARNESS_FILE,
# LAST_MODEL_USED_FILE, AGENT_NAMES_FILE, AGENT_NAMES_LAST_USED_FILE, PROMPTS_DIR, ENGINES_DIR and
# PROJECTS_DIR override the paths, used by tests.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
backlog_too=1
source "$here/../sprint.bash"
source "$here/../engine.bash"
file="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"
harness="${HARNESS_FILE:-$here/../../../data/harness.json}"
last_model_file="${LAST_MODEL_USED_FILE:-$here/../../../data/last-model-used}"
names_file="${AGENT_NAMES_FILE:-$here/../../../data/agent-names.json}"
used_file="${AGENT_NAMES_LAST_USED_FILE:-$here/../../../data/agent-names-last-used.json}"
prompts="${PROMPTS_DIR:-$here/../../../prompts}"

usage() { echo "usage: assignments:create <project> <state-engine> <state> <prompt> <agent-count> <run-in-dev-container true|false> <work-item|-> <variation|-> <transient-state-engine-id|-> [<problem>|-]" >&2; exit 1; }
[[ $# -eq 9 || $# -eq 10 ]] || usage
project="$1" engine="$2" state="$3" prompt="$4" count="$5" container="$6" work="$7" variation="$8" transient="$9" problem="${10:--}"
[[ "$container" == true || "$container" == false ]] || usage
[[ "$count" =~ ^[1-9][0-9]*$ ]] || { echo "assignments:create: agent-count must be a whole number from 1, got '$count'" >&2; exit 1; }
# Names become path segments, so they may not climb out of their folders.
segment() { [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]]; }
segment "$project" && [[ -f "$projects/$project/project.json" ]] || { echo "assignments:create: no project $project" >&2; exit 1; }
engine_file assignments:create "${engine%%/*}" "$project" > /dev/null
segment "$prompt" && [[ -f "$prompts/$prompt/prompt.txt" ]] || { echo "assignments:create: no prompt $prompt" >&2; exit 1; }
[[ "$work" != - || "$transient" != - ]] || { echo "assignments:create: a work-item or a transient state engine is needed" >&2; exit 1; }

at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
# One random number per name breaks ties, so the never-used names come out in random order.
random="$(od -An -tu4 -N"$((4 * ($(jq 'length' "$names_file") + 1)))" /dev/urandom | jq -sc .)"
used="$(cat "$used_file" 2>/dev/null || echo '{}')"
names="$(jq -c --argjson n "$count" --argjson random "$random" --argjson used "$used" --slurpfile a "$file" '
  [to_entries[] | select(.value.name | IN($a[0].assignments[]["agent-name"]) | not)
    | { name: .value.name, used: ($used[.value.name] // ""), random: $random[.key] }]
  | sort_by(.used, .random) | map(.name) | .[:$n]' "$names_file")"
[[ "$(jq length <<< "$names")" -eq "$count" ]] || { echo "assignments:create: not enough free agent names" >&2; exit 1; }
supported="$(jq -c '.["supported-models"] // []' "$prompts/$prompt/prompt.json" 2>/dev/null || echo '[]')"
models="$(jq -c --argjson n "$count" --arg last "$(cat "$last_model_file" 2>/dev/null || true)" --argjson supported "$supported" '
  [.["agentic-command-line-interfaces"][] | select(.name == "claude") | .models[]] as $m
  | if ($m | length) == 0 then error("assignments:create: harness.json has no claude models") else . end
  | (($m | to_entries | map(select(.value == $last)) | first | .key) // -1) as $i
  | [range(1; ($m | length) + 1) | $m[($i + .) % ($m | length)]] as $turns
  | ([$turns[] | select(IN($supported[]))] | if length == 0 then $turns else . end) as $c
  | [range(0; $n) | $c[. % ($c | length)]]' "$harness")"
records="$(jq -nc --argjson names "$names" --argjson models "$models" --arg id "$id" --arg project "$project" --arg engine "$engine" \
  --arg state "$state" --arg prompt "$prompt" --argjson count "$count" --argjson container "$container" \
  --arg work "$work" --arg variation "$variation" --arg transient "$transient" --arg problem "$problem" --arg at "$at" '
  [range(0; $count) as $i
    | { "process-id": null, "session-id": null, model: $models[$i], "start-time": $at, "last-heartbeat": $at, "agent-name": $names[$i], project: $project }
    + (if $work != "-" then { "work-item": $work, variation: (if $variation == "-" then null else $variation end) } else {} end)
    + (if $transient != "-" then { "transient-state-engine": $transient } else {} end)
    + { "state-engine": $engine, state: $state, prompt: $prompt, status: "Starting", "is-lead": ($i == 0),
        "assignment-id": $id, "agent-count": $count, "pen-holder": $names[0], approvals: {},
        "ai-feedback-short": null, "ai-feedback-long": null, "working-in-dev-container": $container,
        "ai-status-update-short": null, "last-ai-status-update": null }
    + (if $problem != "-" then { problem: $problem } else {} end)]')"

# The records first, their names checked under the lock, then the dispatch
# log (ASS-178): a stop between them leaves records with no process, which
# control removes as stale, never a log entry no record will complete. A log
# that fails takes the records back out.
update_json "$file" --argjson records "$records" --argjson names "$names" '
  if any(.assignments[]["agent-name"]; IN($names[])) then error("assignments:create: not enough free agent names") else . end
  | .assignments += $records'
if [[ "$work" != - && "$variation" != - ]]; then
  trap '[[ $? -eq 0 ]] || update_json "$file" --arg id "$id" ".assignments |= map(select(.[\"assignment-id\"] != \$id))"' EXIT
  entries="$(jq -c --arg at "$at" 'map({ "dispatched-to": ., timestamp: $at, "completed-timestamp": null, "cost-usd": null, tokens: null })' <<< "$names")"
  # A ticket never moved (just synced) has no state change to carry the log: the dispatch goes unlogged, said on stderr.
  changes="$(jq -r --arg key "$work" --arg name "$variation" '
    first((.features, .bugs, .spikes, .tickets) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
    | .variations[]? | select(.name == $name and (.["is-deleted"] | not)) | (.["state-changes"] // [] | length)' "$(ticket_file assignments:create "$project" "$work")")"
  if [[ "$changes" == 0 ]]; then
    echo "assignments:create: $work.$variation has no state change to log the dispatch on; not logged" >&2
    log='.'
  else
    log='.["state-changes"][-1]["agent-dispatch-log"] += $entries'
  fi
  if [[ "$transient" == - ]]; then
    update_variation assignments:create "$project" "$work" "$variation" "$state" --argjson entries "$entries" "$log"
  else
    update_whole_ticket assignments:create "$project" "$work" --arg name "$variation" --argjson entries "$entries" '
      if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
      | .variations |= map(if .name == $name then ('"$log"') else . end)'
  fi
  trap - EXIT
fi

# Written beside and renamed over, so a reader never sees half of it.
jq -j '.[-1]' <<< "$models" > "$last_model_file.$$" && mv -f "$last_model_file.$$" "$last_model_file"
( set -o noclobber; echo '{}' > "$used_file" ) 2>/dev/null || true   # made if missing, never over one there
update_json "$used_file" --argjson names "$names" --arg at "$at" '. + ($names | map({ key: ., value: $at }) | from_entries)'
jq . <<< "$records"
