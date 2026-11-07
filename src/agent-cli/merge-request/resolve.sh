#!/usr/bin/env bash
# Description: Resolve a review thread on one of the ticket's merge requests — merge-request:resolve <project> <ticket-key> <variation> <id> <thread-id>.
set -euo pipefail

# ASS-239: how a VM agent resolves a review thread it addressed — on the
# host, with the host's glab or gh login. <id> and <thread-id> as
# merge-request:reply takes them.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

[[ $# -eq 5 ]] || { echo "usage: merge-request:resolve <project> <ticket-key> <variation> <id> <thread-id>" >&2; exit 1; }
command=merge-request:resolve key="$(upper "$2")" thread="$5"
load_merge_requests "$command" "$1" "$key" "$3"
i="$(mr_by_id "$command" "$key" "$3" "$4")"
mr_thread "$command" "$i" "$thread"
IFS=$'\t' read -r url iid _ < <(mr_at "$i")

if on_github "$url"; then
  gh_run "$command" api graphql -f query='mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }' -f thread="$thread" >/dev/null
else
  lab "$command" "$url" "/merge_requests/$iid/discussions/$thread" -X PUT -f resolved=true >/dev/null
fi
