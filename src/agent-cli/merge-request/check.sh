#!/usr/bin/env bash
# Description: Read the ticket's merge requests from their forges and report whether they need an agent — merge-request:check <project> <ticket-key> <variation>.
set -euo pipefail

# Deterministic: control's read of every one of the variation's merge
# requests (refresh_merge_requests, merge-requests.bash), recording each
# one's live status and base by id (ASS-81). Run on a timer during Team Code
# Review, so an agent starts only when there is something to act on, and by
# Generate Solution before it works on each planned merge request. Prints one
# JSON object over the Open ones:
#
#   { "needs-attention": <any reason>, "reasons": [...], "auto-merge": <bool>, "merged": <bool> }
#
# reasons, in this order: "open-threads" (blocking discussions unresolved;
# on GitHub, changes requested), "build-failed" (its head pipeline failed or
# was canceled; a failed check), "needs-rebase" (conflicts, or the forge says
# it needs a rebase or is behind its base). auto-merge: every one not Closed
# is Merged or set to merge when its checks pass. merged: every one not
# Closed is Merged. A merged one needs nothing and counts as auto-merged.
# Exits 0 when the check ran, whatever it found; fails when the variation has
# no merge request (but a fast-tracked ticket, ASS-151), a forge call fails, or the project, ticket or variation
# is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

[[ $# -eq 3 ]] || { echo "usage: merge-request:check <project> <ticket-key> <variation>" >&2; exit 1; }
refresh_merge_requests merge-request:check "$1" "$(upper "$2")" "$3"
jq -nc --argjson mrs "$MRS" --argjson views "$VIEWS" '
  [range($mrs | length) | { m: $mrs[.], v: $views[.] } | select(.m.status != "Closed")] as $live
  | [$live[] | select(.m.status == "Open") | .v.reasons[]] as $all
  | ["open-threads", "build-failed", "needs-rebase"] | map(select(IN($all[]))) as $reasons
  | { "needs-attention": ($reasons | length > 0), reasons: $reasons,
      "auto-merge": ($live != [] and all($live[]; .m.status == "Merged" or (.m.status == "Open" and .v["auto-merge"]))),
      merged: ($live != [] and all($live[]; .m.status == "Merged")) }'
