# Composing what an agent is sent, for the agent-cli commands that do
# (agent:*, agent-interaction:send-message): the agent's assignment record, the
# engine's prompt templates, the placeholders filled, and the commands the
# templates name.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../prompt.bash"
#   assignment_of <command> <agent-name>                      # the record, as JSON; fails when there is none
#   template <command> <record-json> <key> <fallback-folder>  # the template the record's engine names by <key>
#   fill <text> <placeholder> <value>                         # <text> with every {<placeholder>} replaced, literally
#   fill_ticket <text> <record-json>                          # {code-scope}, {merge-request-title}, {numbered-files}, {ticket}, {project}, {variation}, {ticket-folder}, {project-folder}, {harness-folder}, {project-code-folder}, {agent-sh} from the record
#   fill_commands <text> <agent-name>                         # {status-update-command} and {approve-command} for the agent
#   approve_command <agent-name>                              # the command the agent approves with
#   persona_of <prompt-folder>                                # the persona prompts/<folder>/prompt.json names; nothing when none
#
# A template is prompts/<folder>/prompt.txt, the folder named by <key> (a
# top-level "*-prompt" key, such as receive-dispatch-prompt) in the record's
# state-engine — its engine, before any "/<list>" — else in the project's
# execution-state-engine, else <fallback-folder>. A persona is
# personas/<persona>.md. Commands are rendered with the repo root's agent.sh by
# absolute path, so an agent runs them from any folder; so is {agent-sh}, and
# {ticket-folder} is the ticket's work folder, data/projects/<project>/work/<ticket>,
# by absolute path, made if missing — agents run in the project's checkout,
# never here (empty for a record without a ticket); {project-folder} is
# data/projects/<project> (the harness's data folder for it) and {harness-folder}
# this repo, both absolute; {project-code-folder} the project's code for the
# ticket — set by agent:dispatch from control (the VM's /repos/<repo>/, else
# the worktree or workspace), as $project_code_folder — and {code-scope} the
# shared preamble saying whose code that is (code_scope). PROMPTS_DIR,
# PERSONAS_DIR and PROJECTS_DIR override the folders, used by tests; $agent_sh
# and $ticket_folder, set after sourcing, stand in for {agent-sh} and
# {ticket-folder} (agent:dispatch, for an agent in a VM), and $ticket_project
# for the ticket's project when it is not the record's (a harness run about
# another project's ticket, ASS-204); inbox.bash
# and engine.bash, sourced here, take ASSIGNMENTS_FILE, AGENTS_DIR and
# ENGINES_DIR. Fails, naming <command>, when the record or the template is
# missing.
here_prompt="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here_prompt/inbox.bash"
source "$here_prompt/json-file.bash"
source "$here_prompt/engine.bash"
source "$here_prompt/ticket-system.bash"
source "$here_prompt/harness-project.bash"
source "$here_prompt/merge-request-title.bash"
source "$here_prompt/numbered-files.bash"
prompts_dir="${PROMPTS_DIR:-$here_prompt/../../prompts}"
personas_dir="${PERSONAS_DIR:-$here_prompt/../../personas}"
prompt_projects_dir="${PROJECTS_DIR:-$here_prompt/../../data/projects}"
harness_root="$(cd "$here_prompt/../.." && pwd)"
agent_sh="$harness_root/agent.sh"

# bash 5.2+ would put the match where a value has "&": the value goes in as it is.
shopt -u patsub_replacement 2>/dev/null || true

assignment_of() {
  local record
  record="$(jq -c --arg name "$2" 'first(.assignments[] | select(.["agent-name"] == $name)) // empty' "$assignments_file")"
  [[ -n "$record" ]] || { echo "$1: no assignment for $2" >&2; return 1; }
  echo "$record"
}

# engine_key <engine-name> <key> [<project>] — the key's value in the engine's
# state-engine.json, the project's own engine first (ASS-276); empty when the
# engine or the key is missing.
engine_key() {
  local file
  file="$(engine_path "${1%%/*}" "${3:-}")" || return 0
  jq -r --arg key "$2" '.[$key] // empty' "$file"
}

template() {
  local command="$1" record="$2" key="$3" fallback="$4" folder project
  project="$(jq -r '.project // empty' <<< "$record")"
  folder="$(engine_key "$(jq -r '.["state-engine"] // empty' <<< "$record")" "$key" "$project")"
  if [[ -z "$folder" ]]; then
    if [[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$prompt_projects_dir/$project/project.json" ]]; then
      folder="$(engine_key "$(jq -r '.["execution-state-engine"] // empty' "$prompt_projects_dir/$project/project.json")" "$key" "$project")"
    fi
  fi
  folder="${folder:-$fallback}"
  [[ "$folder" =~ ^[A-Za-z0-9_-]+$ && -f "$prompts_dir/$folder/prompt.txt" ]] || { echo "$command: no prompt template $folder" >&2; return 1; }
  cat "$prompts_dir/$folder/prompt.txt"
}

fill() { local text="$1"; printf '%s' "${text//"{$2}"/$3}"; }

# run_root <run-id> — the run its parents lead up to (itself when it has none), by id.
run_root() {
  jq -r --arg id "$1" '."transient-state-engines" // [] | . as $runs
    | def up($r): (first($runs[] | select(.id == $r.parent["transient-state-engine"])) // null) as $p | if $p == null then $r.id else up($p) end;
    (first(.[] | select(.id == $id)) // null) as $r | if $r == null then $id else up($r) end' "$assignments_file"
}

# ticket_home <command> <project> <ticket> — the project whose data folder
# holds the ticket's work: <project>'s (an off-board ticket's, the harness's:
# home_project), but $ticket_project's for a run about another project's
# ticket (ASS-204) — unless its key says it is <project>'s own (the fix ticket
# the run made).
ticket_home() {
  local project
  project="$(home_project "$1" "$2" "$3")"
  if [[ "${ticket_project:-}" =~ ^[A-Za-z0-9_-]+$ && "$(key_project "$1" "$3")" != "$project" ]]; then echo "$ticket_project"; else echo "$project"; fi
}

# work_folder <record-json> — the record's folder in the harness, absolute,
# made if missing: data/projects/<project>/work/<ticket> for a ticket's work, else
# data/projects/<project>/work/run-<root run id> for a run's (a health check's
# reports wait there for the ticket they lead to); empty for neither. The
# ticket's <project> is ticket_home's.
work_folder() {
  local record="$1" ticket project run
  ticket="$(jq -r '.["work-item"] // ""' <<< "$record")"
  project="$(jq -r '.project // ""' <<< "$record")"
  run="$(jq -r '.["transient-state-engine"] // ""' <<< "$record")"
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  if [[ "$ticket" =~ ^[A-Za-z0-9_.-]+$ ]]; then project="$(ticket_home work_folder "$project" "$ticket")"
  elif [[ "$run" =~ ^[0-9a-f-]+$ ]]; then ticket="run-$(run_root "$run")"
  else return 0; fi
  if [[ "$ticket" == run-* ]]; then   # a run's folder is made under its lock (ASS-179), as ticket:adopt-run-folder moves it
    mkdir -p "$prompt_projects_dir/$project/work"
    lock_on 5 "$prompt_projects_dir/$project/work/$ticket.lock" work_folder "${JSON_LOCK_TIMEOUT:-30}" || return 1
    mkdir -p "$prompt_projects_dir/$project/work/$ticket"
    exec 5>&-
  else
    mkdir -p "$prompt_projects_dir/$project/work/$ticket"
  fi
  echo "$(cd "$prompt_projects_dir" && pwd)/$project/work/$ticket"
}

# write_ticket_json <record-json> — the record's ticket as it stands now —
# its fields and the record's variation, or for a record without one (a fix
# ticket's agent) its first live one (as "variation", the others left out)
# — written to its work folder's ticket.json, from the project's active
# sprint or else its backlog; nothing for a record without a ticket or one
# found in neither, or of another project (ticket_home: its own agents keep
# it). A temp file renamed over the last one. Written on dispatch alone, it
# says so (ASS-240): its "snapshot" names when, and that the active sprint
# has the ticket as it stands later.
write_ticket_json() {
  local record="$1" ticket project variation folder sprint number json
  ticket="$(jq -r '.["work-item"] // ""' <<< "$record")"
  project="$(jq -r '.project // ""' <<< "$record")"
  variation="$(jq -r '.variation // ""' <<< "$record")"
  [[ "$ticket" =~ ^[A-Za-z0-9_.-]+$ && "$project" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  project="$(home_project write_ticket_json "$project" "$ticket")"
  [[ "$(ticket_home write_ticket_json "$project" "$ticket")" == "$project" ]] || return 0
  folder="$(work_folder "$record")"
  number="$(jq -r 'first(.list[]? | select(.["is-active"]) | .number) // empty' "$prompt_projects_dir/$project/sprints.json" 2>/dev/null || true)"
  sprint="$prompt_projects_dir/$project/sprints/sprint-$number/sprint.json"
  local files=()
  [[ -n "$number" && -f "$sprint" ]] && files+=("$sprint")
  [[ -f "$prompt_projects_dir/$project/backlog.json" ]] && files+=("$prompt_projects_dir/$project/backlog.json")
  [[ ${#files[@]} -gt 0 ]] || return 0
  json="$(jq -cs --arg key "$ticket" --arg name "$variation" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    first(.[] | (.features, .bugs, .spikes, .tickets) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
    | del(.variations) + { variation: (first(.variations // [] | .[] | select(if $name == "" then (.["is-deleted"] | not) else .name == $name end)) // null),
      snapshot: "Written at \($at), when an agent was last dispatched on the ticket; not rewritten as it moves on: its step, ticket system status and merge requests now are in the project'"'"'s active sprint." }' "${files[@]}")"
  [[ -n "$json" && "$json" != null ]] || return 0
  jq . <<< "$json" | replace_file "$folder/ticket.json"
}

fill_ticket() {
  local text="$1" record="$2" ticket project variation folder scope format rules
  ticket="$(jq -r '.["work-item"] // ""' <<< "$record")"
  project="$(jq -r '.project // ""' <<< "$record")"
  variation="$(jq -r '.variation // ""' <<< "$record")"
  folder="${ticket_folder:-$(work_folder "$record")}"
  # The shared preamble first, its own placeholders then filled with the rest; left out with its blank line when empty.
  scope="$(code_scope "$record")"
  [[ -n "$scope" ]] || text="${text//"{code-scope}"$'\n\n'/}"
  text="$(fill "$text" code-scope "$scope")"
  # The project's merge request title format (ASS-219, merge-request-title.bash), asked only of a text that names it.
  if [[ "$text" == *"{merge-request-title}"* ]]; then
    format="$(title_format fill_ticket "$prompt_projects_dir/$project/project.json")" || return 1
    text="$(fill "$text" merge-request-title "$(title_rule "$format")")"
  fi
  # The project's numbered files (ASS-385, numbered-files.bash), asked only of a text that names them.
  if [[ "$text" == *"{numbered-files}"* ]]; then
    rules="$(numbered_rules fill_ticket "$prompt_projects_dir/$project/project.json")" || return 1
    text="$(fill "$text" numbered-files "$(numbered_rule_text "$rules")")"
  fi
  text="$(fill "$text" ticket "$ticket")"
  text="$(fill "$text" project "$project")"
  text="$(fill "$text" variation "$variation")"
  text="$(fill "$text" ticket-folder "$folder")"
  # The project's folder in the harness (its project.json, health reports), absolute: agents run in the project's checkout.
  [[ ! "$project" =~ ^[A-Za-z0-9_-]+$ ]] || text="$(fill "$text" project-folder "$(cd "$prompt_projects_dir" && pwd)/$project")"
  text="$(fill "$text" harness-folder "$harness_root")"
  text="$(fill "$text" project-code-folder "${project_code_folder:-}")"
  fill "$text" agent-sh "$agent_sh"
}

# code_scope <record-json> — the shared preamble (ASS-106), with the
# placeholders fill_ticket fills: whose code the ticket changes — the harness
# itself on a ticket of the harness project (harness-project.bash; a fix
# ticket's home project), else the project's code alone, the harness read-only
# context; and the harness's data, the ticket's folder among it, changed only
# through agent.sh (ASS-182). Nothing for a record without a ticket, or with no code location.
code_scope() {
  local ticket project
  ticket="$(jq -r '.["work-item"] // ""' <<< "$1")"
  project="$(jq -r '.project // ""' <<< "$1")"
  [[ -n "$ticket" && -n "${project_code_folder:-}" && "$project" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  if is_harness_project "$(home_project code_scope "$project" "$ticket")"; then
    printf '%s' "Whose code: {ticket} is a harness ticket: you are changing the harness itself. Its code for this ticket is {project-code-folder}: make every change there. "
    if [[ "$project_code_folder" == "$harness_root" ]]; then printf '%s' "The harness that runs you is this same checkout, {harness-folder}."
    else printf '%s' "The harness that runs you is at {harness-folder} on the host: never change that copy — it is not this ticket's."; fi
  else
    printf '%s' "Whose code: {ticket} is {project}'s ticket, not the harness's. Its code is {project-code-folder}: every code change belongs there and nowhere else. The harness that runs you, at {harness-folder} on the host, is read-only context: read it if it helps, never change it."
  fi
  printf '%s' " The harness's data folder for {project} — its project.json, sprints and reports — is {project-folder}: read it, and the ticket's folder {ticket-folder}, as you need; change either only through the agent.sh commands you are given, the content on stdin."
}

approve_command() { echo "$agent_sh assignments:approve $1"; }

fill_commands() {
  local text
  text="$(fill "$1" status-update-command "$agent_sh assignments:status-update $2 \"<your update>\"")"
  fill "$text" approve-command "$(approve_command "$2")"
}

persona_of() {
  local persona
  [[ -f "$prompts_dir/$1/prompt.json" ]] || return 0
  persona="$(jq -r '.persona // empty' "$prompts_dir/$1/prompt.json")"
  [[ "$persona" =~ ^[A-Za-z0-9_-]+$ && -f "$personas_dir/$persona.md" ]] || return 0
  cat "$personas_dir/$persona.md"
}
