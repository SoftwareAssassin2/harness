#!/usr/bin/env bash
# Description: Record a self-healing fix and pause just the tickets its plan holds — self-healing:start <project> <ticket-key>.
set -euo pipefail

# Run at the start of every attempt at a fix (self-healing-fix), from the
# plan self-healing:take-on recorded on the fix ticket ("self-healing-plan":
# { summary, ticket-url, pause-tickets }); without one (a fix first handed to
# the operator), the ticket's title and url and nothing to pause. Each ticket
# to pause is in the project its key names (key_project, see
# ticket-system.bash: its key prefix) — never looked for in other sprints —
# and each of its live variations not paused already is paused through
# ticket:set-paused: control then shuts its agents down gracefully, and the
# rest works on. First (ASS-179: a start cut short leaves nothing paused that
# no record names) assignments.json (in data/) records the fix
# under its ticket in self-healing — { since (now, UTC), ticket, summary,
# ticket-url, project, paused: [ { project, ticket, variation }… ] }, one
# record per fix, so fixes under way at once keep theirs apart — the
# dashboard's SELF HEALING banner, and the variations self-healing:stop
# unpauses; another attempt at the same fix keeps what earlier ones paused.
# No pause holds the agents. Fails, writing nothing, when the fix ticket is
# not in the sprint, or a ticket to pause names no project or is not in its
# project's active sprint.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"

# ASSIGNMENTS_FILE overrides the path, used by tests.
file="${ASSIGNMENTS_FILE:-$here/../../../data/assignments.json}"

[[ $# -eq 2 ]] || { echo "usage: self-healing:start <project> <ticket-key>" >&2; exit 1; }
project="$1" ticket="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
sprint="$(sprint_file self-healing:start "$project")"
plan="$(jq -c --arg key "$ticket" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_upcase == $key))
  | { summary: (.["self-healing-plan"].summary // .title // .key), "ticket-url": (.["self-healing-plan"]["ticket-url"] // .url),
      keys: [.["self-healing-plan"]["pause-tickets"] // [] | .[] | ascii_upcase] }' "$sprint")"
[[ -n "$plan" ]] || { echo "self-healing:start: no $ticket in the active sprint" >&2; exit 1; }
keys="$(jq -c .keys <<< "$plan")" summary="$(jq -r .summary <<< "$plan")" url="$(jq -r '.["ticket-url"] // ""' <<< "$plan")"

# The variations to pause, every one found before anything is written: in the project each key names, live, not paused yet.
paused='[]'
while IFS= read -r k; do
  [[ -n "$k" ]] || continue
  home="$(key_project self-healing:start "$k")"
  [[ -n "$home" ]] || { echo "self-healing:start: $k names no project" >&2; exit 1; }
  these="$(jq -c --arg key "$k" --arg p "$home" '
    (first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_upcase == $key)) // null) as $t
    | if $t == null then error("self-healing:start: no \($key) in \($p)'"'"'s active sprint") else . end
    | [$t.variations // [] | .[] | select((.["is-deleted"] | not) and .["is-paused"] != true) | { project: $p, ticket: $t.key, variation: .name }]' "$(sprint_file self-healing:start "$home")")"
  paused="$(jq -c --argjson more "$these" '. + $more' <<< "$paused")"
done < <(jq -r '.[]' <<< "$keys")

update_json "$file" --arg ticket "$ticket" --arg summary "$summary" --arg url "$url" --arg project "$project" --argjson paused "$paused" '
  ((.["self-healing"] // {})[$ticket].paused // []) as $before
  | .["self-healing"] = ((.["self-healing"] // {}) + { ($ticket): { since: (now | floor | todate), ticket: $ticket, summary: $summary, "ticket-url": (if $url == "" then null else $url end), project: $project,
      paused: ($before + [$paused[] | select(. as $p | $before | index([$p]) | not)]) } })'
while IFS= read -r v; do
  "$here/../../../agent.sh" ticket:set-paused "$(jq -r .project <<< "$v")" "$(jq -r .ticket <<< "$v")" "$(jq -r .variation <<< "$v")" true >/dev/null
done < <(jq -c '.[]' <<< "$paused")
