#!/usr/bin/env bash
# Description: Mark the ticket's merge requests ready for review — code:take-out-of-draft-mode <project> <ticket-key> <variation>.
set -euo pipefail

# Every one of the variation's merge requests recorded Open (!<iid> or
# #<number>; see merge-request:create, merge-requests.bash) taken out of
# draft — glab `mr update --ready` (through GitLab's API for a planned one,
# ASS-81: "Draft:" dropped from its title), or for GitHub gh `pr ready` (GLAB_DISABLED /
# GH_DISABLED=1 only say what they would run). Prints { "iid", "ready": true }
# for each. Fails when the variation has no merge request, glab fails, or the
# project, ticket or variation is missing. Changes nothing locally.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

[[ $# -eq 3 ]] || { echo "usage: code:take-out-of-draft-mode <project> <ticket-key> <variation>" >&2; exit 1; }
load_merge_requests code:take-out-of-draft-mode "$1" "$(upper "$2")" "$3"
for i in $(jq -r 'to_entries[] | select(.value.status == "Open" and .value.key != null) | .key' <<< "$MRS"); do
  mr_ready code:take-out-of-draft-mode "$i"
  jq -nc --argjson iid "$(jq -r ".[$i].key | ltrimstr(\"!\") | ltrimstr(\"#\")" <<< "$MRS")" '{ iid: $iid, ready: true }'
done
