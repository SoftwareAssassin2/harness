#!/usr/bin/env bash
# Description: Once: mark what a project recorded before ASS-216 as billed to its subscription ($0) or, from <api-from> on, its API key — project:mark-billing <project> [<api-from>].
set -euo pipefail

# ASS-216 AC3. Every agent dispatch with no billing — in the project's
# sprints/ (each sprint.json and end-of-day snapshot) and backlog.json — and
# each ticket chat's spend-usd, the undated total collaboration.json kept
# before its turns did (work/<KEY>/), are marked: subscription, the cost 0
# (a dispatch never costed keeps its null), or — timestamped at or after
# <api-from> (YYYY-MM-DDTHH:MM:SSZ), a chat total by when its file was last
# written — api, the cost kept. A chat total becomes a turn
# { timestamp: null, billing, cost-usd }: in its ticket's chat spend, in no
# day's. Prints a line per file changed, what was marked and zeroed or kept;
# "<project>: nothing to mark" when nothing is, so a second run changes
# nothing. PROJECTS_DIR overrides the projects folder, used by tests. Fails,
# writing nothing, on an unknown project or a malformed <api-from>.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

command=project:mark-billing
[[ $# -eq 1 || $# -eq 2 ]] || { echo "usage: $command <project> [<api-from>]" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -d "$projects/$1" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
since="${2:-}"
[[ -z "$since" || "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "$command: the api-from must be a UTC time like 2026-10-28T12:33:02Z, got '$since'" >&2; exit 1; }
dir="$projects/$1"
changed=0

# The billing of what was recorded at $at ("" for no time): api from $since on.
billing='def billing($at): if $since != "" and ($at // "") >= $since then "api" else "subscription" end;
  def money: "$\(. * 100 | round / 100 | tostring | if test("\\.") then . else . + ".00" end | if test("\\.[0-9]$") then . + "0" else . end)";'

# The dispatches with no billing.
unbilled='[.. | objects | select(has("agent-dispatch-log")) | .["agent-dispatch-log"][]? | select(has("billing") | not)]'
while IFS= read -r file; do
  summary="$(jq -r --arg since "$since" "$billing"'
    '"$unbilled"' | map({ b: billing(.timestamp), c: (.["cost-usd"] // 0) }) | select(length > 0)
    | (map(select(.b == "subscription"))) as $s | (map(select(.b == "api"))) as $a
    | [ (if $s != [] then "\($s | length) dispatches marked subscription, \($s | map(.c) | add | money) zeroed" else empty end),
        (if $a != [] then "\($a | length)\(if $s != [] then "" else " dispatches" end) marked api, \($a | map(.c) | add | money) kept" else empty end) ] | join("; ")' "$file")"
  [[ -n "$summary" ]] || continue
  update_json "$file" --arg since "$since" "$billing"'
    (.. | objects | select(has("agent-dispatch-log")) | .["agent-dispatch-log"][]? | select(has("billing") | not))
      |= (.billing = billing(.timestamp) | if .billing == "subscription" and .["cost-usd"] != null then .["cost-usd"] = 0 else . end)'
  echo "${file#"$dir/"}: $summary"
  changed=1
done < <(find "$dir/sprints" "$dir/backlog.json" -name '*.json' -type f 2>/dev/null | sort)

while IFS= read -r file; do
  jq -e 'has("spend-usd")' "$file" >/dev/null || continue
  at="$(date -u -r "$file" +%Y-%m-%dT%H:%M:%SZ)"
  summary="$(jq -r --arg since "$since" --arg at "$at" "$billing"'
    billing($at) as $b | "chat spend marked \($b), \(.["spend-usd"] | money) \(if $b == "api" then "kept" else "zeroed" end)"' "$file")"
  update_json "$file" --arg since "$since" --arg at "$at" "$billing"'
    billing($at) as $b
    | .turns = [{ timestamp: null, billing: $b, "cost-usd": (if $b == "api" then .["spend-usd"] else 0 end) }] + (.turns // [])
    | del(.["spend-usd"])'
  echo "${file#"$dir/"}: $summary"
  changed=1
done < <(find "$dir/work" -mindepth 2 -maxdepth 2 -name collaboration.json -type f 2>/dev/null | sort)

[[ $changed -eq 1 ]] || echo "$1: nothing to mark"
