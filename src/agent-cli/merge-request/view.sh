#!/usr/bin/env bash
# Description: Show one of the ticket's merge requests, with its open threads and failed jobs, from its forge — merge-request:view <project> <ticket-key> <variation> <id>.
set -euo pipefail

# ASS-238: how a VM agent reads a merge request — on the host, with the
# host's glab or gh login, so no forge token or CLI is needed in the VM.
# <id> is a planned merge request's id (ticket:merge-request-plan), one
# already created. Prints { id, url, state: Open|Merged|Closed, draft, base,
# branch, title, description, threads: [{ id, path, line, comments: [{ author,
# body }] }] — the unresolved ones, each id what merge-request:reply and
# :resolve take (ASS-239) — comments: [{ id, author, body, created }] —
# ASS-361: the plain review comments (no thread: a GitLab note that is not
# resolvable, a GitHub issue comment or review body) posted since its latest
# commit and not yet answered by the harness (mr_review_comments,
# merge-requests.bash), each id what merge-request:reply takes to answer it
# — and failed-jobs: [{ name, url, log? }] — on GitLab its head pipeline's
# failed jobs (an allowed failure aside), each with its log's last 60 lines;
# on GitHub its failing checks }.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

[[ $# -eq 4 ]] || { echo "usage: merge-request:view <project> <ticket-key> <variation> <id>" >&2; exit 1; }
command=merge-request:view key="$(upper "$2")"
load_merge_requests "$command" "$1" "$key" "$3"
i="$(mr_by_id "$command" "$key" "$3" "$4")"
IFS=$'\t' read -r url iid _ < <(mr_at "$i")
comments="$(mr_review_comments "$command" "$i" "$1")"

if on_github "$url"; then
  repo="$(path_of "$url")"
  mr="$(gh_run "$command" pr view "$iid" --repo "$repo" --json url,state,isDraft,baseRefName,headRefName,title,body,statusCheckRollup)"
  threads="$(gh_run "$command" api graphql -f query='query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved path line comments(first: 100) { nodes { author { login } body } } } } } } }' -f owner="${repo%%/*}" -f name="${repo#*/}" -F number="$iid")"
  jq -c --argjson id "$4" --argjson t "$threads" --argjson comments "$comments" '{ id: $id, url, state: ({ OPEN: "Open", MERGED: "Merged" }[.state] // "Closed"), draft: (.isDraft == true),
    base: .baseRefName, branch: .headRefName, title, description: .body,
    threads: [$t.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not) | { id, path, line, comments: [.comments.nodes[] | { author: .author.login, body }] }],
    comments: $comments,
    "failed-jobs": [.statusCheckRollup // [] | .[] | select((.conclusion // .state // "") | IN("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT")) | { name: (.name // .context), url: (.detailsUrl // .targetUrl) }] }' <<< "$mr"
else
  mr="$(lab "$command" "$url" "/merge_requests/$iid")"
  discussions="$(lab "$command" "$url" "/merge_requests/$iid/discussions?per_page=100")"
  pipeline="$(jq -r '.head_pipeline.id // empty' <<< "$mr")" jobs='[]'
  if [[ -n "$pipeline" ]]; then
    jobs="$(lab "$command" "$url" "/pipelines/$pipeline/jobs?per_page=100" | jq -c '[.[] | select(.status == "failed" and (.allow_failure | not)) | { id, name, url: .web_url }]')"
    for job in $(jq -r '.[].id' <<< "$jobs"); do
      jobs="$(jq -c --argjson job "$job" --arg log "$(lab "$command" "$url" "/jobs/$job/trace" | tail -n 60)" 'map(if .id == $job then .log = $log else . end)' <<< "$jobs")"
    done
  fi
  jq -c --argjson id "$4" --argjson d "$discussions" --argjson jobs "$jobs" --argjson comments "$comments" '{ id: $id, url: .web_url, state: ({ opened: "Open", merged: "Merged" }[.state] // "Closed"),
    draft: (.draft == true), base: .target_branch, branch: .source_branch, title, description,
    threads: [$d[] | select(any(.notes[]; .resolvable and (.resolved | not))) | { id, path: .notes[0].position.new_path, line: .notes[0].position.new_line, comments: [.notes[] | { author: .author.username, body }] }],
    comments: $comments,
    "failed-jobs": [$jobs[] | del(.id)] }' <<< "$mr"
fi
