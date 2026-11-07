# Who may pause what (ASS-13): AI pauses only from inside a health check — a
# run whose chain of parents reaches the harness project's check-health
# trigger run, or a ticket's Blocked engine run — and only its own project,
# unless that health check is the harness project's (harness.json
# harness-project), which may pause anything.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../pause.bash"
#   pause_scope <command> <all|project>            # fails unless "all" or a project folder
#   health_check_of <command> <agent-name>         # { project, run } of the health check the agent works under; fails when none
#   may_pause <command> <agent-name> <all|project> # health_check_of, failing unless the scope is the agent's to pause
#
# ASSIGNMENTS_FILE, HARNESS_FILE and PROJECTS_DIR override the paths, used by tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/json-file.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/harness-project.bash"
pause_root="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.."
pause_assignments="${ASSIGNMENTS_FILE:-$pause_root/data/assignments.json}"
pause_projects="${PROJECTS_DIR:-$pause_root/data/projects}"

pause_scope() {
  [[ "$2" == all ]] && return 0
  [[ "$2" =~ ^[A-Za-z0-9_-]+$ && -f "$pause_projects/$2/project.json" ]] || { echo "$1: no project $2" >&2; return 1; }
}

health_check_of() {
  local command="$1" agent="$2" found
  jq -e --arg a "$agent" 'any(.assignments[]; .["agent-name"] == $a)' "$pause_assignments" >/dev/null || { echo "$command: no assignment for $agent" >&2; return 1; }
  # Up the agent's run's parents to the first that is a health check.
  found="$(jq -c --arg a "$agent" '
    (.["transient-state-engines"] // []) as $runs
    | (first(.assignments[] | select(.["agent-name"] == $a)) | .["transient-state-engine"]) as $start
    | def up($id; $seen): ($runs | map(select(.id == $id)) | first) as $r
        | if $r == null or ($seen | index($id)) then empty
          elif $r.parent.trigger == "check-health" or $r["state-engine"] == "blocked" then { project: $r.project, run: $r.id }
          else up($r.parent["transient-state-engine"]; $seen + [$id]) end;
    if $start == null then empty else up($start; []) end' "$pause_assignments")"
  [[ -n "$found" ]] || { echo "$command: $agent is on no health check; only a health check may pause" >&2; return 1; }
  echo "$found"
}

may_pause() {
  local command="$1" agent="$2" scope="$3" check project
  check="$(health_check_of "$command" "$agent")" || return 1
  project="$(jq -r .project <<< "$check")"
  is_harness_project "$project" || [[ "$scope" == "$project" ]] || { echo "$command: $agent, on a $project health check, may pause only $project" >&2; return 1; }
  echo "$check"
}
