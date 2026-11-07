#!/usr/bin/env bash
# Description: Record which API cap holds a project's fallback to its API key — project:set-api-cap-hold <project> <day|sprint> <spend-usd> <limit-usd>, or <project> - to clear it.
set -euo pipefail

# Writes "api-cap-hold": { since, cap, spend-usd, limit-usd } in
# data/projects/<project>/project.json (PROJECTS_DIR overrides the projects
# folder, used by tests): the cap (project.json's max-api-spend-per-day-usd or
# max-api-spend-per-sprint-usd) its api-billed spend has reached, and `since`
# now — kept as it was when one already holds (ASS-217). While it holds,
# control starts none of the project's agents on the API key and shuts down
# those running there; the dashboard names the cap. `-` removes it; nothing
# to remove is fine. Fails, writing nothing, on a bad project, cap, amount or usage.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

usage="usage: project:set-api-cap-hold <project> <day|sprint> <spend-usd> <limit-usd> | <project> -"
[[ $# -eq 2 && "$2" == - || $# -eq 4 ]] || { echo "$usage" >&2; exit 1; }
# The project becomes a path segment, so it may not climb out of the projects folder.
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:set-api-cap-hold: invalid project '$1'" >&2; exit 1; }
[[ "$2" == - ]] && { update_json "$projects/$1/project.json" 'del(.["api-cap-hold"])'; exit 0; }
[[ "$2" == day || "$2" == sprint ]] || { echo "project:set-api-cap-hold: invalid cap '$2' (day or sprint)" >&2; exit 1; }
for n in "$3" "$4"; do [[ "$n" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "project:set-api-cap-hold: the spend and limit must be numbers, got '$n'" >&2; exit 1; }; done

update_json "$projects/$1/project.json" --arg cap "$2" --argjson spend "$3" --argjson limit "$4" '
  .["api-cap-hold"] = { since: (.["api-cap-hold"].since // (now | floor | todate)), cap: $cap, "spend-usd": $spend, "limit-usd": $limit }'
