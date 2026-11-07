#!/usr/bin/env bash
# Description: Upload a PNG (on stdin) for one of the ticket's merge requests and print the markdown to embed — merge-request:upload-image <project> <ticket-key> <variation> <id> - <name>.
set -euo pipefail

# ASS-238: how a VM agent puts a screenshot where a merge request's
# description can show it — on the host, with the host's glab or gh login.
# <id> is a planned merge request's id, one already created; <name> the
# image's file name (letters, digits, . _ -; ending .png). On GitLab, its
# project's uploads; GitHub has no upload, so the image is committed, through
# the git data API, as <id>/<name> on the branch screenshots/<KEY>-<variation>
# (made, with no parent, by the first image; never merged, never the merge
# request's branch or base), linked pinned to that commit. Prints the
# markdown. Fails, with no forge call, when stdin is not a PNG.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"

[[ $# -eq 6 && "$5" == - ]] || { echo "usage: merge-request:upload-image <project> <ticket-key> <variation> <id> - <name>" >&2; exit 1; }
command=merge-request:upload-image key="$(upper "$2")" variation="$3" id="$4" name="$6"
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.png$ ]] || { echo "$command: <name> must be a file name ending .png, not '$name'" >&2; exit 1; }
dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT
file="$dir/$name"
replace_file "$file" && [[ "$(head -c 8 "$file" | od -An -tx1 | tr -d ' \n')" == 89504e470d0a1a0a ]] || { echo "$command: stdin is not a PNG" >&2; exit 1; }
load_merge_requests "$command" "$1" "$key" "$variation"
i="$(mr_by_id "$command" "$key" "$variation" "$id")"
url="$(jq -r --argjson i "$i" '.[$i]' <<< "$URLS")"

if ! on_github "$url"; then
  lab "$command" "$url" "/uploads" -X POST --form "file=@$file" | jq -re .markdown
  exit 0
fi
repo="$(path_of "$url")" branch="screenshots/$key-$variation"
api() { gh_run "$command" api "repos/$repo/git/$1" "${@:2}"; }
parent="$(api "ref/heads/$branch" 2>/dev/null | jq -r '.object.sha // empty' || true)"
blob="$(base64 < "$file" | tr -d '\n' | jq -Rc '{ content: ., encoding: "base64" }' | api blobs -X POST --input - | jq -re .sha)"
base=""; [[ -z "$parent" ]] || base="$(api "commits/$parent" | jq -re .tree.sha)"
tree="$(jq -nc --arg base "$base" --arg path "$id/$name" --arg sha "$blob" '(if $base != "" then { base_tree: $base } else {} end) + { tree: [{ path: $path, mode: "100644", type: "blob", sha: $sha }] }' \
  | api trees -X POST --input - | jq -re .sha)"
commit="$(jq -nc --arg m "$key $variation: screenshot $name for merge request $id" --arg tree "$tree" --arg parent "$parent" '{ message: $m, tree: $tree, parents: [$parent | select(. != "")] }' \
  | api commits -X POST --input - | jq -re .sha)"
if [[ -n "$parent" ]]; then jq -nc --arg sha "$commit" '{ sha: $sha }' | api "refs/heads/$branch" -X PATCH --input - >/dev/null
else jq -nc --arg ref "refs/heads/$branch" --arg sha "$commit" '{ ref: $ref, sha: $sha }' | api refs -X POST --input - >/dev/null; fi
echo "![$name](https://github.com/$repo/blob/$commit/$id/$name?raw=true)"
