#!/usr/bin/env bash
# Description: Record a project's own Anthropic API organization's month-to-date spend — project:set-api-cost <project> <YYYY-MM> <usd>.
set -euo pipefail

# Writes { month, usd, as-of } to data/projects/<project>/api-cost.json
# (PROJECTS_DIR overrides the projects folder, used by tests) — live data,
# like harness:set-api-cost's data/api-cost.json, but of the org whose admin
# key the project's project.json names (api-cost-admin-keychain-service,
# ASS-221): what control last read of it this UTC month, about hourly
# (src/control/api-cost.js checkApiCost). The dashboard shows it in the
# project's models box. A plain overwrite. Fails, writing nothing, unless the
# project has a project.json, the month is YYYY-MM and the amount a number of
# dollars (0 or more).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 3 ]] || { echo "usage: project:set-api-cost <project> <YYYY-MM> <usd>" >&2; exit 1; }
# The project becomes a path segment, so it may not climb out of the projects folder.
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:set-api-cost: invalid project '$1'" >&2; exit 1; }
[[ "$2" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]] || { echo "project:set-api-cost: the month must be YYYY-MM, got '$2'" >&2; exit 1; }
[[ "$3" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "project:set-api-cost: the amount must be a number of dollars, got '$3'" >&2; exit 1; }
[[ -f "$projects/$1/project.json" ]] || { echo "project:set-api-cost: no project $1" >&2; exit 1; }

update_json --create "$projects/$1/api-cost.json" --arg month "$2" --argjson usd "$3" '{ month: $month, usd: $usd, "as-of": (now | floor | todate) }'
