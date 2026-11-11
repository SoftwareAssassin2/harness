#!/usr/bin/env bash
# Description: Reply (on stdin) to a review thread or a plain review comment on one of the ticket's merge requests — merge-request:reply <project> <ticket-key> <variation> <id> <thread-id> -.
set -euo pipefail

# ASS-239: how a VM agent answers a review thread — on the host, with the
# host's glab or gh login. <id> is a planned merge request's id, one already
# created; <thread-id> a thread's id as merge-request:view prints it (a GitLab
# discussion; a GitHub review thread, which must be on that pull request).
# The reply, on stdin, is added to the thread; the thread is left as it is.
#
# ASS-361: <thread-id> may instead be a plain review comment's id, as
# merge-request:view's comments give it (a GitLab note id; a GitHub issue
# comment's IC_… or review's PRR_… node id). The comment, found on that
# merge request, is answered with a new comment naming its author and
# linking it (mr_comment_reply): neither forge replies in place to one
# without making it a thread. Posted as the host's login, which
# merge-request:await-dependencies counts as the harness's, so the comment
# is answered.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

[[ $# -eq 6 && "$6" == - ]] || { echo "usage: merge-request:reply <project> <ticket-key> <variation> <id> <thread-id> -" >&2; exit 1; }
command=merge-request:reply key="$(upper "$2")" thread="$5"
body="$(cat)"
[[ -n "${body//[[:space:]]/}" ]] || { echo "$command: nothing on stdin" >&2; exit 1; }
load_merge_requests "$command" "$1" "$key" "$3"
i="$(mr_by_id "$command" "$key" "$3" "$4")"
IFS=$'\t' read -r url iid _ < <(mr_at "$i")
if is_comment_id "$url" "$thread"; then mr_comment_reply "$command" "$i" "$thread" "$body"; exit 0; fi
mr_thread "$command" "$i" "$thread"

if on_github "$url"; then
  gh_run "$command" api graphql -f query='mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { url } } }' -f thread="$thread" -f body="$body" >/dev/null
else
  lab "$command" "$url" "/merge_requests/$iid/discussions/$thread/notes" -X POST -f "body=$body" >/dev/null
fi
