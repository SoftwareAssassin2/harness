# The ticket system behind a project, for the agent-cli commands that write to
# it (through acli, the Atlassian CLI).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket-system.bash"
#   ticket_system <command> <project>   # "jira" when data/projects/<project>/project.json has a jira work-source, else ""
#   acli_run <command> <acli args…>     # runs acli, or says what it would run when ACLI_DISABLED=1 (tests)
#   home_project <command> <project> <key>   # the project the ticket lives in: an off-board key (the harness's own, ASS-n), the harness project's; any other, <project>
#   key_project <command> <key>              # the project whose own key prefix the key carries (an off-board key-prefix, or a Jira board's project key); nothing when none
#   story_point_scale <command> <project>    # the project's story-point scale, a JSON array (ASS-152)
#   story_points_field <command> <project>   # its Jira work source's story-points field (ASS-152)
#
# PROJECTS_DIR and HARNESS_FILE override the projects folder and harness.json, used by tests. Fails, naming
# <command>, on a project name that is not a single path segment.
ticket_system_projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/projects}"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/harness-project.bash"

ticket_system() {
  [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$1: invalid project '$2'" >&2; return 1; }
  jq -r 'if any(.["work-sources"][]?; .type == "jira") or (.["ticketing-system"].type? == "jira") then "jira" else "" end' \
    "$ticket_system_projects/$2/project.json" 2>/dev/null || true
}

acli_run() {
  local command="$1" arg shown="acli"
  shift
  if [[ "${ACLI_DISABLED:-}" == 1 ]]; then
    for arg in "$@"; do [[ "$arg" == *[[:space:]]* ]] && shown+=" \"$arg\"" || shown+=" $arg"; done
    echo "$command: ACLI_DISABLED, skipping: $shown" >&2
  else
    acli "$@"
  fi
}

# off_board_prefix <command> <project> — the key prefix of the project's
# off-board work source (its key-prefix), "" when it has none:
# a ticket whose key starts with "<prefix>-" is the harness's own, kept in
# src/off-board (see off-board.sh), and its status is written there.
off_board_prefix() {
  [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$1: invalid project '$2'" >&2; return 1; }
  jq -r 'first(.["work-sources"][]? | select(.type == "off-board") | (.["key-prefix"] // "")) // ""' \
    "$ticket_system_projects/$2/project.json" 2>/dev/null || true
}

# off_board_run <command> <off-board args…> — the repo's off-board.sh.
off_board_run() {
  shift
  "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../off-board.sh" "$@"
}

# set_offboard_description <command> <home> <key> <off-board-command> <tmp> —
# rewrite an off-board ticket's description and mirror it (ASS-180), shared by
# ticket:set-requirements and ticket:set-acceptance-criteria -. The caller
# holds the project's tickets.lock (sprint.bash lock_tickets, descriptor 3)
# across this, so the off-board write, the harness mirror and the history line
# are one transaction. Runs <off-board-command> <home> <key> <tmp> through
# off-board.sh (ticket:update-requirements or ticket:replace-acceptance-criteria),
# then, when the description changed, sets .description on the ticket in every
# file that lists it — the active sprint.json and backlog.json both (sync diffs
# by status, not list membership) — and appends one { at, field, from, to }
# line to work/<KEY>/requirements-history.jsonl (sync.sh's shape), so the next
# ticket:sync sees no change. An unchanged description leaves the .md as it was
# (its `updated` stamp untouched) and writes no mirror or history. Needs
# sprint.bash (projects, sprint_file) and json-file.bash (update_json,
# append_line) sourced. Calls update_json directly, never update_whole_ticket,
# which would re-take descriptor 3. Prints nothing. Fails, writing nothing,
# when the off-board write fails.
set_offboard_description() {
  local command="$1" home="$2" key="$3" offcmd="$4" tmp="$5"
  local before after from to md ckey backup sprint file at
  before="$(off_board_run "$command" ticket:get "$home" "$key")" || return 1
  from="$(jq -r '.description' <<< "$before")"
  md="$(jq -r '.file' <<< "$before")"
  ckey="$(jq -r '.key' <<< "$before")"
  backup="$(mktemp)"
  cp "$md" "$backup"
  off_board_run "$command" "$offcmd" "$home" "$key" "$tmp" >/dev/null || { rm -f "$backup"; return 1; }
  after="$(off_board_run "$command" ticket:get "$home" "$key")" || { rm -f "$backup"; return 1; }
  to="$(jq -r '.description' <<< "$after")"
  if [[ "$to" == "$from" ]]; then
    cp "$backup" "$md"; rm -f "$backup"; return 0
  fi
  rm -f "$backup"
  sprint="$(sprint_file "$command" "$home" 2>/dev/null)" || sprint=""
  for file in "$sprint" "$projects/$home/backlog.json"; do
    [[ -n "$file" && -f "$file" ]] || continue
    jq -e --arg k "$key" 'any((.features, .bugs, .spikes, .tickets) // [] | .[]; (.key // "" | ascii_downcase) == ($k | ascii_downcase))' "$file" >/dev/null 2>&1 || continue
    update_json "$file" --arg k "$key" --arg to "$to" '
      def upd: map(if (.key // "" | ascii_downcase) == ($k | ascii_downcase) then .description = $to else . end);
      (if has("features") then .features |= upd else . end)
      | (if has("bugs") then .bugs |= upd else . end)
      | (if has("spikes") then .spikes |= upd else . end)
      | (if has("tickets") then .tickets |= upd else . end)' || return 1
  done
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$projects/$home/work/$ckey"
  append_line "$projects/$home/work/$ckey/requirements-history.jsonl" \
    "$(jq -nc --arg at "$at" --arg from "$from" --arg to "$to" '{ at: $at, field: "description", from: $from, to: $to }')"
}

# off_board_home <project> — the project whose off-board work source serves
# <project>: itself when it has one, else the harness project (harness.json
# harness-project) when that has one; nothing otherwise.
off_board_home() {
  local harness
  if jq -e 'any(.["work-sources"][]?; .type == "off-board")' "$ticket_system_projects/$1/project.json" >/dev/null 2>&1; then echo "$1"; return; fi
  harness="$(harness_project)"
  [[ -n "$harness" ]] && jq -e 'any(.["work-sources"][]?; .type == "off-board")' "$ticket_system_projects/$harness/project.json" >/dev/null 2>&1 && echo "$harness"
  return 0
}

home_project() {
  local command="$1" project="$2" key home prefix
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  key="$(tr '[:lower:]' '[:upper:]' <<< "$3")"
  home="$(off_board_home "$project")"
  [[ -n "$home" ]] && prefix="$(off_board_prefix "$command" "$home")"
  if [[ -n "${prefix:-}" && "$key" == "$prefix-"* ]]; then echo "$home"; else echo "$project"; fi
}

key_project() {
  local command="$1" key file prefix
  key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
  prefix="${key%-*}"
  for file in "$ticket_system_projects"/*/project.json; do
    jq -e --arg p "$prefix" 'any(.["work-sources"][]?;
        (.type == "off-board" and ((.["key-prefix"] // "") | ascii_upcase) == $p)
        or (.type == "jira" and ((.url // "") | test("/projects/" + $p + "(/|$)"))))' "$file" >/dev/null 2>&1 \
      && { basename "$(dirname "$file")"; return 0; }
  done
  return 0
}

# story_point_scale <command> <project> — the points an estimate may take,
# a compact JSON array: project.json's story-point-scale (e.g.
# Fibonacci [1,2,3,5,8,13]) when it is a list of positive integers, else the
# harness's [1,2,3,5] (5 its split point, ASS-24).
story_point_scale() {
  [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$1: invalid project '$2'" >&2; return 1; }
  jq -c '.["story-point-scale"] | if type == "array" and length > 0 and all(.[]; type == "number" and . > 0 and . == floor) then . else error end' \
    "$ticket_system_projects/$2/project.json" 2>/dev/null || echo '[1,2,3,5]'
}

# story_points_field <command> <project> — the story-points custom field of
# the project's Jira work source (its story-points-field, e.g.
# customfield_10024), else Jira's default customfield_10016 — the downloader's
# (src/downloader/jira.js).
story_points_field() {
  [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$1: invalid project '$2'" >&2; return 1; }
  jq -r 'first(.["work-sources"][]? | select(.type == "jira") | .["story-points-field"] // empty) // "customfield_10016"' \
    "$ticket_system_projects/$2/project.json" 2>/dev/null || echo customfield_10016
}
