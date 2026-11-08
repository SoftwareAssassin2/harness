#!/usr/bin/env bash
# Description: Record the account a project's VM token for its repositories' forge pushes as, as control last checked it — project:set-push-account <project> <provider> <account|-> <error|->.
set -euo pipefail

# Writes { project, provider, account, error, checked-at } to
# data/projects/<project>/push-account.json (PROJECTS_DIR overrides the
# projects folder, used by tests) — live data, kept out of the tracked
# project.json like claude-usage.json (ASS-47): what control last read of the
# account a project's VM token for its repositories' forge pushes as
# (ASS-307, src/control/push-account.js). `provider` is GitHub or GitLab;
# `account` the forge's login or `-`; `error` why it could not be told
# (no token declared, no token in the keychain, token rejected (401), the
# forge is unavailable (<status>), the forge is unreachable, the forge
# answered no account) or `-`. Exactly one of account and error is given: a
# check knows one or the other.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

usage="usage: project:set-push-account <project> <provider> <account|-> <error|->"
[[ $# -eq 4 ]] || { echo "$usage" >&2; exit 1; }
# The project becomes a path segment, so it may not climb out of the projects folder.
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "project:set-push-account: invalid project '$1'" >&2; exit 1; }
[[ "$2" == GitHub || "$2" == GitLab ]] || { echo "project:set-push-account: provider must be GitHub or GitLab, got '$2'" >&2; exit 1; }
# Exactly one of account and error is given.
if [[ "$3" == - && "$4" == - ]]; then echo "project:set-push-account: one of account and error must be given" >&2; exit 1; fi
if [[ "$3" != - && "$4" != - ]]; then echo "project:set-push-account: only one of account and error may be given" >&2; exit 1; fi
[[ -f "$projects/$1/project.json" ]] || { echo "project:set-push-account: no project $1" >&2; exit 1; }

orNull() { [[ "$1" == - ]] && echo null || echo "$2"; }
update_json --create "$projects/$1/push-account.json" \
  --arg project "$1" --arg provider "$2" \
  --argjson account "$(orNull "$3" "$(jq -n --arg a "$3" '$a')")" \
  --argjson error "$(orNull "$4" "$(jq -n --arg e "$4" '$e')")" '
  { project: $project, provider: $provider, account: $account, error: $error,
    "checked-at": (now | floor | todate) }'
