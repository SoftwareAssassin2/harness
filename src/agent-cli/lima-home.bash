# The folder every Lima VM lives in (ASS-273): the LIMA_HOME env var, else
# the untracked harness.local.json's lima-home (ASS-281: a machine's own
# settings, never committed), else harness.json's lima-home, else ~/.lima
# (Lima's own default). One setting, so the harness runs on any Mac.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../lima-home.bash"
#   lima_home [<harness.json>]   # that folder; harness.json by default
#
# HARNESS_FILE overrides harness.json and HARNESS_LOCAL_FILE harness.local.json,
# used by tests; without it harness.local.json is the one beside the
# harness.json in use.
lima_home_file="${HARNESS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/harness.json}"

lima_home() {
  local home file="${1:-$lima_home_file}"
  [[ -z "${LIMA_HOME:-}" ]] || { echo "$LIMA_HOME"; return 0; }
  home="$(jq -r '.["lima-home"] // empty' "${HARNESS_LOCAL_FILE:-$(dirname "$file")/harness.local.json}" 2>/dev/null || true)"
  [[ -n "$home" ]] || home="$(jq -r '.["lima-home"] // empty' "$file" 2>/dev/null || true)"
  echo "${home:-$HOME/.lima}"
}
