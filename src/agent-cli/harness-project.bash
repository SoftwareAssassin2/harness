# The harness project: the one project whose code is the harness itself, named
# by harness.json's harness-project (ASS-106). Its data folder stays
# data/projects/<name>, as every project's does.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../harness-project.bash"
#   harness_project              # its name; nothing when harness.json names none (or no single path segment)
#   is_harness_project <project> # succeeds only for the harness project
#
# HARNESS_FILE overrides harness.json, used by tests.
harness_project_file="${HARNESS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/harness.json}"

harness_project() {
  local name
  name="$(jq -r '.["harness-project"] // empty' "$harness_project_file" 2>/dev/null || true)"
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] && echo "$name"
  return 0
}

is_harness_project() { [[ -n "$1" && "$1" == "$(harness_project)" ]]; }
