#!/usr/bin/env bash
# Description: Add the repository a blocked ticket needs to its project, when the harness can access it — project:add-repository <project> <ticket-key> <variation> <url|->.
set -euo pipefail

# Blocked's repair for a ticket blocked because its work needs a repository
# the project does not list (ASS-121; grouped-blocked's Add the Missing
# Repository, the url its Troubleshoot named). The one way a repository is
# ever added: no scan, nothing added for any other reason, nothing removed.
# - None named (- or empty), or one project.json already lists (its url,
#   .git and case aside): nothing added, exit 2 — the block is repaired as
#   any other environment issue.
# - One another project's project.json lists (ASS-160): that project's, never
#   copied into this one (one project's work stays in that project). Not added, no
#   forge asked; exit 4, printing { ai-feedback-short, ai-feedback-long }
#   for Blocked for Human: the ticket needs that project's access — it
#   belongs in that project or must be done on the Mac.
# - Asked read-only whether the harness can access it — `gh repo view` for
#   github.com, `glab repo view` for any other host — and given the forge's
#   description and default branch. Refused, or on no forge either answers
#   for: not added; exit 3, printing why as { ai-feedback-short,
#   ai-feedback-long } for Blocked for Human.
# - Else appended to project.json's repositories in the shape the others
#   have, Active (so the downloader reads it), its description the forge's
#   first line, its work-space branch the forge's default; then downloaded
#   into the variation's VM when its Setup is complete (vm:create clones
#   every repository the VM lacks); a VM not set up yet gets it when Setup
#   runs vm:create again. Prints { repository, added, downloaded }.
# A download that fails leaves the repository added and exits 1, naming why
# as ai-feedback. Fails (1) on a bad project or variation too.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

command=project:add-repository
[[ $# -eq 4 ]] || { echo "usage: $command <project> <ticket-key> <variation> <url|->" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$1/project.json" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3" url="${4%/}"
json="$projects/$project/project.json"
variation_exists "$command" "$project" "$key" "$variation"
why() { jq -nc --arg s "$1" --arg l "$2" '{ "ai-feedback-short": $s, "ai-feedback-long": $l }'; echo "$command: $2" >&2; }

[[ -n "$url" && "$url" != - ]] || { echo "$command: no missing repository named: nothing to add" >&2; exit 2; }
# Whether a project.json lists the url, .git, a trailing / and case aside.
lists() { jq -e --arg u "$url" 'def norm: ascii_downcase | sub("\\.git$"; "") | sub("/$"; ""); any(.repositories[]?; (.url // "" | norm) == ($u | norm))' "$1" >/dev/null 2>&1; }
if lists "$json"; then
  echo "$command: $project already lists $url: nothing to add" >&2; exit 2
fi
for other in "$projects"/*/project.json; do
  owner="$(basename "$(dirname "$other")")"
  [[ "$owner" != "$project" ]] && lists "$other" || continue
  why "Needs $owner's access: $url is $owner's repository" "$key needs $url, a repository of project $owner, which $project must not copy (one project's repositories stay in that project): the ticket belongs in $owner, or must be done on the Mac. Move it there, or do it by hand, then move the ticket on."
  exit 4
done

err="$(mktemp)"; trap 'rm -f "$err"' EXIT   # the forge's complaint, apart from its JSON
case "$url" in
  https://github.com/*) tool=gh; about="$(gh repo view "${url%.git}" --json description,defaultBranchRef --jq '{ description, default_branch: .defaultBranchRef.name }' 2>"$err")" ;;
  https://*) tool=glab; about="$(glab repo view "${url%.git}" --output json 2>"$err")" ;;
  *) why "Needs $url, which the harness cannot access" "$key needs $url, which $project does not list, and it is not an https url on GitHub or GitLab: the harness cannot check or download it. Add it to $project's project.json by hand if it should be, then move the ticket on."; exit 3 ;;
esac || { why "Needs $url, which the harness cannot access" "$key needs $url, which $project does not list, and the harness cannot access it: $tool repo view said: $(cat "$err" - <<< "$about" | grep -m 1 .). Give the harness access to it (or add it by hand), then move the ticket on."; exit 3; }
description="$(jq -r '(.description // "" | split("\n")[0]) // ""' <<< "$about")"
branch="$(jq -r '.default_branch // "master"' <<< "$about")"

update_json "$json" --arg u "$url" --arg d "${description:-$(basename "$url" .git)}" --arg b "$branch" '.repositories = (.repositories // []) + [{
  url: $u, description: $d, status: "Active", "ai-feedback-short": null, "ai-feedback-long": null,
  "work-space": { "server-name": null, branch: $b, folder: null },
  "dev-container": { status: "Stable", "needs-rebuilt": false, "server-name": null, "base-image": null } }]'

downloaded=false
if "$agent" vm:setup-complete "$project" "$key" "$variation" 2>/dev/null; then
  out="$("$agent" vm:create "$project" "$key" "$variation" 2>&1 >/dev/null)" \
    || { why "Added $url to $project, but could not download it" "$url was added to $project's project.json, but downloading it into $key $variation's VM failed: $(paste -sd " " - <<< "$out")"; exit 1; }
  downloaded=true
fi
jq -nc --arg u "$url" --argjson d "$downloaded" '{ repository: $u, added: true, downloaded: $d }'
