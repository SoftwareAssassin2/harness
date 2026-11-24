#!/usr/bin/env bash
# Description: One-off migration from dev-environments.mode to run targets (ASS-540): writes each project's dev-environments.run-targets from its mode (vm = local-vm; workstation = workstation, cloud-vm; vm+workstation = workstation, cloud-vm, local-vm; unset = vm) and removes the mode — project:migrate-run-targets [--dry-run]; prints each change; running it again changes nothing.
set -euo pipefail

# For each data/projects/<p>/project.json (PROJECTS_DIR overrides the folder):
# a project with dev-environments.run-targets and no mode is left as it is;
# otherwise its run-targets is written from its mode (src/control/run-targets.js
# MODE_TARGETS, the same list control derives while run-targets is unset, so
# nothing changes in how its tickets run) — a run-targets already there is kept
# — and the mode removed. Each file is rewritten whole under its lock (lock_on,
# then write_json) and only when it changes. Prints one line per project, what
# it wrote or that nothing needed changing; with --dry-run the same, writing
# nothing. Fails, writing nothing more, on a file that is not valid JSON or a
# mode it does not know.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"
command=project:migrate-run-targets

dry=0
case "${1:-}" in
  --dry-run) dry=1; shift ;;
  '') ;;
  *) echo "usage: $command [--dry-run]" >&2; exit 1 ;;
esac
[[ $# -eq 0 ]] || { echo "usage: $command [--dry-run]" >&2; exit 1; }

for file in "$projects"/*/project.json; do
  [[ -e "$file" ]] || continue
  name="$(basename "$(dirname "$file")")"
  jq empty "$file" 2>/dev/null || { echo "$command: $file is not valid JSON; nothing written to it" >&2; exit 1; }
  (
    lock_on 9 "$(readlink -f "$file").lock" "$command" "${JSON_LOCK_TIMEOUT:-30}"
    out="$(node "$here/run-targets.js" migrate "$file" 2> >(sed "s/^/$command: $name: /" >&2))" || exit 1
    if [[ "$(jq -r .changed <<< "$out")" != true ]]; then echo "$name: nothing to change"; exit 0; fi
    [[ $dry -eq 1 ]] || write_json "$(readlink -f "$file")" --argjson next "$(jq -c .json <<< "$out")" '$next'
    echo "$name: run-targets $(jq -r '.targets | join(", ")' <<< "$out") (from mode $(jq -r '.from // "unset (vm)"' <<< "$out"))$( [[ $dry -eq 1 ]] && echo ' (dry run: not written)')"
  ) || exit 1
done
