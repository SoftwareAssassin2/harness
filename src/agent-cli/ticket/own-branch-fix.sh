#!/usr/bin/env bash
# Description: Send a blocked ticket back to fix a failure that is in its own code (its branch, or a merge request of it that merged), not on master — ticket:own-branch-fix <project> <ticket-key> <variation> <run-id>.
set -euo pipefail

# ASS-384. grouped-blocked runs it after project:check-on-master found no
# failure on the latest master (absent, exit 3, or not proven, exit 4) for a
# block Classify put in the project's code: a failure there that is in what
# the ticket's own code adds or changes is a defect the agents made and can
# fix (a migration number another merge request took first, a check its own
# file fails), not the operator's. It is the ticket's own code when all hold:
# - Classify said so (its own-branch: true), from the Blocked run's
#   structured-output (<run-id>, as ticket:plan-obstacle-fix reads it);
# - Troubleshoot named the failing check — the failing repository, the
#   failing file (failing-file, a path in it, :line allowed) and the job or
#   assertion that fails on it;
# - that file is one the ticket's code adds or changes, either
#   - in the variation's branch: in its VM's checkout of the repository
#     (/repos/<basename>, in_project through limactl), among the files
#     changed since the merge base with origin/<base> (the merge request's
#     base for that repository, else origin's default branch) — committed,
#     not committed, or new and untracked; or
#   - (ASS-423) in a merge request of the ticket for that repository that has
#     merged: its diff on the forge (merge-requests.bash mr_files: GitLab's
#     …/merge_requests/<iid>/diffs, GitHub's …/pulls/<n>/files), not the VM's
#     checkout, which shows nothing of it once it merged. A merged merge
#     request does not end the ticket's ownership of its code.
# Then (ASS-423) when no merge request of the ticket for that repository is
# still open or to be created (every one Merged or Closed), a new one is
# planned through ticket:set-merge-request-plan — the next unused id, its
# branch change/<KEY>-<id> (the plan names it), based on the merged one's
# base (the latest origin/<base>), its contents saying what to fix and why —
# so Generate Solution builds and opens it; one still open keeps the fix, as
# before. The finding (summary, root cause, failing check, file:line,
# evidence, the master evidence, and where the fix goes: the new merge
# request, named, the merged branches never reopened or pushed to) is
# appended to the variation's execution-plan-<variation>.md as an "##
# Own-branch fix" section (one locked append, as plan-obstacle-fix's), which
# Generate Solution reads first; the step the ticket resumes at is Generate
# Solution's top-level group, lifted and checked as a landed fix's is
# (fix-resume-step.js, engine.js whyNotResume: at or before the step it
# blocked at — Build, for a block from Release or QA — else that step).
# Prints { own-branch-fix: true, own-branch-why, own-branch-source (branch or
# merged), merge-request-planned ({ id, repository, branch, base } or null),
# plan-revised, resume-at, resume-source, resume-why, resume-ignored,
# ai-feedback-short: null, ai-feedback-long: null } — the nulls clear
# check-on-master's not-proven feedback from the run, so the ticket is not
# marked as handed to the operator — and exits 0; control (engine.js
# ownBranchFix) takes resume-at on the parent's return and restarts the visit
# counts (cause own-branch-fix).
# Anything not shown — Classify did not say so, nothing named, the file
# neither the branch's (or no VM to read it in) nor in a merged merge
# request's diff — prints { own-branch-fix: false, own-branch-why } and
# exits 3, writing nothing: grouped-blocked goes on as before (the obstacle
# fix on absent, Blocked for Human with check-on-master's feedback on not
# proven). The attempts count toward ticket:fix-attempts's budget. Fails (1)
# on bad arguments, a bad variation, an unknown run, or a new merge request
# that could not be planned.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/merge-requests.bash"
assignments="${ASSIGNMENTS_FILE:-$here_vm/../../data/assignments.json}"

command=ticket:own-branch-fix
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <run-id>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" id="$4"
variation_exists "$command" "$project" "$key" "$variation"
found="$(jq -c --arg id "$id" 'first(.["transient-state-engines"] // [] | .[] | select(.id == $id) | .["structured-output"] // {})' "$assignments")"
[[ -n "$found" ]] || { echo "$command: no run $id" >&2; exit 1; }

no() { jq -nc --arg why "$1" '{ "own-branch-fix": false, "own-branch-why": $why }'; echo "$command: not the ticket's own code: $1" >&2; exit 3; }
field() { jq -r --arg f "$1" '.[$f] // "" | if type == "string" then . else tostring end' <<< "$found"; }

[[ "$(jq -r '.["own-branch"] == true' <<< "$found")" == true ]] || no "Classify did not put the cause in the ticket's own branch"
url="$(field failing-repository)" url="${url%/}" url="${url%.git}"
file="$(field failing-file)" check="$(field failing-job)"
[[ -n "$check" ]] || check="$(field failing-assertion)"
[[ -n "$url" && -n "$file" && -n "$check" ]] || no "Troubleshoot named no failing repository, file and job or assertion"
repo="${url##*/}"
[[ "$repo" =~ ^[A-Za-z0-9._-]+$ ]] || no "$url names no repository"
# The file as a path in the repository: its :line (and :column) dropped, a /repos/<repo>/ prefix too.
path="$(sed -E 's/(:[0-9]+)+$//; s#^/repos/[^/]+/##; s#^\./##' <<< "$file")"
# The variation's merge requests; named($r): a repository url whose last segment is <repo>.
mrs="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation")"
NAMED='def named($r): (. // "") | sub("\\.git$"; "") | sub("/$"; "") | split("/") | last == $r;'
base="$(jq -r --arg r "$repo" "$NAMED"'first(.[] | select(.repository | named($r)) | .base // empty) // empty' <<< "$mrs")" || base=""

# 1. The branch: in /repos/<repo>, the branch checked out, then each file changed since the merge base with origin/<base>.
own_in="" branch="" nots=()
vm="$(vm_of "$command" "$project" "$key" "$variation")" || exit 1
if [[ -z "$vm" ]]; then nots+=("$key $variation has no VM, so no branch of its own to read")
elif ! changed="$(in_project "$command" "$project" "/repos/$repo" "set -euo pipefail; base=$(printf '%q' "$base")
  [ -n \"\$base\" ] || { ref=\"\$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/master)\"; base=\"\${ref#origin/}\"; }
  git symbolic-ref -q --short HEAD || echo HEAD
  mb=\"\$(git merge-base HEAD \"origin/\$base\")\"
  { git diff --name-only \"\$mb\"; git ls-files --others --exclude-standard; } | sort -u" "$vm" 2>/dev/null)"; then
  nots+=("the branch in $vm's /repos/$repo could not be read")
else
  branch="$(head -n 1 <<< "$changed")"
  if grep -qxF -- "$path" <<< "$(tail -n +2 <<< "$changed")"; then own_in=branch
  else nots+=("$path is not one the branch $branch in $repo adds or changes"); fi
fi

# 2. (ASS-423) The ticket's merged merge requests for <repo>: each one's diff on its forge.
merged=() unread=()
if [[ -z "$own_in" ]]; then
  MRS="$mrs" URLS="$(jq -c 'map(.repository // "")' <<< "$mrs")"
  indexes="$(jq -r --arg r "$repo" "$NAMED"'to_entries[] | select(.value.id != null and .value.status == "Merged" and (.value.key // "") != "" and (.value.repository | named($r))) | .key' <<< "$mrs")"
  # glab's login asked once here, not by each call (a logged-out glab: each merged one unread, below).
  if grep -q . <<< "$indexes" && jq -e 'any(.[]; . != "" and (startswith("https://github.com/") | not))' <<< "$URLS" >/dev/null; then glab_authenticated "$command" 2>/dev/null || true; fi
  for i in $indexes; do
    if files="$(mr_files "$command" "$i")"; then
      ! grep -qxF -- "$path" <<< "$files" || merged+=("$(mr_name "$i")")
    else unread+=("$(mr_name "$i")"); fi
  done
  if (( ${#merged[@]} > 0 )); then own_in=merged
  elif [[ -z "$indexes" ]]; then nots+=("it has no merged merge request in $repo")
  else
    why="none of its merged merge requests in $repo adds or changes it"
    (( ${#unread[@]} == 0 )) || why="its merged $(printf '%s, ' "${unread[@]}" | sed 's/, $//') in $repo could not be read from the forge"
    nots+=("$why")
  fi
fi
[[ -n "$own_in" ]] || no "$(printf '%s; ' "${nots[@]}" | sed 's/; $//')"
merged_names="$(printf '%s, ' "${merged[@]+"${merged[@]}"}" | sed 's/, $//')"
if [[ "$own_in" == branch ]]; then why="$path is one the branch $branch in $repo adds or changes, and the latest master does not show the failure"
else why="$path is one this ticket's merged $merged_names in $repo added or changed, and the latest master does not show the failure"; fi

# Where it resumes: Generate Solution's top-level group, as fix-resume-step.js lifts and checks a declared step.
found_variation="$(variation_field . "$command" "$project" "$key" "$variation")"
engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json")"
resume="$(jq -nc --arg project "$project" --arg ticket "$key" --argjson variation "$found_variation" --arg engine "$engine" \
  --argjson files "$(engine_files "$project" | jq -Rsc 'split("\n") | map(select(. != ""))')" \
  '{ project: $project, ticket: $ticket, variation: $variation, engine: $engine, engineFiles: $files, declared: "generate-solution",
     declaredBy: "Blocked'"'"'s own-branch fix (ASS-384) declares" }' | node "$here_vm/ticket/fix-resume-step.js")"

attempt="$(jq -r '(.["own-branch-fixes"] // 0) + 1' <<< "$found")"
at="$(date -u +%Y-%m-%d)"

# 3. (ASS-423) No merge request of the ticket for <repo> still open or to be created: a new one planned for the fix.
planned=null done_names=""
live="$(jq -r --arg r "$repo" "$NAMED"'[.[] | select(.id != null and (.repository | named($r)) and (.status | IN("Merged", "Closed") | not))] | length' <<< "$mrs")"
repo_url="$(jq -r --arg r "$repo" "$NAMED"'first(.[] | select(.id != null and (.repository | named($r))) | .repository) // empty' <<< "$mrs")"
[[ -n "$repo_url" ]] || repo_url="$(jq -r --arg r "$repo" "$NAMED"'first(.repositories // [] | .[] | .url | select(named($r))) // empty' "$projects/$project/project.json")"
if [[ "$live" == 0 && -n "$repo_url" ]]; then
  new_base="$(jq -r --arg r "$repo" "$NAMED"'last(.[] | select(.id != null and (.repository | named($r)) and .status == "Merged") | .base // empty) // empty' <<< "$mrs")"
  done_names="$(jq -r --arg r "$repo" "$NAMED"'[.[] | select(.id != null and (.repository | named($r))) | "MR \(.id)\(if .key then " (\(.key))" else "" end)"] | join(", ")' <<< "$mrs")"
  contents="$(jq -r --arg at "$at" --arg path "$path" --arg file "$file" --arg url "$url" --arg names "$done_names" --arg base "${new_base:-its default branch}" --arg v "$variation" '
    "Own-branch fix (Blocked, \($at)): \(.summary // "a failure in this ticket'"'"'s own code"). Fix \($file) in \($url)\(if (.["failing-job"] // "") != "" then " (job \(.["failing-job"]))" else "" end)\(if (.["failing-assertion"] // "") != "" then " — \(.["failing-assertion"])" else "" end): \(.["root-cause"] // "see Blocked'"'"'s finding"). \($path) is this ticket'"'"'s own code, not on the latest master; its merge requests there (\(if $names == "" then "none planned" else $names end)) have merged or closed, so the fix goes in this new one, from the latest origin/\($base) — execution-plan-\($v).md'"'"'s Own-branch fix section says more."' <<< "$found")"
  planned="$(plan_new_merge_request "$command" "$project" "$key" "$variation" "$repo_url" "$contents")" || exit 1
  # (ASS-424) planned-by on its row, as ticket:add-merge-request writes it: control holds the ticket in
  # Build (merge-request:await-dependencies) and Release (merge-request:check) until it is built.
  update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --argjson id "$(jq -r .id <<< "$planned")" \
    --arg why "Blocked's own-branch fix: $path is this ticket's own code and its merge requests in $repo have merged or closed" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    .variations |= map(if .name != $name or .["is-deleted"] then . else
      .["merge-request"] |= map(if .id == $id then .["planned-by"] = { step: "Blocked", why: $why, at: $at } else . end) end)' || exit 1
fi

name="execution-plan-$variation.md"
plan="$(ticket_folder "$command" "$project" "$key")/$name"
section="$(jq -r --arg at "$at" --arg v "$variation" --arg n "$attempt" --arg file "$file" --arg path "$path" --arg url "$url" --arg branch "$branch" --arg p "$project" \
  --arg source "$own_in" --arg merged "$merged_names" --arg repo "$repo" --argjson planned "$planned" --arg done "$done_names" '
  "## Own-branch fix (\($at), Blocked, variation \($v), attempt \($n))\n",
  "Blocked: \(.summary // "not said"). Cause: \(.["root-cause"] // "not said").",
  "Failing check: \([$url, (if (.["failing-job"] // "") != "" then "job \(.["failing-job"])" else empty end)] | join(" "))\(if (.["failing-assertion"] // "") != "" then " — \(.["failing-assertion"])" else "" end). File: \($file).",
  (.evidence // [] | if type == "array" then . else [.] end | if length > 0 then "Evidence:\n" + (map("- \(.)") | join("\n")) else empty end),
  "Not on the latest master (\(.["master-evidence"] // "not checked")): " + (if $source == "branch"
    then "the failure is in this ticket'"'"'s own branch \($branch), which adds or changes \($path)"
    else "the failure is in this ticket'"'"'s own code: \($path), which its merged \($merged) in \($repo) added or changed — merged, still this ticket'"'"'s to fix" end)
    + " — no \($p) bug raised, no ticket scope added.",
  (if $planned == null then "Step added: fix it in this ticket'"'"'s own branch (Generate Solution), then carry on with this plan'"'"'s own work."
   else "Step added: fix it in a new merge request, MR \($planned.id) (\($repo), branch \($planned.branch), from the latest origin/\($planned.base // "its default branch")), planned for this fix (Generate Solution builds and opens it). This ticket'"'"'s merge requests in \($repo) (\(if $done == "" then "none planned" else $done end)) are merged or closed: do not reopen them or push to their branches. Then carry on with this plan'"'"'s own work." end)' <<< "$found")"
text="$section"
[[ ! -s "$plan" ]] || text=$'\n'"$section"
append_line "$plan" "$text"
jq -c --arg why "$why" --arg name "$name" --arg source "$own_in" --argjson planned "$planned" '{ "own-branch-fix": true, "own-branch-why": $why, "own-branch-source": $source, "merge-request-planned": $planned, "plan-revised": $name } + . + { "ai-feedback-short": null, "ai-feedback-long": null }' <<< "$resume"
