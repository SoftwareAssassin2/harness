#!/usr/bin/env bash
# Description: Forget a project's rate limit on one credential kind once it has reset — project:clear-rate-limit <project> <kind>.
set -euo pipefail

# Deletes the kind's entry (claude or anthropic, ASS-215) from
# data/projects/<project>/rate-limit.json, and the file with its last entry
# (PROJECTS_DIR overrides the projects folder, used by tests); see
# project:set-rate-limit. Under the lock set-rate-limit writes through, so the
# two never interleave. Nothing to clear is fine.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 2 ]] || { echo "usage: project:clear-rate-limit <project> <kind>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:clear-rate-limit: invalid project '$1'" >&2; exit 1; }
[[ "$2" =~ ^(claude|anthropic)$ ]] || { echo "project:clear-rate-limit: the kind must be claude or anthropic" >&2; exit 1; }
[[ -f "$projects/$1/project.json" ]] || { echo "project:clear-rate-limit: no project $1" >&2; exit 1; }

file="$projects/$1/rate-limit.json"
lock_on 9 "$file.lock" project:clear-rate-limit "${JSON_LOCK_TIMEOUT:-30}"
[[ -f "$file" ]] || exit 0
write_json "$file" --arg k "$2" 'del(.[$k])'
if [[ "$(jq 'length' "$file")" -eq 0 ]]; then rm -f "$file"; fi
