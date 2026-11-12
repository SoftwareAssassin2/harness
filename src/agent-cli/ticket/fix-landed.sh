#!/usr/bin/env bash
# Description: Whether the fix a ticket variation waits on has landed — ticket:fix-landed <project> <ticket-key> <variation>.
set -euo pipefail

# Reads the variation's "waits-on" (ticket:wait-on) and finds that ticket in
# its own project's active sprint, else its backlog. Landed is its ticket
# system status Done with a live variation that went through a merge step —
# merge-pull-request (harness-development) or ensure-auto-merge
# (a GitLab project's own engine) — anywhere in its state changes: top level
# (flat harness-development) or nested in a sub-state-change at any depth
# (grouped/v2 engines, whose merge lives in the release sub-engine; ASS-309).
# A Done ticket with no merge step has landed too when a commit whose subject
# starts "<KEY>:" (the key exactly: ASS-33 is not ASS-335) is reachable from
# the default branch of its project's workspace — code.bash's workspace_of
# (the project's local-pc checkout) and default_branch (origin's default
# branch), read as the local branch and as origin's, last fetched: a ticket
# built by hand and committed straight to the default branch, with no merge
# step (ASS-340). That reads a host checkout, so it is for control's host;
# where the workspace is missing or not a git checkout (inside a VM, say), or
# neither branch can be read, no commit is found and it is not landed.
# A Done ticket with neither has landed too when its fix was a direct edit,
# made after the wait began, to the waiting variation's own inputs (ASS-342):
# one of its work_inputs (work.bash, an allowlist: automated-tests-<variation>
# .json and demo-plan-<variation>.json, which only automated-tests:record and
# ticket:set-demo-plan write) is in the waiting ticket's work folder now with
# content other than ticket:wait-on recorded for it in the variation's
# "wait-began" when the wait began. Nothing else there counts — ticket.json,
# *.lock, step outputs, Blocked's change-log, the obstacle fix
# ticket:plan-obstacle-fix appends to the execution plan: all written by the
# harness on its own while the ticket is blocked or waiting — nor another
# variation's file, an edit made before the wait began (it is in what was
# recorded), or a file removed. A wait recorded before ASS-342, with no
# "wait-began", finds no such edit.
# Prints { waits-on, status,
# landed } and exits 0 once landed; exits 3 when it is Done without a merge,
# such a commit or such an edit (closed without its fix landed: a failed fix
# attempt); 1 until then. When
# the variation waits on nothing, or is missing, exit 4, printing why as { ai-feedback-short, ai-feedback-long } (ASS-107 AC7: the
# fix cannot be waited on).
# ASS-393: a harness fix (its home the harness project, harness-project.bash)
# that landed by a merge or a "<KEY>:" commit is code the running control
# loads only when it starts again: control records the commit it started from
# in data/control-commit-<project> (main.js; data/control-commit for one run
# without --project), and such a fix is landed only once each of its commits
# on the default branch — a "<KEY>:" subject, or the merge of its change/<KEY>
# branch — is an ancestor of that commit (read in the harness's workspace,
# else this checkout). Until then exit 1, printing { waits-on, status, landed:
# false, awaiting-restart: <fix> }, the variation's awaiting-restart set to
# the fix's key (the dashboard's one "Restart to load <n> landed fixes"
# notice counts them, never as Operator Needed) and its Health "Fix <KEY>
# landed; waiting for a harness restart to load it", written and logged only
# when it changes. Once landed, or on any other end, awaiting-restart is
# cleared (and the Health with it, printed as null). With no recorded commit,
# no commit of the fix found, or an ancestry git cannot tell, it lands as
# before, saying so on stderr; a fix in any other project is unchanged.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../code.bash"
source "$here/../work.bash"
source "$here/../harness-project.bash"

# committed <project> <ticket-key> — whether a commit whose subject starts
# "<ticket-key>:" is reachable from the default branch of the project's
# workspace, locally or on origin as last fetched; fails when none is, or the
# workspace or branch cannot be read.
committed() {
  local workspace branch ref refs=()
  workspace="$(workspace_of ticket:fix-landed "$1" 2>/dev/null)" || return 1
  branch="$(default_branch "$workspace")"
  for ref in "refs/heads/$branch" "refs/remotes/origin/$branch"; do
    git -C "$workspace" rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1 && refs+=("$ref")
  done
  [[ ${#refs[@]} -gt 0 ]] || return 1
  git -C "$workspace" log --fixed-strings --grep="$2:" --format=%s "${refs[@]}" 2>/dev/null \
    | awk -v prefix="$2:" 'index($0, prefix) == 1 { found = 1 } END { exit !found }'
}

# fix_commits <workspace> <ticket-key> — ASS-393: the fix's commits on the
# default branch of <workspace>, locally and on origin as last fetched: each
# whose subject starts "<ticket-key>:", or merges its change/<ticket-key>
# branch (change/<KEY>, change/<KEY>.<variation>, change/<KEY>-<n>; not
# change/<KEY>0). One hash a line; nothing when none, or none can be read.
fix_commits() {
  local branch ref refs=()
  branch="$(default_branch "$1")"
  for ref in "refs/heads/$branch" "refs/remotes/origin/$branch"; do
    git -C "$1" rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1 && refs+=("$ref")
  done
  [[ ${#refs[@]} -gt 0 ]] || return 0
  git -C "$1" log --format='%H %s' "${refs[@]}" 2>/dev/null \
    | awk -v key="$2" '{ s = substr($0, index($0, " ") + 1) }
        index(s, key ":") == 1 { print $1; next }
        { i = index(s, "change/" key); if (i && substr(s, i + 7 + length(key), 1) !~ /^[0-9A-Za-z]$/) print $1 }'
}

# loaded <project> <home> <fix> — ASS-393: whether the harness fix <fix> (of
# the harness project <home>) is in the commit the control of <project> runs
# (data/control-commit-<project>, else data/control-commit): each of its
# fix_commits an ancestor of it. Succeeds, saying why on stderr, when that
# cannot be told — no commit recorded, no workspace, none of its commits
# found, or git cannot answer — as fix-landed did before; fails only when one
# of its commits is surely not in it.
loaded() {
  local file="$projects/../control-commit-$1" running workspace commit at rc found=0
  [[ -f "$file" ]] || file="$projects/../control-commit"
  running="$(tr -d '[:space:]' < "$file" 2>/dev/null || true)"
  [[ -n "$running" ]] || { echo "ticket:fix-landed: no commit recorded for $1's control; $3 counted as loaded" >&2; return 0; }
  workspace="$(workspace_of ticket:fix-landed "$2" 2>/dev/null)" || { echo "ticket:fix-landed: $2 has no workspace to find $3's commits in; counted as loaded" >&2; return 0; }
  while read -r commit; do
    [[ -n "$commit" ]] || continue
    found=1 rc=2
    for at in "$workspace" "$here/../../.."; do
      rc=0; git -C "$at" merge-base --is-ancestor "$commit" "$running" 2>/dev/null || rc=$?
      [[ $rc -le 1 ]] && break
    done
    [[ $rc -ne 1 ]] || return 1
    [[ $rc -eq 0 ]] || echo "ticket:fix-landed: cannot tell whether $3's commit $commit is in $running; counted as loaded" >&2
  done < <(fix_commits "$workspace" "$3")
  [[ $found -eq 1 ]] || echo "ticket:fix-landed: no commit of $3 found on $2's default branch; counted as loaded" >&2
  return 0
}

# edited <project> <ticket-key> <variation> <wait-began> — whether one of the
# variation's work_inputs that <wait-began> recorded is in its work folder
# now with other content than then; fails when none is.
edited() {
  local now
  now="$(work_input_digests ticket:fix-landed "$1" "$2" "$3")"
  jq -en --argjson now "$now" --argjson began "$4" --argjson names "$(work_inputs "$3" | jq -Rnc '[inputs]')" '
    any($names[]; . as $n | ($began.inputs // {} | has($n)) and $now[$n] != null and $now[$n] != $began.inputs[$n])' >/dev/null
}

[[ $# -eq 3 ]] || { echo "usage: ticket:fix-landed <project> <ticket-key> <variation>" >&2; exit 1; }
key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
variation="$(jq -c --arg key "$key" --arg name "$3" '
  first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_upcase == $key)) // {} | .variations // [] | map(select(.name == $name)) | first // {}' "$(sprint_file ticket:fix-landed "$1")")"
waits="$(jq -c '.["waits-on"] // empty' <<< "$variation")"
began="$(jq -c '.["wait-began"] | objects' <<< "$variation")"
[[ -n "$waits" ]] || {
  jq -nc --arg l "$key $3 waits on no fix ticket, so it cannot wait for one to land." '{ "ai-feedback-short": "The fix ticket cannot be waited on", "ai-feedback-long": $l }'
  echo "ticket:fix-landed: $key $3 waits on no ticket" >&2; exit 4; }

# ASS-390 AC6: a wait on Blocked's own fix merge request (ticket:wait-on
# --merge-request: waits-on { merge-request, key, repository, branch }) is read
# from its forge (merge-requests.bash mr_view), not a ticket. Merged: landed,
# exit 0, printing { waits-on, status, landed, fix-merge-request,
# ai-feedback-short: null, ai-feedback-long: null } — the nulls clear the
# waiting feedback from the run — and recorded Merged in the variation's
# fix-merge-requests. Closed unmerged: exit 3 with ai-feedback saying so, for
# Blocked for Human (a question for the operator, not a retry: the fix was
# Blocked's own). Open: exit 1, still waiting (no failure counted), the
# variation's Health (ai-feedback-short and -long, written only when it
# changes) naming it, its url, and what it needs — approval (GitLab's
# approvals_left, GitHub's review decision), out of draft, a failed pipeline,
# open threads, a rebase. A forge that cannot be read is still waiting (1).
# Each end is logged in the change log (work.bash blocked_log, AC3).
if [[ "$(jq -r 'has("merge-request")' <<< "$waits")" == true ]]; then
  source "$here/../merge-requests.bash"
  command=ticket:fix-landed project="$1" name="$3" url="$(jq -r '.["merge-request"]' <<< "$waits")"
  MRS="$(jq -c '[{ repository, branch, key }]' <<< "$waits")" URLS="$(jq -c '[.repository]' <<< "$waits")"
  mr="$(jq -r '.key // "the fix merge request"' <<< "$waits")" where="$(path_of "$(jq -r .repository <<< "$waits")")"
  view="$(mr_view "$command" 0 2>/dev/null)" || { echo "$command: $mr in $where could not be read from its forge; still waiting" >&2; exit 1; }
  state="$(jq -r .state <<< "$view")"
  record() {
    update_whole_ticket "$command" "$project" "$key" --arg name "$name" --arg u "$url" --arg s "$1" '
      .variations |= map(if .name != $name or .["is-deleted"] then . else .["fix-merge-requests"] |= map(if .url == $u then .status = $s else . end) end)' 2>/dev/null || true
  }
  case "$state" in
    Merged)
      record Merged
      blocked_log "$project" "$key" "$name" "Await the Fix Merge Request" "The fix merge request $mr ($url) merged: $key resumes."
      jq -nc --argjson w "$waits" --arg u "$url" '{ "waits-on": $w, status: "Merged", landed: true, "fix-merge-request": $u, "ai-feedback-short": null, "ai-feedback-long": null }'
      exit 0 ;;
    Closed)
      record Closed
      blocked_log "$project" "$key" "$name" "Await the Fix Merge Request" "The fix merge request $mr ($url) was closed without merging: handed to the operator."
      jq -nc --argjson w "$waits" --arg u "$url" --arg mr "$mr" --arg where "$where" --arg key "$key" '{ "waits-on": $w, status: "Closed", landed: false, "fix-merge-request": $u,
        "ai-feedback-short": "Fix MR \($mr) in \($where) was closed unmerged",
        "ai-feedback-long": "Blocked'"'"'s Repair Project opened the fix merge request \($mr) (\($u)) to unblock \($key), and it was closed without merging. Reopen and merge it, or fix the block another way, then resolve; or have AI try again." }'
      echo "$command: $mr was closed unmerged" >&2
      exit 3 ;;
  esac
  approvals="$(mr_approvals_left "$command" 0 "$view")"
  needs="$(jq -r --arg a "$approvals" '[ (if $a == "unknown" then "a review approval" elif ($a | tonumber? // 0) > 0 then "\($a) approval\(if $a == "1" then "" else "s" end)" else empty end),
    (if .draft then "taking out of draft" else empty end),
    (.reasons[]? | { "build-failed": "its failed pipeline fixed", "open-threads": "its open threads resolved", "needs-rebase": "a rebase" }[.] // empty) ]
    | if length == 0 then "merging (approval, if its project asks for one)" else join(", ") end' <<< "$view")"
  short="Waits on fix MR $mr in $where: needs approval"
  long="Blocked's Repair Project opened the fix merge request $mr ($url) to unblock $key, which waits for it to merge. It needs a person's approval to merge (now: $needs): review and approve it, then merge it; closed unmerged, $key comes to you."
  was="$(variation_field '.["ai-feedback-long"] // ""' "$command" "$project" "$key" "$name" | jq -r .)"
  if [[ "$was" != "$long" ]]; then
    update_whole_ticket "$command" "$project" "$key" --arg name "$name" --arg s "$short" --arg l "$long" '
      .variations |= map(if .name != $name or .["is-deleted"] then . else .["ai-feedback-short"] = $s | .["ai-feedback-long"] = $l end)'
    echo "$command: $key $name: $long" >&2
  fi
  jq -nc --argjson w "$waits" --arg u "$url" '{ "waits-on": $w, status: "Open", landed: false, "fix-merge-request": $u }'
  exit 1
fi
home="$(jq -r .project <<< "$waits")" fix="$(jq -r .ticket <<< "$waits")"
files=("$(sprint_file ticket:fix-landed "$home")")
backlog="$(dirname "$(dirname "$(dirname "${files[0]}")")")/backlog.json"
[[ -f "$backlog" ]] && files+=("$backlog")
found="$(jq -cs --arg key "$fix" '
  first(.[] | (.features, .bugs, .spikes, .tickets) // [] | .[] | select(.key | ascii_upcase == $key))
  | { status: (.["ticket-system-status"] // null),
      merged: any(.variations // [] | .[] | select(.["is-deleted"] | not) | .["state-changes"] // [] | .[] | .. | objects | select(has("from-state")); .["from-state"] | IN("merge-pull-request", "ensure-auto-merge")) }' "${files[@]}")"
status="$(jq -r '.status // "unknown"' <<< "${found:-null}")"
merged="$(jq -r '.merged // false' <<< "${found:-null}")"
landed=false code=false
[[ "$status" == Done && "$merged" == true ]] && landed=true code=true
[[ "$status" == Done && "$landed" == false ]] && committed "$home" "$fix" && landed=true code=true
[[ "$status" == Done && "$landed" == false && -n "$began" ]] && edited "$1" "$key" "$3" "$began" && landed=true
restart="$(jq -r '.["awaiting-restart"] // empty' <<< "$variation")"
# ASS-393: a harness fix landed in code waits for the running control to load it.
if [[ "$code" == true ]] && is_harness_project "$home" && ! loaded "$1" "$home" "$fix"; then
  short="Fix $fix landed; waiting for a harness restart to load it"
  long="The fix ticket $fix landed in the harness's own repository, but the running control started from a commit without it, so $key would fail again on the same bug. Restart the harness to load it: $key resumes once control runs a commit that contains the fix."
  if [[ "$restart" != "$fix" ]]; then
    update_whole_ticket ticket:fix-landed "$1" "$key" --arg name "$3" --arg f "$fix" --arg s "$short" --arg l "$long" '
      .variations |= map(if .name != $name or .["is-deleted"] then . else .["awaiting-restart"] = $f | .["ai-feedback-short"] = $s | .["ai-feedback-long"] = $l end)'
    blocked_log "$1" "$key" "$3" "Await the Fix" "The fix ticket $fix landed, but the running harness started from a commit without it: $key waits for a harness restart to load it."
    echo "ticket:fix-landed: $key $3: $short" >&2
  fi
  jq -nc --argjson w "$waits" --arg s "$status" --arg f "$fix" '{ "waits-on": $w, status: $s, landed: false, "awaiting-restart": $f }'
  exit 1
fi
cleared='{}'
if [[ -n "$restart" ]]; then
  update_whole_ticket ticket:fix-landed "$1" "$key" --arg name "$3" '
    .variations |= map(if .name != $name or .["is-deleted"] then . else del(.["awaiting-restart"]) | .["ai-feedback-short"] = null | .["ai-feedback-long"] = null end)' 2>/dev/null || true
  cleared='{ "ai-feedback-short": null, "ai-feedback-long": null }'
fi
jq -nc --argjson w "$waits" --arg s "$status" --argjson l "$landed" --argjson c "$cleared" '{ "waits-on": $w, status: $s, landed: $l } + $c'
[[ "$landed" == true ]] && { blocked_log "$1" "$key" "$3" "Await the Fix" "The fix ticket $fix landed (status $status): $key resumes."; exit 0; }
[[ "$status" == Done ]] && { blocked_log "$1" "$key" "$3" "Await the Fix" "The fix ticket $fix is Done without its fix landed: a failed fix attempt; Blocked goes round again."; echo "ticket:fix-landed: $fix is Done without its fix landed" >&2; exit 3; }
exit 1
