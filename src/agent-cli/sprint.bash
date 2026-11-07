# Edits to one ticket, or one of its variations, in a project's active sprint,
# for the agent-cli commands that change a ticket. Writes go through
# update_json, so they are locked and atomic.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../sprint.bash"
#   update_variation <command> <project> <ticket-key> <variation> <state> [jq options…] '<filter>'
#   update_ticket    <command> <project> <ticket-key> <variation> <state> [jq options…] '<filter>'
#   update_ticket_at_detail <command> <project> <ticket-key> <variation> <step> [jq options…] '<filter>'
#   update_whole_ticket <command> <project> <ticket-key> [jq options…] '<filter>'
#   update_sprint    <command> <project> <ticket-key> [jq options…] '<filter>'
#   engine_steps     <command> <project>
#   sync_paired_status <command> <project> <ticket-key> <variation>
#   recheck_requirements <command> <project> <ticket-key>
#   variation_status <command> <project> <ticket-key> <variation>
#   lock_tickets     <command> <project>     # the project's tickets.lock, held on descriptor 3 until `exec 3>&-` or exit
#
# The sprint is data/projects/<project>/sprints/sprint-<n>/sprint.json, <n> the
# is-active entry of data/projects/<project>/sprints.json; PROJECTS_DIR overrides the
# projects folder, used by tests. The ticket key matches in any case; a
# soft-deleted variation (is-deleted) is as good as missing. <filter> rewrites
# the variation (update_variation) or the whole ticket (update_ticket); either
# way the variation must still be at <state> (its harness-status's state).
# update_ticket_at_detail rewrites the whole ticket too, the variation at
# <step> its detailed step instead (the deepest level of its status, its state
# when it has no sub-status: a step inside a sub-engine run, ASS-67); it
# cannot move_to, a run being moved by control.
# update_whole_ticket rewrites the ticket whatever its variations;
# update_sprint the whole sprint, the ticket found as $t, and same matching its
# key. $at is the
# time now, UTC. Fails, writing nothing, naming <command>, when the project,
# sprint, ticket or variation is missing or the variation is elsewhere.
#
# A filter may move a variation from <state> with move_to($to): its change into
# <state> gets work-is-done, a change to $to is appended (no agent dispatched,
# its work not yet done), harness-status becomes $to in the same state engine,
# any sub-status dropped, and its health
# (ai-feedback-short and -long) is cleared to null, being about the state left.
# The change appended is the variation's history (ASS-42): a sprint
# variation's state-changes in sprint.json are its path through the
# development engine, a backlog variation's in backlog.json (see backlog_too)
# its path through its refinement engine — two arrays of one shape, each entry
# naming its state-engine, nothing copied between them when the ticket joins
# the sprint. A move no step's exit made says why in an optional "cause":
# move_to takes it from MOVE_CAUSE, a JSON object the command sets in its
# environment — { "cause": "operator", "reason": <why> } for a TUI choice
# (ticket:human-review on a backlog ticket, the reason a rejection's) — and
# merges it into the change; ticket:sync's reset ("requirements-changed") and
# ticket:restart-refinement's ("migrated") write their own. A move an exit
# made carries none.
# After a move, sync_paired_status makes the ticket system follow: the
# ticket's ticket-system-status becomes the paired-ticket-system-status of the
# variation's step (in its state-engine) when that differs, through
# ticket:set-ticket-system-status, which says so on stdout; a step without
# one, or an engine not found, changes nothing. Only the top level pairs: a
# step inside a sub-engine takes its group step's (ASS-67). First, a variation
# now at its engine's done step (is-done) takes the ticket's worked-manually
# off (ASS-166, ticket:set-manual): a ticket done is no longer worked by hand,
# and its open non-blocking questions close as Assumed (ASS-248,
# question:close-assumed): it shipped on their assumptions.
#
# recheck_requirements <command> <project> <ticket-key> — the ticket's
# requirements have changed (a new description, ticket:take-new; an answer
# unlike the assumption the work went on, question:answer, ASS-248): each live
# variation of it in the active sprint whose current step (top level, in its
# state-engine or else the project's execution-state-engine) is flagged
# "recheck-on-requirements-change": true starts the requirements-changed
# workflow (ticket:requirements-changed, ASS-79); one at an unflagged step is
# left as it is. A start that fails is reported on stderr, naming <command>.
#
# A command that sets backlog_too=1 before sourcing this (ticket:change-state,
# ticket:human-review, assignments:create — ASS-144) edits a backlog ticket
# the same way: one the active sprint does not list but the project's
# backlog.json does is found and rewritten there (ticket_file), move_to and
# all; sync_paired_status then leaves it alone (refinement steps pair no
# status). refinement_engine <command> <project> prints the project's backlog
# refinement engine: the one its execution engine's backlog-refinement-steps
# runs; it fails, naming <command>, when there is none.
#
# variation_status prints where the variation stands (ASS-67, control's
# statusOf in bash): one "<engine>\t<state>" line per level of its
# harness-status, top first, each sub-status beneath; nothing without a
# state. Fails, naming <command>, when the ticket or variation is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/json-file.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/engine.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/projects}"

# engine_steps <command> <project> — the steps of the project's
# execution-state-engine (the project's own engine, else engines/'s:
# engine.bash's engine_path, ASS-276) as a JSON array, [] when it has none.
engine_steps() {
  local command="$1" project="$2" engine file
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json" 2>/dev/null || true)"
  if [[ -n "$engine" ]] && file="$(engine_path "$engine" "$project")"; then
    jq -c '.steps // []' "$file"
  else
    echo '[]'
  fi
}

refinement_engine() {
  local command="$1" project="$2" engine name="" file
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json" 2>/dev/null || true)"
  [[ -n "$engine" ]] && file="$(engine_path "$engine" "$project")" && name="$(jq -r 'first(.["backlog-refinement-steps"] // [] | .[] | .action.engine // empty) // empty' "$file")"
  [[ -n "$name" ]] || { echo "$command: $project's execution engine names no backlog refinement engine" >&2; return 1; }
  echo "$name"
}

# lists <file> <ticket-key> — whether the sprint or backlog file lists the ticket, its key in any case.
lists() { jq -e --arg key "$2" 'any((.features, .bugs, .spikes, .tickets) // [] | .[]; .key | ascii_downcase == ($key | ascii_downcase))' "$1" >/dev/null 2>&1; }

# ticket_file <command> <project> <ticket-key> — the file the ticket is edited
# in: the active sprint's sprint.json; or, with backlog_too set, the project's
# backlog.json when the sprint does not list the ticket and the backlog does.
# Fails as sprint_file does otherwise.
ticket_file() {
  local command="$1" project="$2" ticket="$3" sprint backlog
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  if [[ -n "${backlog_too:-}" ]]; then
    sprint="$(sprint_file "$command" "$project" 2>/dev/null)" || sprint=""
    backlog="$projects/$project/backlog.json"
    if ! { [[ -n "$sprint" ]] && lists "$sprint" "$ticket"; } && [[ -f "$backlog" ]] && lists "$backlog" "$ticket"; then echo "$backlog"; return 0; fi
  fi
  sprint_file "$command" "$project"
}

# in_backlog <command> <project> <ticket-key> — whether the ticket is edited in the backlog (ticket_file).
in_backlog() { [[ "$(ticket_file "$@" 2>/dev/null)" == */backlog.json ]]; }

# sprint_file <command> <project> — the project's active sprint.json; fails when there is no active sprint.
sprint_file() {
  local command="$1" project="$2" number
  # The project becomes a path segment, so it may not climb out of the projects folder.
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  number="$(jq -r 'first(.list[] | select(.["is-active"]) | .number) // empty' "$projects/$project/sprints.json")"
  [[ -n "$number" ]] || { echo "$command: project '$project' has no active sprint" >&2; return 1; }
  echo "$projects/$project/sprints/sprint-$number/sprint.json"
}

variation_status() {
  local command="$1" project="$2" ticket="$3" variation="$4" file
  file="$(sprint_file "$command" "$project")" || return 1
  jq -r --arg key "$ticket" --arg name "$variation" --arg command "$command" '
    (first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase))) // null) as $t
    | if $t == null then error("\($command): no \($key) in the active sprint") else . end
    | ($t.variations // [] | map(select(.name == $name and (.["is-deleted"] | not))) | first) as $v
    | if $v == null then error("\($command): no \($key) variation \($name)") else . end
    | $v["harness-status"] | recurse(.["sub-status"] // empty) | select(.state != null) | "\(.["state-engine"] // "")\t\(.state)"' "$file"
}

sync_paired_status() {
  local command="$1" project="$2" ticket="$3" variation="$4" file state engine current paired
  ! in_backlog "$command" "$project" "$ticket" || return 0
  file="$(sprint_file "$command" "$project")" || return 1
  IFS=$'\t' read -r engine state < <(variation_status "$command" "$project" "$ticket" "$variation" 2>/dev/null | head -n 1) || true
  current="$(jq -r --arg key "$ticket" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase))) | .["ticket-system-status"] // ""' "$file")"
  [[ -n "$state" && -n "$engine" ]] || return 0
  if engine_steps_of "$command" "$engine" "$project" 2>/dev/null | jq -e --arg id "$state" 'any(.[]; .id == $id and .["is-done"] == true)' >/dev/null 2>&1; then
    update_whole_ticket "$command" "$project" "$ticket" 'del(.["worked-manually"])'
    "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/question/close-assumed.sh" "$project" "$ticket" > /dev/null
  fi
  paired="$(engine_steps_of "$command" "$engine" "$project" 2>/dev/null | jq -r --arg id "$state" 'first(.[] | select(.id == $id) | .["paired-ticket-system-status"] // empty) // empty' 2>/dev/null || true)"
  [[ -n "$paired" && "$paired" != "$current" ]] || return 0
  "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/ticket/set-ticket-system-status.sh" "$project" "$ticket" "$paired"
  echo "$command: $ticket ticket system status → $paired"
}

recheck_requirements() {
  local command="$1" project="$2" ticket="$3" file default key name engine state flagged
  file="$(sprint_file "$command" "$project")" || return 1
  default="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json" 2>/dev/null || true)"
  while IFS=$'\t' read -r key name engine state; do
    flagged="$(engine_steps_of "$command" "${engine:-$default}" "$project" 2>/dev/null \
      | jq -r --arg id "$state" 'any(.[]; .id == $id and .["recheck-on-requirements-change"] == true)' 2>/dev/null || true)"
    [[ "$flagged" == true ]] || continue
    "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/ticket/requirements-changed.sh" "$project" "$key" "$name" \
      || echo "$command: could not start the requirements-changed workflow for $key.$name" >&2
  done < <(jq -r --arg key "$ticket" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
    | .key as $k | .variations // [] | .[] | select(.["is-deleted"] | not)
    | [$k, .name, .["harness-status"]["state-engine"] // "", .["harness-status"].state // ""] | @tsv' "$file")
}

update_variation() {
  local filter="${*: -1}"
  update_ticket "${@:1:$#-1}" ".variations |= map(if .name == \$name then ($filter) else . end)"
}

update_ticket() {
  local command="$1" project="$2" ticket="$3" variation="$4" state="$5" cause='{}'
  shift 5
  [[ -z "${MOVE_CAUSE:-}" ]] || cause="$MOVE_CAUSE"
  edit_ticket "$command" "$project" "$ticket" '
    ($t.variations // [] | map(select(.name == $name and (.["is-deleted"] | not))) | first) as $v
    | if $v == null then error("\($command): no \($key) variation \($name)")
      elif $v["harness-status"].state != $state then error("\($command): \($key).\($name) is not at \($state)")
      else . end' --arg name "$variation" --arg state "$state" --argjson cause "$cause" "${@:1:$#-1}" '
    def move_to($to):
      .["harness-status"] = { state: $to, "state-engine": .["harness-status"]["state-engine"] }
      | .["ai-feedback-short"] = null | .["ai-feedback-long"] = null
      | .["state-changes"] = ((.["state-changes"] // [])
          | if length > 0 and .[-1]["to-state"] == $state then .[-1]["work-is-done"] = true else . end)
        + [{ "state-engine": .["harness-status"]["state-engine"], "from-state": $state, "to-state": $to, timestamp: $at, "agent-dispatch-log": [], "work-is-done": false } + $cause];
    '"${*: -1}"
}

update_ticket_at_detail() {
  local command="$1" project="$2" ticket="$3" variation="$4" state="$5"
  shift 5
  edit_ticket "$command" "$project" "$ticket" '
    ($t.variations // [] | map(select(.name == $name and (.["is-deleted"] | not))) | first) as $v
    | if $v == null then error("\($command): no \($key) variation \($name)")
      elif ([$v["harness-status"] | recurse(.["sub-status"] // empty) | .state] | last) != $state then error("\($command): \($key).\($name) is not at \($state)")
      else . end' --arg name "$variation" --arg state "$state" "$@"
}

update_whole_ticket() {
  local command="$1" project="$2" ticket="$3"
  shift 3
  edit_ticket "$command" "$project" "$ticket" '.' "$@"
}

update_sprint() {
  local command="$1" project="$2" ticket="$3"
  shift 3
  edit_sprint "$command" "$project" "$ticket" '.' "$@"
}

# edit_ticket <command> <project> <ticket-key> <check> [jq options…] '<filter>'
# — update_ticket and update_whole_ticket: <check> runs first, the ticket
# found as $t; <filter> rewrites the ticket.
edit_ticket() {
  local filter="${*: -1}"
  edit_sprint "${@:1:$#-1}" "(if has(\"tickets\") then .tickets else (.features, .bugs, .spikes) end) |= (if . == null then . else map(
      if .key | same then ($filter) else . end
    ) end)"
}

# edit_sprint <command> <project> <ticket-key> <check> [jq options…] '<filter>'
# — all of the above: <check> runs first, the ticket found as $t; <filter>
# rewrites the sprint. The file (ticket_file) is chosen and written inside
# the project's tickets.lock (ASS-174, descriptor 3), the lock ticket:sync and
# sprint:advance take before choosing theirs: a ticket joining the sprint, or
# a sprint closing, lands wholly before the choice or after the write. Always
# taken before a file's update_json lock, never while one is held.
edit_sprint() {
  local command="$1" project="$2" ticket="$3" check="$4"
  shift 4
  local filter="${*: -1}" options=("${@:1:$#-1}") file status=0
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  lock_tickets "$command" "$project" || return 1
  file="$(ticket_file "$command" "$project" "$ticket")" || { exec 3>&-; return 1; }

  update_json "$file" \
    --arg key "$ticket" --arg command "$command" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${options[@]+"${options[@]}"} "
    def same: ascii_downcase == (\$key | ascii_downcase);
    (first((.features, .bugs, .spikes, .tickets) // [] | .[] | select(.key | same)) // null) as \$t
    | if \$t == null then error(\"\(\$command): no \(\$key) in the active sprint\") else . end
    | ($check)
    | ($filter)" || status=1
  exec 3>&-
  return $status
}

# lock_tickets <command> <project> — the project's tickets.lock (ASS-174),
# taken by every writer that chooses the active sprint (or the backlog) before
# it chooses (edit_sprint, ticket:sync, sprint:advance; ticket:delete,
# ticket:restore, ticket:restart-refinement, transient-state-engine:create —
# ASS-179), so a sprint closing lands wholly before the choice or after the
# write. Held on descriptor 3 until `exec 3>&-` or exit; never taken while an
# update_json lock is held, nor while running a command that takes it.
lock_tickets() {
  [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$1: invalid project '$2'" >&2; return 1; }
  lock_on 3 "$projects/$2/tickets.lock" "$1" "${JSON_LOCK_TIMEOUT:-30}"
}
