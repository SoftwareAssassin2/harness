#!/usr/bin/env bash
# Description: Set the weekly Claude usage at which a project's grooming and background work are held — project:set-background-weekly-usage-limit <project> <percent|none>.
set -euo pipefail

# Writes data/projects/<project>/project.json's
# background-weekly-usage-limit-percent: the percent (0–100), or null for
# none (PROJECTS_DIR overrides the projects folder, used by tests). Absent is
# 90. Control reads it every tick (ASS-232, moves.js weeklyLimit): while the
# project's last claude-usage.json weekly reading is at or above it, before
# that week resets, none of its grooming or background work (check-health,
# check-memory, check-variation-appeal, check-ticket-health, self-healing) is
# dispatched on the subscription: a project with an API key beside it runs
# that work on the key (ASS-327, held by the API caps and rate limit as any
# API dispatch), one without holds it; its sprint work goes on.
# Fails, writing nothing, on an unknown project or value.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

command=project:set-background-weekly-usage-limit
[[ $# -eq 2 ]] || { echo "usage: $command <project> <percent|none>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
[[ "$2" == none ]] || { [[ "$2" =~ ^[0-9]+(\.[0-9]+)?$ ]] && awk -v p="$2" 'BEGIN { exit !(p <= 100) }'; } \
  || { echo "$command: the limit must be a percent from 0 to 100, or none, got '$2'" >&2; exit 1; }
update_json "$projects/$1/project.json" --argjson limit "$([[ "$2" == none ]] && echo null || echo "$2")" '.["background-weekly-usage-limit-percent"] = $limit'
[[ "$2" == none ]] && echo "$1: background work never held for weekly usage" || echo "$1: background work held at $2% weekly usage"
