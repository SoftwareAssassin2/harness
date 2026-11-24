# State engines, engines/<name>/workflow.yaml at the repo root (ENGINES_DIR
# overrides the folder, used by tests), for the agent-cli commands that read
# one. A project's own engines (ASS-276) are data/projects/<project>/engines/
# <name>/workflow.yaml (PROJECTS_DIR overrides the projects folder): for
# that project's work one is found there first, then in engines/, so a
# project's engine of the same name shadows engines/'s for it alone. Without a
# project only engines/ is searched.
#
# ASS-524: an engine is YAML (a state-engine.json before), and jq reads only
# JSON, so a command reads an engine through engine_json (or engines_by_name),
# which hands it over as JSON from the one loader, src/workflow/engine-file.js
# (by src/workflow/engine-cli.js), then jq's it as before. A file that does
# not parse fails there, naming its file, line and reason.
#
# ASS-548: that node start cost 15-80x the jq read it replaced (measured:
# ~200 ms of CPU each on a loaded Mac, against ~5 ms for jq), and a command
# reads several engines (ticket:change-state up to 5, transient-state-engine:
# create ~22 with a project's real engines). So engine-cli.js leaves each
# engine it reads as JSON in a cache, $ENGINE_CACHE_DIR (default: the
# checkout's data/cache/engines, gitignored runtime state; set empty, no
# cache), and engine_json / engines_by_name read it from there without node:
# bash's own reads, and a cksum when the file's path has no link yet. An entry
# is named by its YAML's content and holds that very YAML, taken only when it
# is the file's text byte for byte, so an edited workflow.yaml is never read
# stale and a damaged entry is a miss (node then writes it again,
# atomically). The YAML stays the one source: the cache is never edited,
# never committed, and safe to delete. See src/workflow/engine-cache.js.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../engine.bash"
#   engine_path  <engine> [<project>]                  # the path of its workflow.yaml, the project's own first; fails, printing nothing, when there is none
#   engine_file  <command> <engine> [<project>]        # engine_path, failing naming <command> when there is none
#   engine_json  <file>                                # the engine in <file> (a workflow.yaml) as JSON, on one line (from the cache when it is there)
#   engines_by_name [<file>…]                          # { "<engine>": its JSON } for the files (each named by its folder, a later one over an earlier); {} for none
#   engine_steps_of <command> <engine-name> [<project>]  # its steps as a JSON array
#   require_step <command> <engine-name> <project> <value>  # passes when <value> is a step id of it; else fails, naming <command>, the engine and <value>, with a did-you-mean hint
#   connected_engines <engine> [<project>]             # the engines it reaches, one per line: the state-engine steps of its steps and *-steps lists, then theirs, each once
#   engine_files [<project>]                           # every workflow.yaml the project sees, one per line: engines/'s, then its own (a by-name reduce over them keeps its own)
#
# require_step is the one check every command that takes a state from its
# caller makes before it writes anything (ASS-449): a state must be a step id
# of the engine that is to run it, never its display name. It writes nothing
# itself; it only says no, so the caller can refuse before any sync, lookup or
# write. When the value matches a step's id or name ignoring case — the mistake
# that reaches it, a name ("Committed") or a mis-cased id — the refusal adds
# ` did you mean <id> (<name>)?`, a step without a name shown by its id.
#
# An <engine-name> is "<engine>" (its `steps`) or "<engine>/<key>" (the
# `<key>` list inside it, such as a `*-steps` list); engine_steps_of fails,
# naming <command>, when the engine or the list is missing. An engine or
# project name becomes a path segment, so it may not climb out of its folder.
engines_dir="${ENGINES_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../engines}"
engine_projects_dir="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/projects}"
engine_cli="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../workflow/engine-cli.js"
engine_cache_dir="${ENGINE_CACHE_DIR-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/cache/engines}"

engine_path() {
  local engine="$1" project="${2:-}"
  [[ "$engine" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
  if [[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$engine_projects_dir/$project/engines/$engine/workflow.yaml" ]]; then
    echo "$engine_projects_dir/$project/engines/$engine/workflow.yaml"
  elif [[ -f "$engines_dir/$engine/workflow.yaml" ]]; then
    echo "$engines_dir/$engine/workflow.yaml"
  else
    return 1
  fi
}

engine_files() {
  local project="${1:-}" file
  for file in "$engines_dir"/*/workflow.yaml; do [[ -f "$file" ]] && echo "$file"; done
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  for file in "$engine_projects_dir/$project/engines"/*/workflow.yaml; do [[ -f "$file" ]] && echo "$file"; done
  return 0
}

# engine_cached <file> — engine_cached_json set to <file>'s engine from the
# cache: the entry its path's link points at, else (one cksum) its content's
# entry; either only when it holds <file>'s very text. Fails, the variable
# empty, on a miss. LC_ALL=C makes the lengths bytes, as engine-cache.js counts
# them.
engine_cached() {
  local file="$1" text="" link key LC_ALL=C
  engine_cached_json=""
  [[ -n "$engine_cache_dir" && -f "$file" ]] || return 1
  IFS= read -r -d '' text < "$file" || true
  link="${file//'%'/%25}"; link="path-${link//\//%2F}"
  [[ ${#link} -le 200 ]] && engine_cache_entry "$engine_cache_dir/$link" "$text" && return 0
  key="$(cksum < "$file" 2>/dev/null)" || return 1
  engine_cache_entry "$engine_cache_dir/${key/ /-}" "$text"
}

# engine_cache_entry <entry> <text> — engine_cached_json set to the entry's
# JSON when the entry is whole and holds the YAML <text>. It reads with bash's
# read, never a pattern over the whole entry: bash's ${x%%…*} and
# [[ $x == *…* ]] are quadratic in the string's length (~1 s on a 15 KB engine).
engine_cache_entry() {
  local header="" json="" yaml="" LC_ALL=C
  [[ -f "$1" ]] || return 1
  { IFS= read -r header && IFS= read -r json && { IFS= read -r -d '' yaml || true; }; } < "$1" 2>/dev/null || return 1
  [[ "$header" == "harness-engine-cache 1 ${#json}" && "${json:0:1}" == "{" && "${json: -1}" == "}" && "$yaml" == "$2" ]] || return 1
  engine_cached_json="$json"
}

engine_json() {
  if engine_cached "$1"; then printf '%s\n' "$engine_cached_json"; return 0; fi
  ENGINE_CACHE_DIR="$engine_cache_dir" node "$engine_cli" json "$1"
}

engines_by_name() {
  [[ $# -gt 0 ]] || { echo '{}'; return 0; }
  local file name i out="" names=() jsons=()
  for file in "$@"; do
    [[ -e "$file" ]] || continue
    name="${file%/*}"; name="${name##*/}"
    if [[ "$file" != */* || ! "$name" =~ ^[A-Za-z0-9_-][A-Za-z0-9_.-]*$ ]] || ! engine_cached "$file"; then
      ENGINE_CACHE_DIR="$engine_cache_dir" node "$engine_cli" by-name "$@"
      return
    fi
    for i in "${!names[@]}"; do
      [[ "${names[i]}" == "$name" ]] && { jsons[i]="$engine_cached_json"; continue 2; }
    done
    names+=("$name"); jsons+=("$engine_cached_json")
  done
  for i in "${!names[@]}"; do out+="${out:+,}\"${names[i]}\":${jsons[i]}"; done
  printf '{%s}\n' "$out"
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
  steps="$(engine_json "$file" | jq -c --arg key "$key" 'if $key == "" then .steps else .[$key] end | select(type == "array")')"
  [[ -n "$steps" ]] || { echo "$command: no state engine $name" >&2; return 1; }
  echo "$steps"
}

require_step() {
  local command="$1" name="$2" project="$3" value="$4" steps hint
  steps="$(engine_steps_of "$command" "$name" "$project")" || return 1
  jq -e --arg id "$value" 'any(.[]; .id == $id)' <<< "$steps" > /dev/null && return 0
  hint="$(jq -r --arg id "$value" 'first(.[]
    | select((.id | ascii_downcase) == ($id | ascii_downcase) or ((.name // "") | ascii_downcase) == ($id | ascii_downcase))
    | " did you mean \(.id) (\(.name // .id))?") // ""' <<< "$steps")"
  echo "$command: $name has no step $value$hint" >&2
  return 1
}

connected_engines() {
  local queue=("$1") seen=" $1 " project="${2:-}" name next file
  while [[ ${#queue[@]} -gt 0 ]]; do
    name="${queue[0]}"; queue=("${queue[@]:1}")
    file="$(engine_path "$name" "$project")" || continue
    while IFS= read -r next; do
      [[ -n "$next" && "$seen" != *" $next "* ]] || continue
      seen+="$next "; echo "$next"; queue+=("$next")
    done < <(engine_json "$file" | jq -r '[(.steps // []), (to_entries[] | select(.key | endswith("-steps")) | .value)] | flatten | .[] | select(.action.type? == "state-engine") | .action.engine')
  done
}
