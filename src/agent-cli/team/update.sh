#!/usr/bin/env bash
# Description: Keep the project's team list, each person's ticket-system and git identities and role, up to date from the analytics data — team:update <project>.
set -euo pipefail

# ASS-409. data/projects/<project>/team.json is
#   { "members": [ { "ticket-system-id", "ticket-system-name", "git-username",
#       "git-name", "role" (developer|qa|product|bot|unmatched), "matched-by"
#       (name|ticket-keys|operator|null), "first-seen" (the date added),
#       "set-by-operator": [<field>…] }… ] }
# brought up to date from analytics/tickets.json (ASS-406) and analytics/
# merge-requests.json (ASS-408) by src/analytics/team.js updateTeam (the
# rules, AC2–AC5): each person credited as developer on a done ticket and
# each merged merge request's author added, git authors linked to
# ticket-system people by name or by their merge requests' ticket keys, roles
# worked out again; nobody removed, and a field named in a member's
# set-by-operator never changed. A file in the earlier prototype's shape
# (jira-account-id, jira-name, gitlab-username, gitlab-name) is rewritten in
# this one, its roles and set-by-operator kept (AC6). A status's meaning comes
# only from the engines the project runs: its own (data/projects/<project>/
# engines/), its execution-state-engine and every engine that one reaches
# (connected_engines), the project's own of a name over engines/'s.
#
# team.json.lock, update_json's, is held from the read to the write, so no
# other write lands between. The file is written (beside and renamed over)
# only when it changed. Prints one line for each member added, each git
# author linked and a prototype file rewritten; nothing when nothing changed.
# Fails, writing nothing, on a bad or missing project, or a team.json or
# analytics file that is not JSON. PROJECTS_DIR and ENGINES_DIR override the
# folders, used by tests.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../json-file.bash"
source "$here/../engine.bash"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"

[[ $# -eq 1 ]] || { echo "usage: team:update <project>" >&2; exit 1; }
project="$1"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "team:update: invalid project '$project'" >&2; exit 1; }
[[ -f "$projects/$project/project.json" ]] || { echo "team:update: no project $project" >&2; exit 1; }
dir="$(readlink -f "$projects/$project")"

# The engines it runs, each file once.
execution="$(jq -r '.["execution-state-engine"] // empty' "$dir/project.json" 2>/dev/null || true)"
names="$( { for f in "$dir/engines"/*/state-engine.json; do [[ -f "$f" ]] && basename "$(dirname "$f")"; done
            if [[ -n "$execution" ]]; then echo "$execution"; connected_engines "$execution" "$project"; fi; } | sort -u)"
files="$(while IFS= read -r name; do [[ -n "$name" ]] && engine_path "$name" "$project" || true; done <<< "$names" | jq -Rsc 'split("\n") | map(select(. != ""))')"

file="$dir/team.json"
lock_on 8 "$file.lock" team:update "${JSON_LOCK_TIMEOUT:-30}"
out="$(jq -nc --arg dir "$dir" --argjson files "$files" --arg today "$(date +%F)" '{ dir: $dir, engineFiles: $files, today: $today }' | node "$here/update.js")"
if [[ "$(jq -r .changed <<< "$out")" == true ]]; then
  jq --indent 4 .team <<< "$out" | replace_file "$file"
fi
jq -r '.lines[]' <<< "$out"
