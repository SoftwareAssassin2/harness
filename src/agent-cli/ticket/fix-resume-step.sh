#!/usr/bin/env bash
# Description: Where a blocked ticket variation resumes once its fix has landed — ticket:fix-resume-step <project> <ticket-key> <variation>.
set -euo pipefail

# Run by grouped-blocked's resume-step once await-fix says the fix landed
# (ASS-343); its output, recorded (record-script-output), reaches control,
# which resumes the ticket there when engine.js whyNotResume allows it, else
# at the step it blocked at. Declared, else derived, else that step:
#   declared — the fix ticket's own resume-at (off-board.sh ticket:get in the
#     project the variation's waits-on names; ticket:create --resume-at);
#   commits — the files changed by the commits whose subject starts "<KEY>:"
#     on the default branch of the fix project's workspace (code.bash's
#     workspace_of and default_branch, local and origin's as last fetched,
#     as ticket:fix-landed reads them): prompts/<name>/ maps to the steps
#     running that prompt, src/agent-cli/<family>/<command>.sh|.js to the
#     steps whose command runs it, engines/<name>/ to the top-level step
#     running that engine;
#   data — files of the ticket's work folder (data/projects/<project>/work/
#     <KEY>) written since the variation entered await-fix (its
#     state-changes), mapped to the step that writes them: a step's
#     file-updated exits, and automated-tests-<variation>.json to
#     generate-automated-tests;
#   none — the step it blocked at (engine.js returnTo).
# Each step found is lifted to its top-level group; of the commits' and the
# data's, the earliest at or before the blocked step is taken (see
# fix-resume-step.js). Prints { resume-at, resume-source
# (declared|commits|data|none), resume-why, resume-ignored: [{ step, source,
# why }] } and exits 0 whatever it finds or cannot read; only a wrong number
# of arguments fails (1).
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../code.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:fix-resume-step <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" name="$3"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || project=-

# The ticket (its key as the sprint writes it) and its variation, {} when not found.
found="$( { jq -c --arg key "$2" --arg name "$name" '
  first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase))) // {}
  | { key: (.key // null), variation: (.variations // [] | map(select(.name == $name and (.["is-deleted"] | not))) | first // {}) }' \
  "$(sprint_file ticket:fix-resume-step "$project" 2>/dev/null)" 2>/dev/null; } || true)"
[[ -n "$found" ]] || found='{"key":null,"variation":{}}'
key="$(jq -r '.key // empty' <<< "$found")"
key="${key:-$(upper "$2")}"
engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json" 2>/dev/null || true)"
engine_list="$(engine_files "$project" | jq -Rsc 'split("\n") | map(select(. != ""))')"

home="$(jq -r '.variation["waits-on"].project // empty' <<< "$found")"
fix="$(jq -r '.variation["waits-on"].ticket // empty' <<< "$found")"
declared= changed='[]'
if [[ -n "$home" && -n "$fix" ]]; then
  declared="$( { "$here/../../../off-board.sh" ticket:get "$home" "$fix" 2>/dev/null | jq -r '.["resume-at"] // empty'; } 2>/dev/null || true)"
  if workspace="$(workspace_of ticket:fix-resume-step "$home" 2>/dev/null)"; then
    branch="$(default_branch "$workspace")"
    refs=()
    for ref in "refs/heads/$branch" "refs/remotes/origin/$branch"; do
      git -C "$workspace" rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1 && refs+=("$ref")
    done
    if [[ ${#refs[@]} -gt 0 ]]; then
      shas="$( { git -C "$workspace" log --fixed-strings --grep="$fix:" --format='%H %s' "${refs[@]}" 2>/dev/null \
        | awk -v prefix="$fix:" '{ sha = $1; sub(/^[^ ]+ /, "") } index($0, prefix) == 1 { print sha }'; } || true)"
      if [[ -n "$shas" ]]; then
        changed="$( { while read -r sha; do git -C "$workspace" diff-tree --no-commit-id --name-only -r --root "$sha" 2>/dev/null; done <<< "$shas"; } \
          | jq -Rsc 'split("\n") | map(select(. != "")) | unique' 2>/dev/null || echo '[]')"
      fi
    fi
  fi
fi

jq -nc --arg project "$project" --arg ticket "$key" --argjson found "$found" --arg engine "$engine" --argjson files "$engine_list" \
  --arg fix "$fix" --arg declared "$declared" --argjson changed "$changed" --arg work "$projects/$project/work/$key" \
  '{ project: $project, ticket: $ticket, variation: $found.variation, engine: $engine, engineFiles: $files,
     fix: (if $fix == "" then null else $fix end), declared: (if $declared == "" then null else $declared end), changed: $changed, workFolder: $work }' \
  | node "$here/fix-resume-step.js"
