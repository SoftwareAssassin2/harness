#!/usr/bin/env bash
# Description: Record a rate limit an agent hit — project:set-rate-limit <project> <kind> <type> <resets-at>; control holds that kind's agents until it resets.
set -euo pipefail

# Writes { <kind>: { since, type, resets-at }, … } to
# data/projects/<project>/rate-limit.json (PROJECTS_DIR overrides the projects
# folder, used by tests) — live data, kept out of the tracked project.json
# (ASS-94), one entry per credential kind (ASS-215): `kind` the credential the
# agent ran on (claude, a subscription; anthropic, a Console API key), `type`
# the limit's kind as Claude names it (five_hour, seven_day), `resets-at` when
# it lifts, `since` now — kept as it was when that kind already holds. A flat
# file from before kinds is replaced. The dashboard shows it as RATE LIMITED;
# project:clear-rate-limit deletes a kind. Fails, writing nothing, unless the
# kind is claude or anthropic, the time ISO 8601 UTC
# (YYYY-MM-DDTHH:MM:SS[.fff]Z), the type a single word and the project has a
# project.json.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 4 ]] || { echo "usage: project:set-rate-limit <project> <kind> <type> <resets-at>" >&2; exit 1; }
# The project becomes a path segment, so it may not climb out of the projects folder.
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:set-rate-limit: invalid project '$1'" >&2; exit 1; }
[[ "$2" =~ ^(claude|anthropic)$ ]] || { echo "project:set-rate-limit: the kind must be claude or anthropic" >&2; exit 1; }
[[ "$3" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:set-rate-limit: the type must be one word, like five_hour" >&2; exit 1; }
[[ "$4" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] || { echo "project:set-rate-limit: the time must be ISO 8601 UTC, like 2026-10-11T03:04:05Z" >&2; exit 1; }
[[ -f "$projects/$1/project.json" ]] || { echo "project:set-rate-limit: no project $1" >&2; exit 1; }

# --create: the first writer makes the file under the lock, so `since` is
# kept even when two agents hit the limit at once.
update_json --create "$projects/$1/rate-limit.json" --arg k "$2" --arg type "$3" --arg at "$4" '
  (if has("resets-at") then {} else . end)
  | .[$k] = { since: (.[$k].since // (now | floor | todate)), type: $type, "resets-at": $at }'
