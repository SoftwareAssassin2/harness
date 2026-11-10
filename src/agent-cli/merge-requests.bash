# A ticket variation's merge requests on their forges (ASS-81), for the
# merge-request:* commands and code:take-out-of-draft-mode.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"
#   refresh_merge_requests <command> <project> <ticket-key> <variation>   # control's read of them all (below): sets MRS, VIEWS and URLS
#   load_merge_requests <command> <project> <ticket-key> <variation>      # MRS and URLS as recorded, the forge not asked
#   set_merge_request <command> <project> <ticket-key> <variation> <index> '<json object>'   # merged into MRS[<index>]'s row, found by id (MR_ROW)
#   plan_note <project> <ticket-key> <variation> <text>   # a line control appends to the variation's execution-plan-<variation>.md
#   in_order                                    # (jq) the indexes of MRS, each after those it depends on
#   mr_by_id <command> <ticket-key> <variation> <id>   # the index in MRS of planned merge request <id>, created (ASS-238)
#   mr_thread <command> <index> <thread-id>     # fails unless <thread-id> can name a review thread of MRS[<index>] (ASS-239)
#   mr_view / mr_default_branch / mr_find_open / mr_changes / mr_open / mr_retarget / mr_ready / mr_auto_merge
#       each <command> <index> …: one forge call for MRS[<index>]
#   mr_rerun <command> <index>                  # its failed pipeline started again (ASS-346)
#   MR_DEPS                                     # (jq defs) done; unmerged_deps($all): the rows it depends on, neither Merged nor Closed
#   MR_TIME                                     # (jq def) epoch: a forge's ISO 8601 time as seconds
#   mr_close <command> <url>                    # the merge request at <url> closed on its forge, unmerged (ASS-104)
#
# Each merge request is on its own repository's forge: a planned one (ASS-80)
# names its repository; one merge-request:create recorded from the worktree
# (the current engines, no repository) is on the workspace's origin. GitHub
# (github.com) is driven with gh --repo; GitLab, for a planned one, through
# its API (glab api --hostname), never from a checkout, since glab otherwise
# takes its host from the cwd's remotes; the worktree's own with glab mr, as
# before. gh_run and glab_run say what they would run when disabled.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/code.bash"

# MR_ROW — jq defs for writing a row inside the ticket's lock (ASS-177), never
# by an index from a read taken before it: same_mr($m) — this row is $m (its
# planned id; one with none, its key and repository); settle($s) — the
# status $s, but a Merged or Closed one is never made Open (or Not Created)
# again; patch($m; $fields) — $fields merged into $m's row, its status settled.
MR_ROW='def same_mr($m): if $m.id != null then .id == $m.id else .id == null and .key == $m.key and .repository == $m.repository end;
  def settle($s): if (.status | IN("Merged", "Closed")) and ($s | IN("Merged", "Closed") | not) then .status else $s end;
  def patch($m; $fields): map(if same_mr($m) then . + $fields + (if $fields | has("status") then { status: settle($fields.status) } else {} end) else . end);'

# MR_DEPS — done: this row is Merged or Closed (Closed: "nothing to wait
# for", as for a base); unmerged_deps($all): the rows of $all this one's
# depends-on names that are not done, in any repository (one named but not
# in $all is nothing to wait for). merge-request:await-dependencies keeps
# those in another repository (ASS-335); merge-request:check holds back a
# failed pipeline while there are any (ASS-346), and counts an Open one with
# any as needing nothing from Ensure Auto-Merge yet (ASS-351).
MR_DEPS='def done: .status | IN("Merged", "Closed");
  def unmerged_deps($all): . as $m | [ $m["depends-on"][]? as $d | first($all[] | select(.id == $d)) // empty | select(done | not) ];'

# MR_TIME — epoch: an ISO 8601 time as either forge gives it (fractional
# seconds or none; Z or an offset) as seconds since 1970, so GitLab's and
# GitHub's times compare.
MR_TIME='def epoch: capture("^(?<t>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\\.[0-9]+)?(?<z>.*)$") as $c
  | ($c.t + "Z" | fromdateiso8601) - ($c.z | if test("^[+-][0-9]{2}:?[0-9]{2}$") then (.[1:3] | tonumber) * 3600 + (.[-2:] | tonumber) * 60 | if $c.z[0:1] == "-" then -. else . end else 0 end);'

# refresh_merge_requests reads every created merge request's live state from
# its forge and records it by id, deterministically: status Open, Merged or
# Closed as the forge says, but never Merged or Closed back to Open (MR_ROW); each planned one not yet Merged or Closed gets
# its base — the branch of the last of its depends-on still unmerged in the
# same repository, else the repository's default branch — and an Open one
# whose target on the forge differs is retargeted there (so a dependent whose
# dependency merged is based on master). Rows are never dropped. Each change
# to a planned one is noted in execution-plan-<variation>.md with why (one recorded from
# a worktree, the current engines', gets only its status). Then MRS is the variation's
# merge-request, VIEWS each one's view (mr_view; null for one not created)
# and URLS each one's repository url, by index. Fails when the variation has
# none, or a forge call fails.
refresh_merge_requests() {
  local command="$1" project="$2" key="$3" variation="$4" i n view views=() defaults='{}' url branch changes base line
  load_merge_requests "$@" || return 1
  n="$(jq length <<< "$MRS")"
  for ((i = 0; i < n; i++)); do
    view=null
    if [[ "$(jq -r ".[$i].key // empty" <<< "$MRS")" ]]; then view="$(mr_view "$command" "$i")" || return 1; fi
    views+=("$view")
  done
  VIEWS="$(printf '%s\n' "${views[@]}" | jq -sc .)"
  for url in $(jq -r '[.[] | select(.id != null and (.status | IN("Merged", "Closed") | not)) | .repository] | unique | .[]' <<< "$MRS"); do
    branch="$(mr_default_branch "$command" "$url")" || return 1
    defaults="$(jq -c --arg u "$url" --arg b "$branch" '.[$u] = $b' <<< "$defaults")"
  done
  # Each one's new status and base, and why it changed: [{ i, status, base, retarget, notes }].
  changes="$(jq -c --argjson views "$VIEWS" --argjson defaults "$defaults" "$MR_ROW"'
    def name: "MR \(.id // .key) (\(.branch // "its branch"))";
    . as $was
    | [range(length) as $i | $was[$i] + (if $views[$i] then { status: ($was[$i] | settle($views[$i].state)) } else {} end)] as $now
    | [range(length) as $i | $now[$i] as $m
       | (if $m.id == null or ($m.status | IN("Merged", "Closed")) then $m.base
          else (last($m["depends-on"][]? as $d | $now[] | select(.id == $d and .repository == $m.repository and (.status | IN("Merged", "Closed") | not))) | .branch)
               // $defaults[$m.repository] end) as $base
       | { i: $i, mr: $was[$i], status: $m.status, base: $base,
           retarget: ($m.status == "Open" and $m.id != null and $views[$i].base != $base),
           notes: ([ (if $m.id != null and $views[$i] and $was[$i].status != $m.status and $was[$i].status != null then "\($m | name) is \($m.status) on the forge, was \($was[$i].status)." else empty end),
                     (if $was[$i].base != null and $was[$i].base != $base then "\($m | name) is based on \($base), not \($was[$i].base): \(first($now[] | select(.branch == $was[$i].base) | "MR \(.id) is \(.status)") // "that branch is gone")." else empty end) ]) }]' <<< "$MRS")"
  while read -r i base; do
    mr_retarget "$command" "$i" "$base" || return 1
  done < <(jq -r '.[] | select(.retarget) | "\(.i) \(.base)"' <<< "$changes")
  while IFS= read -r line; do plan_note "$project" "$key" "$variation" "$line"; done < <(jq -r '.[].notes[]' <<< "$changes")
  if jq -e --argjson was "$MRS" 'any(.[]; .status != $was[.i].status or .base != $was[.i].base)' <<< "$changes" >/dev/null; then
    update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --argjson changes "$changes" "$MR_ROW"'
      .variations |= map(if .name != $name or .["is-deleted"] then . else
        .["merge-request"] |= (reduce $changes[] as $c (.; patch($c.mr; { status: $c.status } + (if $c.base then { base: $c.base } else {} end)))) end)' || return 1
    # Each row as now recorded, in MRS's order, so VIEWS and URLS still line up by index.
    MRS="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation" \
      | jq -c --argjson was "$MRS" "$MR_ROW"'. as $now | $was | map(. as $m | first($now[] | select(same_mr($m))) // $m)')" || return 1
  fi
}

# load_merge_requests — MRS and URLS as recorded, with no forge call but,
# when any is on GitLab, glab_authenticated (code.bash): asked here, in the
# command's own shell, it fails the command at once when glab is logged out,
# and is not asked again by each glab_run in $(…) after. A variation with no
# merge request fails it — but a fast-tracked ticket's (ASS-151: one that
# changes no code, its plan empty), whose MRS is then [], so each command
# passes with nothing to do: merge merges none, check finds nothing to act on.
load_merge_requests() {
  local command="$1" project="$2" key="$3" variation="$4" origin=""
  MRS="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation")" || return 1
  [[ "$(jq length <<< "$MRS")" -gt 0 || "$(ticket_field "$command" "$project" "$key" fast-track)" == true ]] || { echo "$command: $key $variation has no merge request" >&2; return 1; }
  if jq -e 'any(.[]; .repository == null)' <<< "$MRS" >/dev/null; then origin="$(repo_url "$(workspace_of "$command" "$project")")" || return 1; fi
  URLS="$(jq -c --arg origin "$origin" 'map(.repository // $origin)' <<< "$MRS")"
  if jq -e 'any(.[]; startswith("https://github.com/") | not)' <<< "$URLS" >/dev/null; then glab_authenticated "$command" || return 1; fi
}

set_merge_request() {
  local command="$1" project="$2" key="$3" variation="$4" fields="$6" m
  m="$(jq -c --argjson i "$5" '.[$i]' <<< "$MRS")"
  update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --argjson m "$m" --argjson fields "$fields" "$MR_ROW"'
    .variations |= map(if .name != $name or .["is-deleted"] then . else .["merge-request"] |= patch($m; $fields) end)'
  MRS="$(jq -c --argjson m "$m" --argjson fields "$fields" "$MR_ROW"'patch($m; $fields)' <<< "$MRS")"
}

plan_note() {
  local folder="$projects/$1/work/$2"
  mkdir -p "$folder"
  append_line "$folder/execution-plan-$3.md" "$(printf -- '- %s control, variation %s: %s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" "$4")"
}

in_order() {
  echo '. as $all | { out: [], left: [range(length)] }
    | until(.left == []; .out as $done
        | (first(.left[] | select(all($all[.]["depends-on"][]?; . as $d | any($done[]; $all[.].id == $d) or all($all[]; .id != $d)))) // .left[0]) as $n
        | .out += [$n] | .left -= [$n])
    | .out'
}

mr_by_id() {
  local i
  [[ "$4" =~ ^[0-9]+$ ]] || { echo "$1: <id> must be a planned merge request's id, not '$4'" >&2; return 1; }
  i="$(jq --argjson id "$4" 'map(.id == $id and .key != null) | index(true) // empty' <<< "$MRS")"
  [[ -n "$i" ]] || { echo "$1: $2 $3 has no created merge request $4" >&2; return 1; }
  echo "$i"
}

# mr_thread — a thread id is letters, digits, _ = -, so it stays one path
# segment on GitLab, where the merge request's own path holds it; GitHub's
# are global node ids, so the forge is asked that it is this pull request's.
mr_thread() {
  local url iid repo
  [[ "$3" =~ ^[A-Za-z0-9_=-]+$ ]] || { echo "$1: <thread-id> must be a thread's id from merge-request:view, not '$3'" >&2; return 1; }
  IFS=$'\t' read -r url iid _ < <(mr_at "$2")
  on_github "$url" || return 0
  repo="$(path_of "$url")"
  gh_run "$1" api graphql -f query='query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } } } }' -f id="$3" \
    | jq -e --arg repo "$repo" --argjson n "$iid" '.data.node.pullRequest // {} | .number == $n and (.repository.nameWithOwner | ascii_downcase) == ($repo | ascii_downcase)' >/dev/null \
    || { echo "$1: $3 is not a review thread of $(mr_name "$2")" >&2; return 1; }
}

# The merge request at <index>: its repository's url, the path there (group/project), its host, its iid, and whether it is planned.
mr_at() { jq -r --argjson i "$1" --argjson urls "$URLS" '.[$i] | [$urls[$i], (.key // "" | ltrimstr("!") | ltrimstr("#")), (.repository != null)] | @tsv' <<< "$MRS"; }
# The merge request at <index>, as said in a message: MR <id> (<key>), or its key alone for one not planned; its iid.
mr_name() { jq -r --argjson i "$1" '.[$i] | if .id then "MR \(.id) (\(.key))" else .key end' <<< "$MRS"; }
mr_iid_at() { jq -r --argjson i "$1" '.[$i].key | ltrimstr("!") | ltrimstr("#")' <<< "$MRS"; }
host_of() { local u="${1#*://}"; echo "${u%%/*}"; }
path_of() { local u="${1#*://*/}"; echo "${u%.git}"; }
on_github() { [[ "$1" == https://github.com/* ]]; }
enc() { jq -rn --arg s "$1" '$s | @uri'; }
# lab <command> <url> <endpoint> [glab api options…] — GitLab's API for the project at <url>.
lab() { local command="$1" url="$2" endpoint="$3"; shift 3; glab_run "$command" api "projects/$(enc "$(path_of "$url")")$endpoint" --hostname "$(host_of "$url")" "$@"; }

GITLAB_VIEW='{ state: ({ opened: "Open", merged: "Merged" }[.state] // "Closed"), base: .target_branch, title, draft: (.draft == true),
  reasons: [ (if (.blocking_discussions_resolved == false) or .detailed_merge_status == "discussions_not_resolved" then "open-threads" else empty end),
             (if ((.head_pipeline // .pipeline // {}).status // "") | IN("failed", "canceled") then "build-failed" else empty end),
             (if .has_conflicts == true or (.detailed_merge_status | IN("need_rebase", "conflict")) then "needs-rebase" else empty end) ],
  "auto-merge": (.merge_when_pipeline_succeeds == true), "merged-at": .merged_at,
  pipeline: ((.head_pipeline // .pipeline) as $p | if $p then { id: $p.id, "created-at": $p.created_at } else null end) }'
GITHUB_VIEW='def failed: (.conclusion // .state // "") | IN("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT");
  { state: ({ OPEN: "Open", MERGED: "Merged" }[.state] // "Closed"), base: .baseRefName, title, draft: (.isDraft == true),
  reasons: [ (if .reviewDecision == "CHANGES_REQUESTED" then "open-threads" else empty end),
             (if any(.statusCheckRollup // [] | .[]; failed) then "build-failed" else empty end),
             (if .mergeable == "CONFLICTING" or (.mergeStateStatus | IN("BEHIND", "DIRTY")) then "needs-rebase" else empty end) ],
  "auto-merge": (.autoMergeRequest != null), "merged-at": .mergedAt,
  pipeline: ([.statusCheckRollup // [] | .[] | select(failed)] | if . == [] then null
    else { "created-at": (map(.startedAt // empty) | max), runs: ([.[] | .detailsUrl // "" | capture("/actions/runs/(?<r>[0-9]+)").r | tonumber] | unique) } end) }'

# mr_view — { state: Open|Merged|Closed, base, title, draft, reasons, auto-merge, merged-at, pipeline }, reasons as
# merge-request:check names them; merged-at the forge's time it merged (null until then); pipeline its head pipeline
# { id, created-at } on GitLab, on GitHub its failed checks { created-at: the latest started, runs: their workflow
# run ids } (null when none failed).
mr_view() {
  local command="$1" url iid planned out
  IFS=$'\t' read -r url iid planned < <(mr_at "$2")
  if on_github "$url"; then
    out="$(gh_run "$command" pr view "$iid" --repo "$(path_of "$url")" --json state,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,statusCheckRollup,baseRefName,title,isDraft,mergedAt)" || return 1
    jq -ce "$GITHUB_VIEW" <<< "$out" || { echo "$command: no view of #$iid from GitHub" >&2; return 1; }
  else
    if [[ "$planned" == true ]]; then out="$(lab "$command" "$url" "/merge_requests/$iid")" || return 1
    else out="$(glab_run "$command" mr view "$iid" --repo "$(path_of "$url")" -F json)" || return 1; fi
    jq -ce "$GITLAB_VIEW" <<< "$out" || { echo "$command: no view of !$iid from GitLab" >&2; return 1; }
  fi
}

# mr_default_branch <command> <url> — the repository's default branch, from its forge.
mr_default_branch() {
  local command="$1" url="$2" out
  if on_github "$url"; then out="$(gh_run "$command" api "repos/$(path_of "$url")")" || return 1
  else out="$(lab "$command" "$url" "")" || return 1; fi
  jq -re '.default_branch' <<< "$out" || { echo "$command: no default branch for $url" >&2; return 1; }
}

# mr_find_open <command> <index> — { iid, url } of the one open from its branch, else nothing.
mr_find_open() {
  local command="$1" url branch
  IFS=$'\t' read -r url branch < <(jq -r --argjson i "$2" --argjson urls "$URLS" '[$urls[$i], .[$i].branch] | @tsv' <<< "$MRS")
  if on_github "$url"; then gh_run "$command" pr list --repo "$(path_of "$url")" --head "$branch" --state open --json number,url | jq -c 'first(.[] | { iid: .number, url }) // empty'
  else lab "$command" "$url" "/merge_requests?state=opened&source_branch=$(enc "$branch")" | jq -c 'first(.[] | { iid, url: .web_url }) // empty'; fi
}

# mr_changes <command> <index> — how many files its branch changes against its base; fails when the branch is not on the forge.
mr_changes() {
  local command="$1" url branch base
  IFS=$'\t' read -r url branch base < <(jq -r --argjson i "$2" --argjson urls "$URLS" '[$urls[$i], .[$i].branch, .[$i].base] | @tsv' <<< "$MRS")
  if on_github "$url"; then gh_run "$command" api "repos/$(path_of "$url")/compare/$base...$branch" | jq -e '.files | length'
  else
    # GitLab shows a pushed branch a moment after the push: wait for it, up to 30 seconds.
    for _ in $(seq 1 15); do lab "$command" "$url" "/repository/branches/$(enc "$branch")" >/dev/null 2>&1 && break; sleep 2; done
    lab "$command" "$url" "/repository/compare?from=$(enc "$base")&to=$(enc "$branch")" | jq -e '.diffs | length'
  fi
}

# mr_open <command> <index> <title> <description> — opens its draft against its base; prints { iid, url }.
mr_open() {
  local command="$1" url branch base out
  IFS=$'\t' read -r url branch base < <(jq -r --argjson i "$2" --argjson urls "$URLS" '[$urls[$i], .[$i].branch, .[$i].base] | @tsv' <<< "$MRS")
  if on_github "$url"; then
    out="$(gh_run "$command" pr create --repo "$(path_of "$url")" --head "$branch" --base "$base" --title "$3" --body "$4" --draft)" || return 1
    out="$(grep -o 'https://[^ ]*/pull/[0-9]*' <<< "$out" | tail -1)" || { echo "$command: no pull request url came back" >&2; return 1; }
    jq -nc --arg url "$out" '{ iid: ($url | split("/") | last | tonumber), url: $url }'
  else
    lab "$command" "$url" "/merge_requests" -X POST -f "source_branch=$branch" -f "target_branch=$base" -f "title=Draft: $3" -f "description=$4" | jq -ce '{ iid, url: .web_url }'
  fi
}

# mr_retarget <command> <index> <base> — its target on the forge set to <base>.
mr_retarget() {
  local command="$1" url iid planned
  IFS=$'\t' read -r url iid planned < <(mr_at "$2")
  if on_github "$url"; then gh_run "$command" pr edit "$iid" --repo "$(path_of "$url")" --base "$3" >/dev/null
  else lab "$command" "$url" "/merge_requests/$iid" -X PUT -f "target_branch=$3" >/dev/null; fi
}

# mr_ready <command> <index> — out of draft (GitLab's planned ones: "Draft:" dropped from the title, as glab mr update --ready does).
mr_ready() {
  local command="$1" url iid planned title
  IFS=$'\t' read -r url iid planned < <(mr_at "$2")
  if on_github "$url"; then gh_run "$command" pr ready "$iid" --repo "$(path_of "$url")" >/dev/null
  elif [[ "$planned" != true ]]; then glab_run "$command" mr update "$iid" --repo "$(path_of "$url")" --ready >/dev/null
  else
    title="$(mr_view "$command" "$2" | jq -r 'select(.draft) | .title | sub("^(\\[draft\\]|\\(draft\\)|draft:)\\s*"; ""; "i")')" || return 1
    [[ -z "$title" ]] || lab "$command" "$url" "/merge_requests/$iid" -X PUT -f "title=$title" >/dev/null
  fi
}

# mr_auto_merge <command> <index> — set to merge once its checks pass (GitHub: a merge commit).
mr_auto_merge() {
  local command="$1" url iid planned
  IFS=$'\t' read -r url iid planned < <(mr_at "$2")
  if on_github "$url"; then gh_run "$command" pr merge "$iid" --repo "$(path_of "$url")" --auto --merge >/dev/null
  elif [[ "$planned" != true ]]; then glab_run "$command" mr merge "$iid" --repo "$(path_of "$url")" --auto-merge --yes >/dev/null
  else lab "$command" "$url" "/merge_requests/$iid/merge" -X PUT -f merge_when_pipeline_succeeds=true >/dev/null; fi
}

# mr_rerun <command> <index> <view> — its failed pipeline started again, as
# <view> (mr_view) names it (ASS-346). GitLab: a new merge request pipeline
# on its branch as it now is (POST …/merge_requests/<iid>/pipelines, as
# merge-request:update starts one); a project with no merge request
# pipelines refuses that, so its head pipeline's failed jobs are retried
# (POST …/pipelines/<id>/retry). GitHub: each failed check's workflow run
# re-run, its failed jobs only (gh run rerun <run> --failed). Fails when
# nothing could be started (on GitHub, a failed check that is no workflow
# run, which cannot be re-run from here).
mr_rerun() {
  local command="$1" url iid planned pipeline run
  IFS=$'\t' read -r url iid planned < <(mr_at "$2")
  if on_github "$url"; then
    [[ "$(jq '.pipeline.runs // [] | length' <<< "$3")" -gt 0 ]] || return 1
    for run in $(jq -r '.pipeline.runs[]' <<< "$3"); do
      gh_run "$command" run rerun "$run" --failed --repo "$(path_of "$url")" >/dev/null || return 1
    done
  else
    lab "$command" "$url" "/merge_requests/$iid/pipelines" -X POST >/dev/null 2>&1 && return 0
    pipeline="$(jq -r '.pipeline.id // empty' <<< "$3")"
    [[ -n "$pipeline" ]] || return 1
    lab "$command" "$url" "/pipelines/$pipeline/retry" -X POST >/dev/null
  fi
}

# mr_close <command> <url> — gh pr close <url> on GitHub; on GitLab its API's
# state_event=close, the project and iid read from the url (…/-/merge_requests/<iid>),
# so it needs no checkout or recorded repository.
mr_close() {
  local command="$1" url="$2"
  if on_github "$url"; then gh_run "$command" pr close "$url" >/dev/null
  else
    [[ "$url" =~ ^(https://[^/]+/.+)/-/merge_requests/([0-9]+)$ ]] || { echo "$command: $url is not a GitLab merge request" >&2; return 1; }
    lab "$command" "${BASH_REMATCH[1]}" "/merge_requests/${BASH_REMATCH[2]}" -X PUT -f state_event=close >/dev/null
  fi
}
