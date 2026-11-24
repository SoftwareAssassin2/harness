# The folders the Lima VMs live in (ASS-273, ASS-578).
#
# The harness-wide folder: the LIMA_HOME env var, else the untracked
# harness.local.json's lima-home (ASS-281: a machine's own settings, never
# committed), else harness.json's lima-home, else ~/.lima (Lima's own
# default). One setting, so the harness runs on any Mac.
#
# ASS-578: a project may keep its VMs and golden image in a folder of its own,
# project.json's lima-home (an absolute path), say on a disk of its own; unset,
# it uses the harness-wide one. Its golden image and its ticket VMs are always
# in the same folder: a ticket VM is an APFS copy-on-write clone of the golden
# disk, and clones can't cross volumes. Every Lima call for a project's VMs runs
# with that project's folder as LIMA_HOME, per call (never one folder for every
# project); the harness-wide views (disk, memory, CPU, reclaim, the dashboard's
# shutdown) cover every folder in use (lima_homes).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../lima-home.bash"
#   lima_home_default [<harness.json>]  # the harness-wide folder; harness.json by default (move-data names its own)
#   lima_home [<project>]       # the project's folder (its lima-home, else the harness-wide one); fails, saying why, when its
#                               # lima-home is not an absolute path or not writable. No project: LIMA_HOME, else the harness-wide one
#   lima_home_problem <project> # why its lima-home can't be used (empty, and 0, when it can or it sets none); 1 with a problem
#   lima_use <project>          # LIMA_HOME exported as the project's folder, for the raw limactl calls that follow (clone, create,
#                               # delete, rename, edit); HARNESS_LIMA_HOME exported as the harness-wide one, so a command run from
#                               # here for another project resolves its own
#   lima_init                   # LIMA_HOME (unless set) and HARNESS_LIMA_HOME exported as the harness-wide folder (vm.bash, golden.bash)
#   lima_homes                  # every folder in use, one per line: the harness-wide one first, then each project's own
#   lima_vm_home <instance>     # the folder holding that instance: LIMA_HOME's when it is there, else the first of lima_homes
#                               # that has it, else LIMA_HOME (or the harness-wide one): where a new one would go
#
# HARNESS_FILE overrides harness.json and HARNESS_LOCAL_FILE harness.local.json,
# used by tests; without it harness.local.json is the one beside the
# harness.json in use. PROJECTS_DIR overrides the projects folder.
lima_home_file="${HARNESS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/harness.json}"
lima_home_projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/projects}"

lima_home_default() {
  local home file="${1:-$lima_home_file}"
  [[ -z "${HARNESS_LIMA_HOME:-}" ]] || { echo "$HARNESS_LIMA_HOME"; return 0; }
  [[ -z "${LIMA_HOME:-}" ]] || { echo "$LIMA_HOME"; return 0; }
  home="$(jq -r '.["lima-home"] // empty' "${HARNESS_LOCAL_FILE:-$(dirname "$file")/harness.local.json}" 2>/dev/null || true)"
  [[ -n "$home" ]] || home="$(jq -r '.["lima-home"] // empty' "$file" 2>/dev/null || true)"
  echo "${home:-$HOME/.lima}"
}

# lima_home_set <project> — its project.json's lima-home as written (empty when it sets none).
lima_home_set() { jq -r '.["lima-home"] // empty | tostring' "$lima_home_projects/$1/project.json" 2>/dev/null || true; }

lima_home_problem() {
  local home dir
  home="$(lima_home_set "$1")"
  [[ -n "$home" ]] || return 0
  [[ "$home" == /* ]] || { echo "$1's project.json lima-home '$home' is not an absolute path"; return 1; }
  # Not there yet: Lima makes it on first use, so its nearest existing folder must be writable (an unmounted
  # disk's /Volumes/<name> is not: its VMs would land on the boot volume).
  dir="$home"; while [[ ! -d "$dir" ]]; do dir="$(dirname "$dir")"; done
  [[ -w "$dir" ]] || { echo "$1's project.json lima-home '$home' is not writable ($dir)"; return 1; }
}

lima_home() {
  local home why
  if [[ -z "${1:-}" ]]; then echo "${LIMA_HOME:-$(lima_home_default)}"; return 0; fi
  home="$(lima_home_set "$1")"
  [[ -n "$home" ]] || { lima_home_default; return 0; }
  why="$(lima_home_problem "$1")" || { echo "$why" >&2; return 1; }
  echo "${home%/}"
}

lima_use() {
  local home
  home="$(lima_home "$1")" || return 1
  HARNESS_LIMA_HOME="$(lima_home_default)"; export HARNESS_LIMA_HOME
  LIMA_HOME="$home"; export LIMA_HOME
}

lima_init() {
  HARNESS_LIMA_HOME="$(lima_home_default)"; export HARNESS_LIMA_HOME
  LIMA_HOME="${LIMA_HOME:-$HARNESS_LIMA_HOME}"; export LIMA_HOME
}

lima_homes() {
  local files=()
  shopt -s nullglob; files=("$lima_home_projects"/*/project.json); shopt -u nullglob
  { lima_home_default
    [[ ${#files[@]} -eq 0 ]] || jq -r '.["lima-home"] // empty | strings | select(startswith("/")) | sub("/+$"; "")' "${files[@]}" 2>/dev/null || true
  } | awk 'NF && !seen[$0]++'
}

lima_vm_home() {
  local home h
  home="$(lima_home)"
  [[ ! -d "$home/$1" ]] || { echo "$home"; return 0; }
  while IFS= read -r h; do [[ ! -d "$h/$1" ]] || { echo "$h"; return 0; }; done < <(lima_homes)
  echo "$home"
}
