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
# (ASS-492) Nothing failed, but the ticket's own work is incomplete: Classify
# said own-branch true and the run names a missing change — missing-change
# (what the merge request must hold) and missing-change-repository (one of
# the project's repositories), from Troubleshoot or Classify — with no
# failing file named (a client ticket: both merge requests merged, the bump of the
# library's version in the app never planned). The change goes on the
# ticket's merge request there still Open or Not Created (nothing planned,
# merge-request-existing names it), else on a new one planned as above
# (plan_new_merge_request, planned-by step "Blocked", its why Classify's
# reasoning — ticket:add-merge-request's rules); no VM read. The finding
# goes into the plan's "## Own-branch fix" section and the run resumes at
# Generate Solution's group, as above, own-branch-source missing-change.
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
missing="$(field missing-change)" missing_url="$(field missing-change-repository)" missing_url="${missing_url%/}" missing_url="${missing_url%.git}"
# The variation's merge requests; named($r): a repository url whose last segment is <repo>.
mrs="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation")"
NAMED='def named($r): (. // "") | sub("\\.git$"; "") | sub("/$"; "") | split("/") | last == $r;'

# resume_step — where it resumes: Generate Solution's top-level group, as fix-resume-step.js lifts and checks a declared step.
resume_step() {
  local found_variation engine
  found_variation="$(variation_field . "$command" "$project" "$key" "$variation")" || return 1
  engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json")"
  jq -nc --arg project "$project" --arg ticket "$key" --argjson variation "$found_variation" --arg engine "$engine" \
    --argjson files "$(engine_files "$project" | jq -Rsc 'split("\n") | map(select(. != ""))')" \
    '{ project: $project, ticket: $ticket, variation: $variation, engine: $engine, engineFiles: $files, declared: "generate-solution",
       declaredBy: "Blocked'"'"'s own-branch fix (ASS-384) declares" }' | node "$here_vm/ticket/fix-resume-step.js"
}
# repo_url_of <repo> — the repository's url: as the ticket's merge requests name it, else as project.json does; "" when neither.
repo_url_of() {
  local u
  u="$(jq -r --arg r "$1" "$NAMED"'first(.[] | select(.id != null and (.repository | named($r))) | .repository) // empty' <<< "$mrs")"
  [[ -n "$u" ]] || u="$(jq -r --arg r "$1" "$NAMED"'first(.repositories // [] | .[] | .url | select(named($r))) // empty' "$projects/$project/project.json")"
  printf '%s' "$u"
}
# mark_planned <id> <why> — (ASS-424) planned-by on its row, as ticket:add-merge-request writes it: control holds the
# ticket in Build (merge-request:await-dependencies) and Release (merge-request:check) until it is built.
mark_planned() {
  update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --argjson id "$1" --arg why "$2" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    .variations |= map(if .name != $name or .["is-deleted"] then . else
      .["merge-request"] |= map(if .id == $id then .["planned-by"] = { step: "Blocked", why: $why, at: $at } else . end) end)'
}
# append_section <text> — the section added to the variation's execution plan, after a blank line when it has any.
plan_name="execution-plan-$variation.md"
append_section() {
  local plan text="$1"
  plan="$(ticket_folder "$command" "$project" "$key")/$plan_name"
  [[ ! -s "$plan" ]] || text=$'\n'"$text"
  append_line "$plan" "$text"
}
attempt="$(jq -r '(.["own-branch-fixes"] // 0) + 1' <<< "$found")"
at="$(date -u +%Y-%m-%d)"

# (ASS-492) No failing file, but a missing change in one of the project's repositories: the ticket's own work, incomplete.
if [[ -z "$file" && -n "$missing" && -n "$missing_url" ]]; then
  repo="${missing_url##*/}"
  [[ "$repo" =~ ^[A-Za-z0-9._-]+$ ]] || no "$missing_url names no repository"
  repo_url="$(repo_url_of "$repo")"
  [[ -n "$repo_url" ]] || no "$missing_url, where the missing change goes, is none of $project's repositories"
  # AC2: its merge request there still Open or Not Created takes the change; else a new one.
  existing="$(jq -c --arg r "$repo" "$NAMED"'first(.[] | select(.id != null and (.repository | named($r)) and (.status | IN("Merged", "Closed") | not)) | { id, branch, status, key }) // null' <<< "$mrs")"
  why_found="$(jq -r '.reasoning // .["root-cause"] // "Classify put the missing change in this ticket'"'"'s own work"' <<< "$found")"
  resume="$(resume_step)"
  planned=null done_names=""
  if [[ "$existing" == null ]]; then
    done_names="$(jq -r --arg r "$repo" "$NAMED"'[.[] | select(.id != null and (.repository | named($r))) | "MR \(.id)\(if .key then " (\(.key))" else "" end)"] | join(", ")' <<< "$mrs")"
    contents="$(jq -r --arg at "$at" --arg url "$repo_url" --arg names "$done_names" --arg v "$variation" '
      "Missing change (Blocked, \($at)): \(.["missing-change"]) in \($url). \(if (.summary // "") != "" then "Blocked found: \(.summary)\(if .summary | test("[.!?]$") then "" else "." end) " else "" end)Nothing failed: the ticket'"'"'s work lacks it\(if $names == "" then "" else "; its merge requests there (\($names)) have merged or closed, so it goes in this new one" end) — execution-plan-\($v).md'"'"'s Own-branch fix section says more."' <<< "$found")"
    planned="$(plan_new_merge_request "$command" "$project" "$key" "$variation" "$repo_url" "$contents")" || exit 1
    mark_planned "$(jq -r .id <<< "$planned")" "Blocked's own-branch fix (missing change): $why_found" || exit 1
  fi
  section="$(jq -r --arg v "$variation" --arg n "$attempt" --arg at "$at" --arg url "$repo_url" --arg repo "$repo" --arg p "$project" \
    --argjson planned "$planned" --argjson existing "$existing" --arg done "$done_names" '
    "## Own-branch fix (\($at), Blocked, variation \($v), attempt \($n))\n",
    "Blocked: \(.summary // "not said"). Cause: \(.["root-cause"] // "not said").",
    "Missing change: \(.["missing-change"]) (in \($url)). Classify: \(.reasoning // "not said")",
    (.evidence // [] | if type == "array" then . else [.] end | if length > 0 then "Evidence:\n" + (map("- \(.)") | join("\n")) else empty end),
    "Nothing failed: this ticket'"'"'s own work is incomplete — no \($p) bug raised, no ticket scope added.",
    (if $planned != null
     then "Step added: make it in a new merge request, MR \($planned.id) (\($repo), branch \($planned.branch), from the latest origin/\($planned.base // "its default branch")), planned for it (Generate Solution builds and opens it).\(if $done == "" then "" else " This ticket'"'"'s merge requests in \($repo) (\($done)) are merged or closed: do not reopen them or push to their branches." end) Then carry on with this plan'"'"'s own work."
     else "Step added: make it on MR \($existing.id) (\($repo), branch \($existing.branch), \($existing.status)), this ticket'"'"'s merge request there still to merge (Generate Solution). Then carry on with this plan'"'"'s own work." end)' <<< "$found")"
  append_section "$section"
  jq -c --arg why "Classify put a missing change in $repo in this ticket's own work: $missing" --arg name "$plan_name" --argjson planned "$planned" --argjson existing "$existing" '
    { "own-branch-fix": true, "own-branch-why": $why, "own-branch-source": "missing-change", "merge-request-planned": $planned, "merge-request-existing": $existing, "plan-revised": $name }
    + . + { "ai-feedback-short": null, "ai-feedback-long": null }' <<< "$resume"
  exit 0
fi

[[ -n "$url" && -n "$file" && -n "$check" ]] || no "Troubleshoot named no failing repository, file and job or assertion, nor a missing change and its repository"
repo="${url##*/}"
[[ "$repo" =~ ^[A-Za-z0-9._-]+$ ]] || no "$url names no repository"
# The file as a path in the repository: its :line (and :column) dropped, a /repos/<repo>/ prefix too.
path="$(sed -E 's/(:[0-9]+)+$//; s#^/repos/[^/]+/##; s#^\./##' <<< "$file")"
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

# Where it resumes: Generate Solution's top-level group.
resume="$(resume_step)"

# 3. (ASS-423) No merge request of the ticket for <repo> still open or to be created: a new one planned for the fix.
planned=null done_names=""
live="$(jq -r --arg r "$repo" "$NAMED"'[.[] | select(.id != null and (.repository | named($r)) and (.status | IN("Merged", "Closed") | not))] | length' <<< "$mrs")"
repo_url="$(repo_url_of "$repo")"
if [[ "$live" == 0 && -n "$repo_url" ]]; then
  new_base="$(jq -r --arg r "$repo" "$NAMED"'last(.[] | select(.id != null and (.repository | named($r)) and .status == "Merged") | .base // empty) // empty' <<< "$mrs")"
  done_names="$(jq -r --arg r "$repo" "$NAMED"'[.[] | select(.id != null and (.repository | named($r))) | "MR \(.id)\(if .key then " (\(.key))" else "" end)"] | join(", ")' <<< "$mrs")"
  contents="$(jq -r --arg at "$at" --arg path "$path" --arg file "$file" --arg url "$url" --arg names "$done_names" --arg base "${new_base:-its default branch}" --arg v "$variation" '
    "Own-branch fix (Blocked, \($at)): \(.summary // "a failure in this ticket'"'"'s own code"). Fix \($file) in \($url)\(if (.["failing-job"] // "") != "" then " (job \(.["failing-job"]))" else "" end)\(if (.["failing-assertion"] // "") != "" then " — \(.["failing-assertion"])" else "" end): \(.["root-cause"] // "see Blocked'"'"'s finding"). \($path) is this ticket'"'"'s own code, not on the latest master; its merge requests there (\(if $names == "" then "none planned" else $names end)) have merged or closed, so the fix goes in this new one, from the latest origin/\($base) — execution-plan-\($v).md'"'"'s Own-branch fix section says more."' <<< "$found")"
  planned="$(plan_new_merge_request "$command" "$project" "$key" "$variation" "$repo_url" "$contents")" || exit 1
  mark_planned "$(jq -r .id <<< "$planned")" "Blocked's own-branch fix: $path is this ticket's own code and its merge requests in $repo have merged or closed" || exit 1
fi

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
append_section "$section"
jq -c --arg why "$why" --arg name "$plan_name" --arg source "$own_in" --argjson planned "$planned" '{ "own-branch-fix": true, "own-branch-why": $why, "own-branch-source": $source, "merge-request-planned": $planned, "plan-revised": $name } + . + { "ai-feedback-short": null, "ai-feedback-long": null }' <<< "$resume"
