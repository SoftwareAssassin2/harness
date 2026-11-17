#!/usr/bin/env bash
# Description: Print how long control's ticks take — count, lowest, highest (and when), average and last, overall and per phase — for each project or the one named — harness:tick-stats [<project>].
set -euo pipefail

# ASS-490. Reads what each control records (src/control/tick-stats.js):
# data/projects/<project>/tick-stats.json for each project (those with a
# project.json), or the one named, and $HARNESS_HOME/tick-stats.json
# (~/.harness by default) — a control run with no --project — when it exists
# and no project is named. Seconds to 2 decimals, then the per-phase table,
# and a note that the background work the tick does not wait for (VM lifecycle
# jobs) is not included. A project whose control has recorded none yet says
# so; that is not a failure (exit 0). Fails on a bad or unknown project.
# PROJECTS_DIR and HARNESS_HOME override the folders, used by tests.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"
home="${HARNESS_HOME:-$HOME/.harness}"

[[ $# -le 1 ]] || { echo "usage: harness:tick-stats [<project>]" >&2; exit 1; }
if [[ $# -eq 1 ]]; then
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "harness:tick-stats: invalid project '$1'" >&2; exit 1; }
  [[ -f "$projects/$1/project.json" ]] || { echo "harness:tick-stats: no project $1" >&2; exit 1; }
fi
exec node "$here/tick-stats.js" "$projects" "$home" "$@"
