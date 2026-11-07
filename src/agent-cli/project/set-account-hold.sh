#!/usr/bin/env bash
# Description: Record why control starts none of a project's agents — project:set-account-hold <project> <expected> <actual|-> <config-dir|->.
set -euo pipefail

# Writes "account-hold": { since, expected, actual, config-dir } in
# data/projects/<project>/project.json (PROJECTS_DIR overrides the projects folder,
# used by tests): the project's expected-account, the account its Claude
# config is logged in to (null for -: none), that config's folder (null for -:
# the shared ~/.claude), `since` now — kept as it was when one already holds
# (ASS-26). The dashboard shows it as WRONG ACCOUNT;
# project:clear-account-hold removes it. Fails, writing nothing, on a bad
# project or usage.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 4 ]] || { echo "usage: project:set-account-hold <project> <expected> <actual|-> <config-dir|->" >&2; exit 1; }
# The project becomes a path segment, so it may not climb out of the projects folder.
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:set-account-hold: invalid project '$1'" >&2; exit 1; }

update_json "$projects/$1/project.json" --arg expected "$2" --arg actual "$3" --arg dir "$4" '
  def given: if . == "-" then null else . end;
  .["account-hold"] = { since: (.["account-hold"].since // (now | floor | todate)), expected: $expected, actual: ($actual | given), "config-dir": ($dir | given) }'
