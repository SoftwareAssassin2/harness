#!/usr/bin/env bash
# Description: Open the ticket's merge request as a draft — merge-request:create <project> <ticket-key> <variation> [<mr-id>].
set -euo pipefail

# With <mr-id> (the grouped engines, ASS-81): Generate Solution has built and
# pushed that planned merge request's branch (ticket:set-merge-request-plan)
# from the VM, on its base, and the command opens its draft on the forge
# with no checkout. Control reads every one of the variation's merge requests
# first (refresh_merge_requests, merge-requests.bash), so its base is
# current. It is refused while one it depends on is Not Created (they are
# made in depends-on order). An open one from its branch is reused; else,
# when its branch changes nothing against its base, it is marked Closed, not
# opened, and execution-plan-<variation>.md says so; else a draft is opened against its
# base, titled in the project's merge request title format (mr_title below;
# "(MR <id>)" after the ticket's title when the variation has more than
# one), described by the ticket's link (ticket_reference: an
# off-board ticket's "<KEY>: <title>", unlinked) and its contents. Records
# its key (!<iid>, #<number> on GitHub), url, status Open and build-status
# Pending by id; prints { id, status, iid, url, created }. One already Open,
# Merged or Closed is left as it is. Fails, recording nothing, when the
# branch is not on the forge or a forge call fails.
#
# mr_title <project> <key> [<note>] — the title, in project.json's
# "merge-request-title" format (ASS-335, merge-request-title.bash title_of):
# key-summary (the default) "<KEY>: <ticket title>"; conventional "<type>:
# <ticket title> (<KEY>)", a Bug a fix, a Task or Spike a chore, else a feat
# — so a CI mr-title job requiring a conventional commit passes from the
# first pipeline, and the merge request can merge.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-request-title.bash"
mr_title() {
  local format type
  format="$(title_format merge-request:create "$projects/$1/project.json")" || return 1
  type="$(jq -r --arg key "$2" 'def it: select(.key | ascii_downcase == ($key | ascii_downcase));
    first((.bugs // [] | .[] | it | .["issue-type"] // "Bug"), (.spikes // [] | .[] | it | .["issue-type"] // "Spike"), (.features // [] | .[] | it | .["issue-type"] // "Story")) // ""' \
    "$(sprint_file merge-request:create "$1")")" || return 1
  title_of "$format" "$2" "$(ticket_field merge-request:create "$1" "$2" title)" "$type" "${3:-}"
}
if [[ $# -eq 4 ]]; then
  source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"
  project="$1" key="$(upper "$2")" variation="$3" id="$4"
  [[ "$id" =~ ^[0-9]+$ ]] || { echo "merge-request:create: <mr-id> must be a planned merge request's id, not '$id'" >&2; exit 1; }
  refresh_merge_requests merge-request:create "$project" "$key" "$variation"
  i="$(jq --argjson id "$id" 'map(.id) | index($id) // empty' <<< "$MRS")"
  [[ -n "$i" ]] || { echo "merge-request:create: $key $variation has no merge request $id" >&2; exit 1; }
  said() { jq -c --argjson i "$i" --argjson c "$1" '.[$i] | { id, status, iid: (.key // "" | ltrimstr("!") | ltrimstr("#") | tonumber? // null), url, created: $c }' <<< "$MRS"; }
  [[ "$(jq -r ".[$i].status" <<< "$MRS")" == "Not Created" ]] || { said false; exit 0; }
  waiting="$(jq -r --argjson i "$i" '. as $all | first($all[$i]["depends-on"][] as $d | $all[] | select(.id == $d and .status == "Not Created") | .id) // empty' <<< "$MRS")"
  [[ -z "$waiting" ]] || { echo "merge-request:create: MR $id depends on MR $waiting, which is not created yet" >&2; exit 1; }
  created=false
  open="$(mr_find_open merge-request:create "$i")"
  if [[ -z "$open" ]]; then
    changes="$(mr_changes merge-request:create "$i")" || { echo "merge-request:create: could not compare MR $id's branch with its base; push it first" >&2; exit 1; }
    if [[ "$changes" == 0 ]]; then
      set_merge_request merge-request:create "$project" "$key" "$variation" "$i" '{ "status": "Closed" }'
      plan_note "$project" "$key" "$variation" "MR $id ($(jq -r ".[$i].branch" <<< "$MRS")) is Closed, not opened: its branch has no changes against $(jq -r ".[$i].base" <<< "$MRS")."
      said false; exit 0
    fi
    note=""; [[ "$(jq length <<< "$MRS")" -eq 1 ]] || note="MR $id"
    title="$(mr_title "$project" "$key" "$note")"
    description="> $(ticket_reference merge-request:create "$project" "$key")"$'\n\n'"$(jq -r ".[$i].contents" <<< "$MRS")"
    open="$(mr_open merge-request:create "$i" "$title" "$description")"
    created=true
  fi
  mark="!"; on_github "$(jq -r ".[$i]" <<< "$URLS")" && mark="#"
  set_merge_request merge-request:create "$project" "$key" "$variation" "$i" "$(jq -c --arg mark "$mark" '{ key: ($mark + (.iid | tostring)), url, status: "Open", "build-status": "Pending" }' <<< "$open")"
  said "$created"
  exit 0
fi

# From the variation's worktree (code:create-worktree first): the branch
# gets a first empty commit when it has none of its own, is pushed to origin,
# and a draft merge request is opened against origin's default branch —
# titled in the project's format (mr_title above), its description the ticket's link on the
# first line (ticket_reference: an off-board ticket's "<KEY>: <title>",
# unlinked) — unless one from that branch is open already (reused). Records
# [{ key: "!<iid>", build-status: "Pending", url, status: "Open" }] as the variation's
# merge-request and prints { "iid", "url", "created" }. glab does the GitLab
# work (GLAB_DISABLED=1 only says what it would run and records nothing); for
# an origin on GitHub (the harness's own repository) gh opens a pull request
# instead, recorded as "#<number>" (GH_DISABLED=1 the same).
# Fails, writing nothing, when the worktree is not yet made, the push or glab
# fails (at once, before any GitLab call, when glab is not authenticated:
# glab_authenticated, code.bash), or the project, workspace, ticket or
# variation is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

[[ $# -eq 3 ]] || { echo "usage: merge-request:create <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
workspace="$(workspace_of merge-request:create "$project")"
build="$(build_of merge-request:create "$project" "$key" "$variation")"
branch="$(jq -r '.branch // empty' <<< "$build")"
folder="$(jq -r '.["worktree-folder"] // empty' <<< "$build")"
[[ -n "$branch" && -d "$folder" ]] || { echo "merge-request:create: $key $variation has no worktree yet; run code:create-worktree first" >&2; exit 1; }
base="$(default_branch "$workspace")"
repo="$(repo_path "$workspace")"

if [[ "$(git -C "$folder" rev-list --count "origin/$base..$branch" 2>/dev/null || echo 0)" == 0 ]]; then
  git -C "$folder" commit --quiet --allow-empty -m "$key: start" >/dev/null
fi
git -C "$folder" push --quiet -u origin "$branch"
created=false
title="$(mr_title "$project" "$key")"
description="> $(ticket_reference merge-request:create "$project" "$key")"
if [[ "$(forge "$workspace")" == github ]]; then
  # GitHub (the harness's own repository): a pull request, #<number>.
  mark="#"
  open="$(gh_run merge-request:create pr list --repo "$repo" --head "$branch" --state open --json number,url 2>/dev/null || echo '[]')"
  url="$(jq -r 'first(.[]?.url) // empty' <<< "$open" 2>/dev/null || true)"
  if [[ -z "$url" ]]; then
    out="$(gh_run merge-request:create pr create --repo "$repo" --head "$branch" --base "$base" --title "$title" --body "$description" --draft 2>&1)" \
      || { echo "merge-request:create: gh failed: $out" >&2; exit 1; }
    url="$(grep -o 'https://[^ ]*/pull/[0-9]*' <<< "$out" | tail -1 || true)"
    created=true
  fi
  [[ -n "$url" || "${GH_DISABLED:-}" != 1 ]] || { jq -nc '{ iid: null, url: null, created: false }'; exit 0; }
else
  mark="!"
  # Logged in first: the wait below takes any failure for a branch not there yet.
  glab_authenticated merge-request:create || exit 1
  # GitLab shows a pushed branch a moment after the push: wait for it, up to 30
  # seconds, before asking for a merge request on it — asked too soon, the
  # request fails.
  for _ in $(seq 1 15); do
    glab_run merge-request:create api "projects/${repo//\//%2F}/repository/branches/${branch//\//%2F}" >/dev/null 2>&1 && break
    sleep 2
  done
  open="$(glab_run merge-request:create mr list --repo "$repo" --source-branch "$branch" -F json 2>/dev/null || echo '[]')"
  url="$(jq -r 'first(.[]? | select(.state == "opened") | .web_url) // empty' <<< "$open" 2>/dev/null || true)"
  if [[ -z "$url" ]]; then
    # In the worktree: mr create takes its GitLab host from the cwd's remotes, --repo notwithstanding.
    out="$(cd "$folder" && glab_run merge-request:create mr create --repo "$repo" --source-branch "$branch" --target-branch "$base" --title "$title" --description "$description" --draft --yes 2>&1)" \
      || { echo "merge-request:create: glab failed: $out" >&2; exit 1; }
    url="$(grep -o 'https://[^ ]*/-/merge_requests/[0-9]*' <<< "$out" | tail -1 || true)"
    created=true
  fi
fi
if [[ -z "$url" ]]; then
  [[ "${GLAB_DISABLED:-}" == 1 ]] && { jq -nc '{ iid: null, url: null, created: false }'; exit 0; }
  echo "merge-request:create: no merge request url came back" >&2; exit 1
fi
iid="${url##*/}"

update_whole_ticket merge-request:create "$project" "$key" --arg name "$variation" --arg iid "$iid" --arg url "$url" --arg mark "$mark" '
  .variations |= map(if .name == $name then .["merge-request"] = [{ key: ($mark + $iid), "build-status": "Pending", url: $url, status: "Open" }] else . end)'
jq -nc --arg iid "$iid" --arg url "$url" --argjson c "$created" '{ iid: ($iid | tonumber), url: $url, created: $c }'
