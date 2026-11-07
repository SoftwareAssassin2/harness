# State engines, engines/<name>/state-engine.json at the repo root (ENGINES_DIR
# overrides the folder, used by tests), for the agent-cli commands that read
# one. A project's own engines (ASS-276) are data/projects/<project>/engines/
# <name>/state-engine.json (PROJECTS_DIR overrides the projects folder): for
# that project's work one is found there first, then in engines/, so a
# project's engine of the same name shadows engines/'s for it alone. Without a
# project only engines/ is searched.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../engine.bash"
#   engine_path  <engine> [<project>]                  # the path of its state-engine.json, the project's own first; fails, printing nothing, when there is none
#   engine_file  <command> <engine> [<project>]        # engine_path, failing naming <command> when there is none
#   engine_steps_of <command> <engine-name> [<project>]  # its steps as a JSON array
#   connected_engines <engine> [<project>]             # the engines it reaches, one per line: the state-engine steps of its steps and *-steps lists, then theirs, each once
#   engine_files [<project>]                           # every state-engine.json the project sees, one per line: engines/'s, then its own (a by-name reduce over them keeps its own)
#
# An <engine-name> is "<engine>" (its `steps`) or "<engine>/<key>" (the
# `<key>` list inside it, such as a `*-steps` list); engine_steps_of fails,
# naming <command>, when the engine or the list is missing. An engine or
# project name becomes a path segment, so it may not climb out of its folder.
engines_dir="${ENGINES_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../engines}"
engine_projects_dir="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/projects}"

engine_path() {
  local engine="$1" project="${2:-}"
  [[ "$engine" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
  if [[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$engine_projects_dir/$project/engines/$engine/state-engine.json" ]]; then
    echo "$engine_projects_dir/$project/engines/$engine/state-engine.json"
  elif [[ -f "$engines_dir/$engine/state-engine.json" ]]; then
    echo "$engines_dir/$engine/state-engine.json"
  else
    return 1
  fi
}

engine_files() {
  local project="${1:-}" file
  for file in "$engines_dir"/*/state-engine.json; do [[ -f "$file" ]] && echo "$file"; done
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  for file in "$engine_projects_dir/$project/engines"/*/state-engine.json; do [[ -f "$file" ]] && echo "$file"; done
  return 0
}

engine_file() {
  local command="$1" engine="$2"
  engine_path "$engine" "${3:-}" || { echo "$command: no state engine $engine" >&2; return 1; }
}

engine_steps_of() {
  local command="$1" name="$2" engine key="" file steps
  engine="${name%%/*}"
  [[ "$name" == */* ]] && key="${name#*/}"
  file="$(engine_file "$command" "$engine" "${3:-}")" || return 1
  steps="$(jq -c --arg key "$key" 'if $key == "" then .steps else .[$key] end | select(type == "array")' "$file")"
  [[ -n "$steps" ]] || { echo "$command: no state engine $name" >&2; return 1; }
  echo "$steps"
}

connected_engines() {
  local queue=("$1") seen=" $1 " project="${2:-}" name next file
  while [[ ${#queue[@]} -gt 0 ]]; do
    name="${queue[0]}"; queue=("${queue[@]:1}")
    file="$(engine_path "$name" "$project")" || continue
    while IFS= read -r next; do
      [[ -n "$next" && "$seen" != *" $next "* ]] || continue
      seen+="$next "; echo "$next"; queue+=("$next")
    done < <(jq -r '[(.steps // []), (to_entries[] | select(.key | endswith("-steps")) | .value)] | flatten | .[] | select(.action.type? == "state-engine") | .action.engine' "$file")
  done
}
