#!/usr/bin/env bash
# Description: Raise a fast-tracked "Rebuild golden-<project>" ticket for every project whose golden image is stale — vm:raise-golden-rebuilds; prints JSON.
set -euo pipefail

# ASS-149: check-health-v2's golden-image check. Every project with a
# golden-image in its project.json has its image read by vm:golden-stale. A
# current one is left alone. A stale one, with no open (not Done) off-board
# ticket titled "Rebuild golden-<project>" in the harness project's store
# (harness.json harness-project; the store every project's harness tickets go
# to), raises one: ticket:create --fast-track, the body
# golden-rebuild-ticket.md beside this file filled in — {project}, {why}
# (vm:golden-stale's, a bullet a line), {built-at} and {built-hash} ("never"
# and "none" for an image never built), {hash} — then 1 point
# (ticket:update-points). A ticket raised, or one open but not in the harness
# project's active sprint (its join failed: no sprint tracked work then,
# ASS-83), joins that sprint at committed (ticket:join-sprint), so control
# takes it ahead of everything (fast-track.js). While one is open for the
# image, no other is raised. The rebuild itself is the ticket's work (ASS-151).
# Prints a JSON array, a project a line in the projects folder's order:
#   { project, image, stale: false }   or
#   { project, image, stale: true, ticket: <key>, raised: <created now>, joined: <joined now> }
# Goes on past a project that fails (its stale check, its ticket or its join,
# each said on stderr) and exits 1 at the end when any did.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../sprint.bash"
source "$here/../ticket-system.bash"
agent="$here/../../../agent.sh"
template="$here/golden-rebuild-ticket.md"

[[ $# -eq 0 ]] || { echo "usage: vm:raise-golden-rebuilds" >&2; exit 1; }
harness="$(harness_project)"
[[ -n "$harness" ]] || { echo "vm:raise-golden-rebuilds: harness.json names no harness-project to raise tickets in" >&2; exit 1; }

failed=0
body="$(mktemp)" lines="$(mktemp)"
trap 'rm -f "$body" "$lines"' EXIT

# in_sprint <key> — the ticket is in the harness project's active sprint.
in_sprint() {
  local sprint
  sprint="$(sprint_file vm:raise-golden-rebuilds "$harness" 2>/dev/null)" || return 1
  jq -e --arg key "$1" 'any((.features, .bugs, .spikes) // [] | .[]; .key | ascii_upcase == $key)' "$sprint" >/dev/null
}

# raise <project> <vm:golden-stale's JSON> — the image's open ticket, raised when there is none, joined when not in the sprint; prints its line.
raise() {
  local project="$1" stale="$2" key raised=false joined=false
  key="$(off_board_run vm:raise-golden-rebuilds ticket:list "$harness" \
    | jq -r --arg title "Rebuild golden-$project" 'first(.[] | select(.title == $title and .status != "Done")) | .key // empty')" || return 1
  if [[ -z "$key" ]]; then
    jq -r -n --rawfile t "$template" --argjson s "$stale" '$t
      | gsub("\\{project\\}"; $s.project) | gsub("\\{why\\}"; $s.why | map("  - " + .) | join("\n"))
      | gsub("\\{built-at\\}"; $s["built-at"] // "never") | gsub("\\{built-hash\\}"; $s["built-hash"] // "none") | gsub("\\{hash\\}"; $s.hash)' > "$body"
    key="$(off_board_run vm:raise-golden-rebuilds ticket:create "$harness" Story "Rebuild golden-$project" "$body" --fast-track | jq -r .key)" || return 1
    off_board_run vm:raise-golden-rebuilds ticket:update-points "$harness" "$key" 1 >/dev/null || return 1
    raised=true
  fi
  if ! in_sprint "$key"; then
    if "$agent" ticket:join-sprint "$harness" "$key" committed >/dev/null; then joined=true; else failed=1; fi
  fi
  jq -c --arg key "$key" --argjson raised "$raised" --argjson joined "$joined" '{ project, image, stale } + { ticket: $key, raised: $raised, joined: $joined }' <<< "$stale"
}

for json in "$projects"/*/project.json; do
  project="$(basename "$(dirname "$json")")"
  jq -e '.["golden-image"].folder' "$json" >/dev/null 2>&1 || continue
  if ! stale="$("$agent" vm:golden-stale "$project")"; then failed=1; continue; fi
  if [[ "$(jq -r .stale <<< "$stale")" != true ]]; then
    jq -c '{ project, image, stale }' <<< "$stale"
  else
    raise "$project" "$stale" || { echo "vm:raise-golden-rebuilds: could not raise golden-$project's rebuild ticket" >&2; failed=1; }
  fi
done > "$lines"
jq -s . "$lines"
exit "$failed"
