#!/usr/bin/env bash
# Description: Set or remove a project's share of the Mac's memory and CPU budget, a percentage 0–100 (ASS-528; unset shares split what the set ones leave); refuses one that would make the set shares add up to over 100 — project:set-share <project> <percent|none>.
set -euo pipefail

# ASS-546 AC1: writes data/projects/<project>/project.json's `share`
# (PROJECTS_DIR overrides the projects folder, used by tests), or with `none`
# removes it, so the project takes an equal split of what the set shares leave
# (seat-budget.js resolveShares). Control rereads it every tick. A share is a
# number from 0 to 100; the projects' set shares, this one's new value
# included, may add up to at most 100: control would scale them down, but a
# sum over 100 is a mistake, so it is refused here, naming every project with
# a share and its value. Every project.json is read for the sum; .shares.lock
# beside the projects folder (data/.shares.lock: not in it, where every entry
# is read as a project), taken by this command alone (the only writer of
# `share`), keeps two of these runs from each passing the check on
# what the other is about to change; the project's own project.json.lock is
# held from its read to its write (seat-settings.bash). Prints
# "<project>: share <before> → <after>" and the set shares' new total. Fails,
# writing nothing, on an unknown project, a bad value, or a sum over 100.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../seat-settings.bash"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"

command=project:set-share
[[ $# -eq 2 ]] || { echo "usage: $command <project> <percent|none>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
project="$1" value="$2"
[[ "$value" == none ]] || ss_percent "$command" "the share" "$value" 0

lock_on 8 "$(dirname "$(readlink -f "$projects")")/.shares.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}" || exit 1
ss_lock "$command" "$projects/$project/project.json"

# Every other project's set share (a number from 0 to 100; control ignores anything else), then this one's new value.
others='[]'
for other in "$projects"/*/project.json; do
  [[ -e "$other" ]] || continue
  id="$(basename "$(dirname "$other")")"
  [[ "$id" == "$project" ]] && continue
  share="$(jq -c '.share | if type == "number" and . >= 0 and . <= 100 then . else null end' "$other" 2>/dev/null || echo null)"
  [[ "$share" == null ]] || others="$(jq -c --arg id "$id" --argjson s "$share" '. + [{ id: $id, share: $s }]' <<< "$others")"
done
new="$([[ "$value" == none ]] && echo null || jq -n --argjson v "$value" '$v')"
all="$(jq -c --arg id "$project" --argjson s "$new" 'if $s == null then . else . + [{ id: $id, share: $s }] end | sort_by(.id)' <<< "$others")"
total="$(jq '[.[].share] | add // 0' <<< "$all")"
named="$(jq -r 'map("\(.id) \(.share)") | join(", ")' <<< "$all")"
if [[ "$(jq -n --argjson t "$total" '$t > 100')" == true ]]; then
  echo "$command: $project's share $value would make the projects' set shares add up to $total, over 100: $named; nothing written" >&2
  exit 1
fi

before="$(ss_shown "$(jq -c '.share' "$file")")"
if [[ "$new" == null ]]; then write_json "$file" 'del(.share)'; else write_json "$file" --argjson s "$new" '.share = $s'; fi
exec 9>&- 8>&-
after="$([[ "$new" == null ]] && echo unset || echo "$new")"
echo "$project: share $before → $after (set shares add up to $total${named:+: $named})"
