# Whether a CLI's login has expired, per project — the one writer behind
# project:set-gcloud-reauthentication (ASS-28) and
# project:set-glab-reauthentication (ASS-61).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../reauthentication.bash"
#   set_reauthentication <tool> "$@"     # "$@" being <project> <true|false>
#
# Writes the value, and nothing else, to
# data/projects/<project>/<tool>-requires-reauthentication (PROJECTS_DIR overrides
# the projects folder, used by tests): live data kept out of the tracked
# project.json (ASS-58), written beside and renamed over so a reader never
# sees half of it. Readers count only content exactly `true`; a missing file
# is false. Fails, writing nothing, on a bad value or a project with no
# project.json.
set_reauthentication() {
  local tool="$1"; shift
  local command="project:set-$tool-reauthentication"
  local projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/projects}"

  [[ $# -eq 2 ]] || { echo "usage: $command <project> <true|false>" >&2; return 1; }
  # The project becomes a path segment, so it may not climb out of the projects folder.
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$1'" >&2; return 1; }
  [[ "$2" == true || "$2" == false ]] || { echo "$command: the value must be true or false, got '$2'" >&2; return 1; }
  [[ -f "$projects/$1/project.json" ]] || { echo "$command: no project $1" >&2; return 1; }

  local file="$projects/$1/$tool-requires-reauthentication"
  printf '%s' "$2" > "$file.$$" && mv -f "$file.$$" "$file"
}
