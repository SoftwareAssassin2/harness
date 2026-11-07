#!/usr/bin/env bash
# Description: Close a self-healing fix and unpause the tickets it paused — self-healing:stop <project> <ticket-key>.
set -euo pipefail

# Unpauses ("is-paused": false), through ticket:set-paused, exactly the
# variations self-healing:start paused for this fix (assignments.json
# self-healing[<ticket>].paused), each in its own project — one paused by hand
# meanwhile stays paused only if start did not pause it — then removes the
# fix's record, leaving any other fix under way as it is, and releases an AI
# pause the fix set (its reason the fix's summary): status "Paused" while
# another pause holds, else "Running". No fix under way for the ticket is no
# failure. The record goes only once nothing it lists is left paused
# (ASS-179): what a start adds while this unpauses is unpaused in turn.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../json-file.bash"

# ASSIGNMENTS_FILE overrides the path, used by tests.
file="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"

[[ $# -eq 2 ]] || { echo "usage: self-healing:stop <project> <ticket-key>" >&2; exit 1; }
ticket="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
while healing="$(jq -c --arg t "$ticket" '(.["self-healing"] // {})[$t] // null' "$file")" && [[ "$healing" != null ]]; do
  while IFS= read -r v; do
    "$here/../../../agent.sh" ticket:set-paused "$(jq -r --arg p "$1" '.project // $p' <<< "$v")" "$(jq -r .ticket <<< "$v")" "$(jq -r .variation <<< "$v")" false >/dev/null
  done < <(jq -c '(.paused // [])[]' <<< "$healing")
  # Under the lock: what is listed now, less what was just unpaused, is left; none left, the record goes.
  update_json "$file" --arg t "$ticket" --arg summary "$(jq -r .summary <<< "$healing")" --argjson done "$(jq -c '.paused // []' <<< "$healing")" '
    if ((.["self-healing"] // {})[$t] // null) == null then .
    elif (.["self-healing"][$t].paused // []) - $done != [] then .["self-healing"][$t].paused -= $done
    else
      .["self-healing"] = ((.["self-healing"] // {}) | del(.[$t]))
      | .pauses = ((.pauses // {}) | map_values(if .ai.reason == $summary then del(.ai) else . end) | with_entries(select(.value | length > 0)))
      | .status = (if (.pauses | length) > 0 then "Paused" else "Running" end)
    end'
done
