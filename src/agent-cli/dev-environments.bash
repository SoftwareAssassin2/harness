# Where a project's tickets run (ASS-431): project.json's dev-environments,
# read here for every bash command rather than from project.json itself, as
# src/control/dev-environments.js reads it for control and the dashboard (this
# runs that, through dev-environments.js, so both judge it alike). Its mode is
# vm (each ticket variation in a Lima VM of its own; the default), workstation
# (on GCP Cloud Workstations from its list, over SSH) or vm+workstation (a
# free workstation seat first, a VM seat otherwise: ASS-469, one seat per
# workstation listed, src/control/seat-kinds.js).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../dev-environments.bash"
#   dev_environments <command> <project>               # { mode, workstations } as one JSON line, the defaults filled in
#   dev_environments_mode <command> <project>          # vm, vm+workstation or workstation
#   dev_environments_workstations <command> <project>  # each workstation as one JSON line, in list order: { id, gcp-project, region, cluster, config[, gcloud-config] }
#   dev_environments_workstation <command> <project> <id>   # that workstation's JSON line; fails when the list has none
#
# Each fails, naming <command> and the project, without the project or when
# its dev-environments is wrong (each bad field named). A gcloud-config comes
# with its leading ~ or $HOME expanded. PROJECTS_DIR overrides
# data/projects, used by tests.
dev_environments_here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
dev_environments_projects="${PROJECTS_DIR:-$dev_environments_here/../../data/projects}"

dev_environments() {
  local out
  out="$(node "$dev_environments_here/dev-environments.js" "$dev_environments_projects" "$2" 2>&1)" || { echo "$1: project $2: $out" >&2; return 1; }
  echo "$out"
}

dev_environments_mode() {
  local settings
  settings="$(dev_environments "$@")" || return 1
  jq -r '.mode' <<< "$settings"
}

dev_environments_workstations() {
  local settings
  settings="$(dev_environments "$@")" || return 1
  jq -c '.workstations[]' <<< "$settings"
}

dev_environments_workstation() {
  local settings found
  settings="$(dev_environments "$1" "$2")" || return 1
  found="$(jq -c --arg id "$3" 'first(.workstations[] | select(.id == $id)) // empty' <<< "$settings")"
  [[ -n "$found" ]] || { echo "$1: project $2 has no workstation '$3' in its dev-environments" >&2; return 1; }
  echo "$found"
}
