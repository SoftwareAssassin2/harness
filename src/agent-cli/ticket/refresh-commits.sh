#!/usr/bin/env bash
# Description: Gather every commit of a ticket variation across its project's repositories — the forge's branches, merge requests and default branch, and the clones on the Mac; never its machine — into work/<KEY>/commits-<variation>.json for the ticket screen's Commits tab, and print the file — ticket:refresh-commits <project> <ticket-key> <variation>.
set -euo pipefail

# ASS-558. refresh-commits.js does the work (src/control/ticket-commits.js
# gathers): the variation is read from the project's active sprint, the forge
# through the host's glab and gh (read only), the clones — the project's
# local-pc checkout and the harness's own under checkouts/ (ASS-553) — with
# git log, never fetched. The file is written whole (a temporary file renamed
# over it); only this command writes it. Control runs it periodically and
# after each step that commits (src/control/commit-refresh.js); run it by hand
# to refresh one at once. A source that fails is recorded in the file's
# `sources` and the rest still read. Fails on a bad project, or a ticket or
# variation not in the active sprint.
# PROJECTS_DIR overrides the projects folder, used by tests.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"

[[ $# -eq 3 ]] || { echo "usage: ticket:refresh-commits <project> <ticket-key> <variation>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:refresh-commits: invalid project '$1'" >&2; exit 1; }
[[ "$2" =~ ^[A-Za-z][A-Za-z0-9]*-[0-9]+$ ]] || { echo "ticket:refresh-commits: invalid ticket key '$2'" >&2; exit 1; }
[[ "$3" =~ ^[A-Za-z]+$ ]] || { echo "ticket:refresh-commits: invalid variation '$3'" >&2; exit 1; }
[[ -f "$projects/$1/project.json" ]] || { echo "ticket:refresh-commits: no project $1" >&2; exit 1; }
exec node "$here/refresh-commits.js" "$projects" "$@"
