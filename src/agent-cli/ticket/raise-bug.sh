#!/usr/bin/env bash
# Description: Raise a bug in a Jira project, assigned to me, in the board's active sprint, at To Do and the project's bug priority — ticket:raise-bug <project> "<summary>" <adf-description-file> [Bug|Story].
set -euo pipefail

# The one way the harness raises a ticket in a Jira project (ASS-164): the
# create-ticket-grouped prompt calls it. <project> is a data/projects folder
# with a jira work source (its board url gives the project key and board id);
# the description is ADF JSON. Steps, through acli (behaviour verified live
# 2026-10-27, raising a live bug):
#   1. the board's active sprint:  acli jira board list-sprints --id <board> --state active --json
#   2. create, in that sprint (the work source's sprint-field, else Jira
#      Cloud's customfield_10020; some sites' is customfield_10021) at
#      project.json's raised-bug-priority (e.g. "Critical"; none set, the
#      scheme's default), both through additionalAttributes:
#        acli jira workitem create --from-json <file>
#      A create refused with a priority is retried once without it — the
#      priority must exist in the project's scheme (some schemes reject "Blocker") —
#      and the fallback is logged.
#   3. assign to the signed-in user, by an edit: --from-json ignores
#      "assignee": "@me" (the ticket goes to the project's default assignee):
#        acli jira workitem edit --key <K> --assignee @me --yes
#   4. a new bug starts at Backlog:
#        acli jira workitem transition --key <K> --status "To Do" --yes
#   5. read back: status, priority and sprint by
#        acli jira workitem view <K> --fields status,priority,<sprint-field> --json
#      the assignee by `key = <K> AND assignee = currentUser()`.
# Prints { key, priority } (priority the one asked for and set, null when the
# scheme's default). Fails, naming the ticket's key and each thing still
# unset, when a step after the create did not take — the key still printed,
# so the ticket is never a silent partial one; fails with no key when the
# create itself does.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../ticket-system.bash"

command=ticket:raise-bug
[[ $# -eq 3 || $# -eq 4 ]] || { echo "usage: $command <project> \"<summary>\" <adf-description-file> [Bug|Story]" >&2; exit 1; }
project="$1" summary="$2" description="$3" type="${4:-Bug}"
[[ "$type" == Bug || "$type" == Story ]] || { echo "$command: type is Bug or Story, not '$type'" >&2; exit 1; }
[[ -f "$description" ]] || { echo "$command: no file $description" >&2; exit 1; }
jq -e 'type == "object"' "$description" >/dev/null 2>&1 || { echo "$command: $description is not ADF JSON" >&2; exit 1; }
[[ "$(ticket_system "$command" "$project")" == jira ]] || { echo "$command: $project has no jira work source" >&2; exit 1; }

config="$ticket_system_projects/$project/project.json"
url="$(jq -r 'first(.["work-sources"][]? | select(.type == "jira") | .url) // ""' "$config")"
[[ "$url" =~ /projects/([A-Za-z][A-Za-z0-9_]*)/boards/([0-9]+) ]] || { echo "$command: $project's jira work source is not a board url: $url" >&2; exit 1; }
key_prefix="${BASH_REMATCH[1]}" board="${BASH_REMATCH[2]}"
sprint_field="$(jq -r 'first(.["work-sources"][]? | select(.type == "jira") | .["sprint-field"] // empty) // "customfield_10020"' "$config")"
priority="$(jq -r '.["raised-bug-priority"] // empty' "$config")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unset_items=()

sprint="$(acli_run "$command" jira board list-sprints --id "$board" --state active --json 2>"$work/err" \
  | jq -r '(if type == "array" then . else (.sprints // .values // []) end)
           | first(.[] | select(((.state // "active") | ascii_downcase) == "active") | .id) // empty' 2>/dev/null || true)"
[[ -n "$sprint" ]] || echo "$command: no active sprint found on board $board: $(cat "$work/err")" >&2

# create <priority or ""> — the ticket's key, from acli's "Work item <K> created".
create() {
  jq --arg project "$key_prefix" --arg type "$type" --arg summary "$summary" --arg field "$sprint_field" \
     --arg sprint "$sprint" --arg priority "$1" --slurpfile d "$description" -n '
    { projectKey: $project, type: $type, summary: $summary, description: $d[0],
      additionalAttributes: ({}
        + (if $sprint != "" then { ($field): ($sprint | tonumber) } else {} end)
        + (if $priority != "" then { priority: { name: $priority } } else {} end)) }' > "$work/create.json"
  acli_run "$command" jira workitem create --from-json "$work/create.json" 2>"$work/err" \
    | grep -oE "$key_prefix-[0-9]+" | head -1 || true
}
key="$(create "$priority")"
if [[ -z "$key" && -n "$priority" ]]; then
  echo "$command: $project's scheme refused priority $priority ($(cat "$work/err")); raising at the scheme's default" >&2
  priority=""
  key="$(create "")"
fi
[[ -n "$key" ]] || { echo "$command: acli created no ticket in $key_prefix: $(cat "$work/err")" >&2; exit 1; }

acli_run "$command" jira workitem edit --key "$key" --assignee @me --yes >/dev/null 2>"$work/err" \
  || echo "$command: $key: assigning to @me failed: $(cat "$work/err")" >&2
acli_run "$command" jira workitem transition --key "$key" --status "To Do" --yes >/dev/null 2>"$work/err" \
  || echo "$command: $key: moving to To Do failed: $(cat "$work/err")" >&2

# Read the ticket back: each thing asked for and not shown is still unset.
view="$(acli_run "$command" jira workitem view "$key" --fields "status,priority,$sprint_field" --json 2>/dev/null || true)"
field() { jq -r "(if type == \"array\" then first(.[]) else . end) | .fields | $1" <<< "$view" 2>/dev/null || true; }
mine="$(acli_run "$command" jira workitem search --jql "key = $key AND assignee = currentUser()" --fields key --json 2>/dev/null || true)"
jq -e --arg k "$key" 'any(.. | objects; .key? == $k)' <<< "$mine" >/dev/null 2>&1 || unset_items+=("assignee (not the signed-in user)")
[[ -z "$sprint" ]] && unset_items+=("sprint (no active sprint on board $board)")
[[ -n "$sprint" && "$(field "[.[\"$sprint_field\"][]? | .id? // .] | any(tostring == \"$sprint\")")" != true ]] && unset_items+=("sprint ($sprint_field $sprint)")
[[ "$(field '.status.name // ""')" == "To Do" ]] || unset_items+=("status (To Do)")
[[ -n "$priority" && "$(field '.priority.name // ""')" != "$priority" ]] && unset_items+=("priority ($priority)")

jq -nc --arg k "$key" --arg p "$priority" '{ key: $k, priority: (if $p == "" then null else $p end) }'
if [[ ${#unset_items[@]} -gt 0 ]]; then
  echo "$command: $key was raised but is still unset: $(IFS=,; echo "${unset_items[*]}" | sed 's/,/, /g')" >&2
  exit 1
fi
