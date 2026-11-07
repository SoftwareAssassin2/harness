#!/usr/bin/env bash
# Description: Record Write Execution Plan's planned merge requests on a ticket variation — ticket:set-merge-request-plan <project> <ticket-key> <variation> <json-file|->.
set -euo pipefail

# <json-file> (stdin for "-", ASS-182: how a VM, whose /mnt/ticket is
# read-only, gives it) holds the whole plan, an array of { id, repository, contents,
# depends-on }: id a positive whole number Write Execution Plan gives each
# merge request, stable over the ticket's life and never reused; repository
# the url of one of the project's repositories (project.json repositories);
# contents what it holds; depends-on the ids it waits on (default none), each
# planned now or before. It is merged by id into the variation's
# merge-request in the active sprint (ASS-80): an id already there keeps its
# status, key, url and build-status, only its repository, contents and
# depends-on rewritten; a new id is added with status "Not Created" and key,
# url and build-status null; an id missing from the file stays as it is. The
# harness names each branch: change/<KEY>-<id>, change/<KEY>.<variation>-<id>
# for a variation other than A. A status goes Not Created → Open → Merged or
# Closed. Prints the variation's merge-request. Fails, writing nothing, when
# the file is not such an array (or repeats an id), a repository is not the
# project's, a depends-on is not planned, or the ticket or variation is
# missing.
#
# A fast-tracked ticket (fast-track: true, ASS-83) may plan none (ASS-151): a
# golden-image rebuild changes no code, so [] is accepted, recording nothing
# new, and the steps after it pass with nothing to build or merge
# (merge-requests.bash load_merge_requests). Any other ticket plans at least one.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

[[ $# -eq 4 ]] || { echo "usage: ticket:set-merge-request-plan <project> <ticket-key> <variation> <json-file|->" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3" file="$4"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:set-merge-request-plan: invalid project '$project'" >&2; exit 1; }
[[ "$file" == - || -f "$file" ]] || { echo "ticket:set-merge-request-plan: no file $file" >&2; exit 1; }
input="$file"; [[ "$file" != - ]] || input=/dev/stdin
none=false
[[ "$(ticket_field ticket:set-merge-request-plan "$project" "$key" fast-track 2>/dev/null)" != true ]] || none=true
plan="$(jq -c --argjson none "$none" '
  def whole: type == "number" and . >= 1 and . == floor;
  if type == "array" and (length > 0 or $none) and ([.[].id] | unique | length) == length
     and all(.[]; type == "object" and (.id | whole) and (.repository | type) == "string" and (.contents | type) == "string"
                  and ((.["depends-on"] // []) | type == "array" and all(.[]; whole)))
  then map({ id, repository, contents, "depends-on": (.["depends-on"] // []) }) else empty end' "$input" 2>/dev/null || true)"
[[ -n "$plan" ]] || { echo "ticket:set-merge-request-plan: $file must hold a non-empty array of { id, repository, contents, depends-on }" >&2; exit 1; }
repositories="$(jq -c '[.repositories // [] | .[].url]' "$projects/$project/project.json" 2>/dev/null || echo '[]')"
stranger="$(jq -r --argjson repos "$repositories" 'first(.[].repository | select(IN($repos[]) | not)) // empty' <<< "$plan")"
[[ -z "$stranger" ]] || { echo "ticket:set-merge-request-plan: $stranger is not one of $project's repositories: $(jq -r 'join(", ")' <<< "$repositories")" >&2; exit 1; }

update_whole_ticket ticket:set-merge-request-plan "$project" "$key" --arg name "$variation" --arg slug "$(ticket_slug "$key" "$variation")" --argjson plan "$plan" '
  if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
  | .variations |= map(if .name != $name or .["is-deleted"] then . else
      (.["merge-request"] // []) as $had
      | [$had[].id, $plan[].id | select(. != null)] as $ids
      | (first($plan[]["depends-on"][] | select(IN($ids[]) | not)) // null) as $missing
      | if $missing != null then error("\($command): an MR depends on \($missing), which is not planned") else . end
      | .["merge-request"] = (
          [$had[] | . as $m | (first($plan[] | select($m.id != null and .id == $m.id)) // null) as $p
            | if $p == null then $m else $m + $p + { branch: "change/\($slug)-\($p.id)" } end]
          + [$plan[] | select(.id as $id | all($had[]; .id != $id))
            | { id, repository, branch: "change/\($slug)-\(.id)", contents, "depends-on", status: "Not Created", key: null, url: null, "build-status": null }])
    end)'
variation_field '.["merge-request"] // []' ticket:set-merge-request-plan "$project" "$key" "$variation"
