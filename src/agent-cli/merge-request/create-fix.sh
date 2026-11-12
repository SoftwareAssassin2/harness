#!/usr/bin/env bash
# Description: Open the separate fix merge request Blocked's Repair Project made to unblock a ticket — merge-request:create-fix <project> <ticket-key> <variation> <repository-url> <branch> <title> < description.
set -euo pipefail

# ASS-390 AC2. grouped-blocked's Repair Project fixes product code that
# blocks a ticket — not a bug on the latest master, not the ticket's own
# branch — in a small merge request of its own, never on the ticket's
# branches: the agent builds and pushes <branch>, change/<KEY>-fix-<n>
# (change/<KEY>.<variation>-fix-<n> for a variation other than A, as
# ticket_slug names the ticket's own), from the repository's default branch,
# then opens it here. <repository-url> must be one of the project's
# repositories (project.json); <branch> must be such a fix branch and on the
# forge with changes against the default branch. An open one from the branch
# is reused; else it is opened against the default branch, titled in the
# project's merge request title format (merge-request-title.bash title_of, a
# fix: "<KEY>: <title> (fix <n>, unblocks <KEY>)", or conventional "fix:
# <title> (fix <n>, unblocks <KEY>) (<KEY>)"), its description saying which
# ticket it unblocks (ticket_reference) and that the harness opened it, then
# stdin — why: what blocked the ticket and what the fix changes — and taken
# out of draft (mr_ready), so it can be reviewed, approved and merged by
# people. It is recorded on the variation as one of its fix-merge-requests
# [{ n, repository, branch, base, key (!<iid>, #<number> on GitHub), url,
# status: Open, title, opened-at }], for ticket:wait-on --merge-request to
# wait on, and the change log says so (work.bash blocked_log, AC3). Prints {
# fix-merge-request: <url>, key, branch, repository, base, created } and
# exits 0. Fails (1), recording nothing, on bad arguments, an unknown
# ticket or variation, a repository not the project's, a branch that is not a
# fix branch of this ticket, nothing on stdin, a branch not on the forge or
# changing nothing, or a forge call failing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-request-title.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"

command=merge-request:create-fix
usage="usage: $command <project> <ticket-key> <variation> <repository-url> <branch> <title> < description"
[[ $# -eq 6 ]] || { echo "$usage" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" url="${4%/}" branch="$5" title="$6"
url="${url%.git}"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; exit 1; }
variation_field . "$command" "$project" "$key" "$variation" >/dev/null
jq -e --arg u "$url" 'any(.repositories // [] | .[]; (.url // "" | rtrimstr("/") | rtrimstr(".git")) == $u)' "$projects/$project/project.json" >/dev/null 2>&1 \
  || { echo "$command: $url is not one of $project's repositories" >&2; exit 1; }
slug="$(ticket_slug "$key" "$variation")"
[[ "$branch" =~ ^change/(.+)-fix-([1-9][0-9]*)$ && "${BASH_REMATCH[1]}" == "$slug" ]] \
  || { echo "$command: $branch is no fix branch of $key $variation: change/$slug-fix-<n>; the ticket's own branches are never a fix's" >&2; exit 1; }
n="${BASH_REMATCH[2]}"
[[ -n "${title//[[:space:]]/}" ]] || { echo "$command: the title is empty" >&2; exit 1; }
why="$(cat)"
[[ -n "${why//[[:space:]]/}" ]] || { echo "$command: no description on stdin: say what blocked $key and what the fix changes" >&2; exit 1; }

# The one merge request, as merge-requests.bash's helpers take it: MRS and URLS of a single row (index 0).
URLS="$(jq -nc --arg u "$url" '[$u]')"
on_github "$url" || glab_authenticated "$command"
base="$(mr_default_branch "$command" "$url")"
MRS="$(jq -nc --arg u "$url" --arg b "$branch" --arg base "$base" '[{ repository: $u, branch: $b, base: $base, key: null }]')"
created=false
open="$(mr_find_open "$command" 0)"
if [[ -z "$open" ]]; then
  changes="$(mr_changes "$command" 0)" || { echo "$command: $branch is not on $url's forge; push it first" >&2; exit 1; }
  [[ "$changes" != 0 ]] || { echo "$command: $branch changes nothing against $base" >&2; exit 1; }
  format="$(title_format "$command" "$projects/$project/project.json")"
  full="$(title_of "$format" "$key" "$title" Bug "fix $n, unblocks $key")"
  description="Unblocks $(ticket_reference "$command" "$project" "$key"), which is blocked by the product code this changes. Opened by the harness's Blocked (Repair Project) on its own branch: $key's own branches are not changed; $key waits for this to merge."$'\n\n'"$why"
  open="$(mr_open "$command" 0 "$full" "$description")"
  created=true
fi
mark="!"; on_github "$url" && mark="#"
MRS="$(jq -c --argjson o "$open" --arg mark "$mark" '.[0].key = ($mark + ($o.iid | tostring)) | .[0].url = $o.url' <<< "$MRS")"
[[ "$created" != true ]] || mr_ready "$command" 0
row="$(jq -c --argjson n "$n" --arg t "$title" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.[0] | { n: $n, repository, branch, base, key, url, status: "Open", title: $t, "opened-at": $at }' <<< "$MRS")"
update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --argjson row "$row" '
  .variations |= map(if .name != $name or .["is-deleted"] then . else
    .["fix-merge-requests"] = ([.["fix-merge-requests"] // [] | .[] | select(.url != $row.url)] + [$row]) end)'
blocked_log "$project" "$key" "$variation" "Repair Project" "$([[ "$created" == true ]] && echo Opened || echo Reused) the fix merge request $(jq -r .key <<< "$row") ($(jq -r .url <<< "$row")) on $branch in $url, against $base: \"$title\". $key waits for it to merge; its own branches are not changed. Why:"$'\n'"$why"
jq -c --argjson c "$created" '{ "fix-merge-request": .url, key, branch, repository, base, created: $c }' <<< "$row"
