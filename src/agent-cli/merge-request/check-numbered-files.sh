#!/usr/bin/env bash
# Description: Check each numbered file (a migration, a numbered test) the ticket's merge requests add is above its target branch's highest and taken by no older open merge request in its repository; name each that is not and the free number to use — merge-request:check-numbered-files <project> <ticket-key> <variation>.
set -euo pipefail

# ASS-385. An agent numbers a new migration or numbered test once, then keeps
# that number across rebases while master and other open merge requests take
# it, or move above it: Flyway (outOfOrder=false) rejects a version at or
# below the target's highest, and a project's CI rejects one another open
# merge request claims. grouped-build's Check Numbered Files runs this on the
# host before every Automated Testing (so after every Generate Solution and
# Address Merge Request Feedback push); the grouped prompts that rebase have
# the agent run it before pushing too.
#
# The rules: project.json's "numbered-files" (numbered-files.bash): each
# kind's glob, and the command that prints its next free number, if any.
# For each merge request of the variation's plan neither Merged nor Closed
# that names a repository and branch, in its checkout in the VM
# (/repos/<repository>), origin fetched first: the files its branch (the
# local one, else origin's; none yet, nothing added) adds since its merge base
# with origin/<base> (base its recorded one, else origin's default branch;
# the local branch when origin has none, a stacked base not yet pushed) that a
# kind's glob matches and whose name holds a number. A file the target branch
# already holds at that path is not new. Each kind in each folder is a
# sequence of its own. The other open merge requests in the repository, every
# one but this one, and the files each adds (added or renamed to), come from
# the forge on the host, with the harness's own glab/gh login: GitLab's
# merge_requests?state=opened and …/diffs, GitHub's pulls?state=open and
# …/files.
#
# A file collides when its number is at or below the highest in its sequence
# on the target branch, or another open merge request opened before this one
# (a lower iid; every one, while this one is not yet opened) adds the same
# number there — the older one keeps it, as a CI number-collision check
# decides, so two tickets never both renumber. Where any file of a sequence
# collides, that file and every later one of the branch's in it (by number)
# are renumbered, in order, from the free number: the kind's command's
# output (its last number; run in the checkout, in the VM, with the VM's own
# forge credentials, /run/harness/env, loaded — so a rule script that asks
# the forge can), else, the command missing or failing, one above the highest
# on the target branch and in the other open merge requests; never at or
# below the target's highest or a number the branch keeps, and skipping any
# another open merge request holds. A renumbered name keeps its digits' width.
#
# Writes what it found to the ticket's numbered-files-check-<variation>.md
# (WORK_MANAGED), replaced each run, for Generate Solution to read. Prints
# { checked, collisions: [{ repository, merge-request, file, kind, number,
# renumber-to, rename-to, reason, free-number-from }] }; exits 0 when none
# collides (or there is nothing to check), 1 when any does — naming each file
# and the name to give it on stderr (→ Generate Solution, which renumbers);
# 3 when it could not check: a malformed declaration, no VM, a fetch or
# forge call that failed (→ Blocked).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../numbered-files.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"
command=merge-request:check-numbered-files

[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$project/project.json" ]] || { echo "$command: no project '$project'" >&2; exit 3; }
fail() { echo "$command: $*" >&2; exit 3; }
rules="$(numbered_rules "$command" "$projects/$project/project.json")" || exit 3
results="$(work_path "$command" "$project" "$key" "$variation" "numbered-files-check-$variation.md" 2> /dev/null)" || results=""
heading="# Numbered files check — $key $variation, $(date -u +%Y-%m-%dT%H:%M:%SZ)"$'\n'
write_results() {
  [[ -n "$results" ]] || return 0
  lock_on 9 "$results.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}" && printf '%s' "$1" | replace_file "$results" || echo "$command: could not write $results" >&2
}
nothing() { write_results "$heading"$'\n'"Nothing to check: $1."$'\n'; jq -nc '{ checked: 0, collisions: [] }'; exit 0; }

[[ "$(jq length <<< "$rules")" -gt 0 ]] || nothing "$project declares no numbered files (\"numbered-files\": [])"
plan="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation")" || exit 3
rows="$(jq -c '[to_entries[] | .value + { row: .key } | select((.status | IN("Merged", "Closed") | not) and .repository != null and .branch != null)]' <<< "$plan")"
[[ "$(jq length <<< "$rows")" -gt 0 ]] || nothing "no merge request of the ticket's is open or still to open"
vm="$(vm_of "$command" "$project" "$key" "$variation")" || exit 3
[[ -n "$vm" ]] || fail "$key $variation has no VM: its checkouts are there"
if jq -e 'any(.[]; .repository | startswith("https://github.com/") | not)' <<< "$rows" > /dev/null; then glab_authenticated "$command" || exit 3; fi

# The checkout's git, in /repos/<repository> in the VM: `fetch`; `default`,
# origin's default branch; `added <branch> <base>`, the files the branch adds
# since its merge base with the base; `tree <base>`, every file on the base;
# `next <command>`, the command run with the VM's forge credentials.
GIT='set -euo pipefail
base() { if git rev-parse -q --verify "origin/$1^{commit}" > /dev/null; then echo "origin/$1"
  elif git rev-parse -q --verify "refs/heads/$1^{commit}" > /dev/null; then echo "$1"
  else echo "neither origin/$1 nor a local $1" >&2; exit 1; fi; }
case "$1" in
  fetch) git fetch -q origin ;;
  default) ref="$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/master)"; echo "${ref#origin/}" ;;
  added) if git rev-parse -q --verify "refs/heads/$2^{commit}" > /dev/null; then ref="$2"
    elif git rev-parse -q --verify "origin/$2^{commit}" > /dev/null; then ref="origin/$2"
    else exit 0; fi
    on="$(base "$3")"; git diff --name-only --no-renames --diff-filter=A "$(git merge-base "$on" "$ref")" "$ref" ;;
  tree) git ls-tree -r --name-only "$(base "$2")" ;;
  next) e="${HARNESS_VM_ROOT-}/run/harness/env"; if [ -r "$e" ]; then set -a; . "$e"; set +a; fi; bash -c "$2" ;;
esac'
in_repo() { local repo="$1"; shift; in_project "$command" "$project" "/repos/$repo" "set -- $(printf '%q ' "$@"); $GIT" "$vm"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# numbered <label> <iid> — the numbered files among the paths on stdin, as JSON [{ path, kind, folder, n, label, iid }].
numbered() {
  jq -Rsc --argjson rules "$rules" --arg label "$1" --argjson iid "$2" "$NUMBERED_JQ"'
    ($rules | map(.re = (.glob | glob_re))) as $rules
    | [split("\n")[] | select(. != "") | . as $p | (first($rules[] | select(.re as $re | $p | test($re))) // null) as $r
       | select($r != null and ($p | number) != null)
       | { path: $p, kind: $r.kind, folder: ($p | split("/") | .[:-1] | join("/")), n: ($p | number), label: $label, iid: $iid }]'
}

# others <url> — the repository's open merge requests on its forge, each with the numbered files it adds: [{ path, kind, folder, n, label, iid, branch }].
others() {
  local url="$1" list iid label files all='[]'
  if on_github "$url"; then
    list="$(gh_run "$command" api --paginate "repos/$(path_of "$url")/pulls?state=open&per_page=100" | jq -sc 'add // [] | map({ iid: .number, branch: .head.ref, label: "#\(.number)" })')" || return 1
  else
    list="$(lab "$command" "$url" "/merge_requests?state=opened&per_page=100" --paginate | jq -sc 'add // [] | map({ iid, branch: .source_branch, label: "!\(.iid)" })')" || return 1
  fi
  while IFS=$'\t' read -r iid label branch; do
    if on_github "$url"; then
      files="$(gh_run "$command" api --paginate "repos/$(path_of "$url")/pulls/$iid/files?per_page=100" | jq -sr 'add // [] | .[] | select(.status | IN("added", "renamed", "copied")) | .filename')" || return 1
    else
      files="$(lab "$command" "$url" "/merge_requests/$iid/diffs?per_page=100" --paginate | jq -sr 'add // [] | .[] | select(.new_file or .renamed_file) | .new_path')" || return 1
    fi
    all="$(jq -c --argjson more "$(numbered "$label" "$iid" <<< "$files")" --arg b "$branch" '. + ($more | map(.branch = $b))' <<< "$all")"
  done < <(jq -r '.[] | [.iid, .label, .branch] | @tsv' <<< "$list")
  echo "$all"
}

# judge — the collisions of one merge request's files ($own), against its target ($target), the other open merge requests ($others) and
# the free numbers the kinds' commands gave ($next, by kind): [{ …file, to, renamed, reason, from }].
JUDGE="$NUMBERED_JQ"'
  def seq: "\(.kind)\t\(.folder)";
  def renamed($k): split("/") as $p | ($p | last | capture("^(?<pre>[^0-9]*)(?<d>[0-9]+)(?<post>.*)$")) as $c
    | ($k | tostring) as $s | (($c.d | length) - ($s | length)) as $pad
    | ($p[:-1] + [$c.pre + (if $pad > 0 then "0" * $pad else "" end) + $s + $c.post]) | join("/");
  ($target | map(.path)) as $there
  | [$own[] | select(.path as $p | any($there[]; . == $p) | not)] | group_by(seq) | map(
      . as $files | (.[0] | seq) as $s | .[0].kind as $kind
      | ([$target[] | select(seq == $s) | .n] | max // 0) as $T
      | [$others[] | select(seq == $s)] as $theirs
      | [$theirs[] | select($iid == null or .iid < $iid)] as $older
      | [$files[] | . as $f | ([$older[] | select(.n == $f.n) | .label] | unique) as $by
          | if .n <= $T then . + { reason: "\(.n) is at or below the highest on \($base), \($T)" }
            elif $by != [] then . + { reason: "\(.n) is also added by \($by | join(", ")), opened before this one" }
            else empty end] as $bad
      | select($bad != [])
      | ($bad | map(.n) | min) as $L
      | ([$files[] | select(.n < $L) | .n] | max // 0) as $kept
      | [$theirs[].n] as $taken
      | (if $next[$kind] != null then { n: $next[$kind], from: "command" } else { n: ([$T, $kept, ($taken | max // 0)] | max + 1), from: "fallback" } end) as $free
      | reduce ([$files[] | select(.n >= $L)] | sort_by(.n, .path) | .[]) as $f ({ at: ([$free.n, $T + 1, $kept + 1] | max), out: [] };
          (first(range(.at; .at + 1000000) as $k | select(any($taken[]; . == $k) | not) | $k)) as $k
          | .out += [$f + { to: $k, renamed: ($f.path | renamed($k)), from: $free.from,
                            reason: (first($bad[] | select(.path == $f.path) | .reason) // "\($f.n) follows \($L), renumbered with it to keep their order") }]
          | .at = $k + 1)
      | .out[])'

checked=0 collisions='[]' report="$heading" could=""
declare -A next_of=()
for url in $(jq -r '[.[].repository] | unique[]' <<< "$rows"); do
  repo="$(sed -E 's#\.git$##; s#.*/##' <<< "$url")"
  if ! in_repo "$repo" fetch > "$tmp/out" 2>&1; then could+="$repo: could not fetch origin: $(tr '\n' ' ' < "$tmp/out")"$'\n'; continue; fi
  default="$(in_repo "$repo" default 2> "$tmp/out")" || { could+="$repo: $(tr '\n' ' ' < "$tmp/out")"$'\n'; continue; }
  theirs=""
  for j in $(jq -r --arg u "$url" '.[] | select(.repository == $u) | .row' <<< "$rows"); do
    IFS=$'\t' read -r branch base iid label < <(jq -r --argjson j "$j" --arg d "$default" '.[$j] | [.branch, (.base // $d),
      (.key // "" | tostring | ltrimstr("!") | ltrimstr("#") | if test("^[0-9]+$") then . else "null" end), "MR \(.id // "?")\(if .key then " (\(.key))" else "" end)"] | @tsv' <<< "$plan")
    if ! in_repo "$repo" added "$branch" "$base" > "$tmp/added" 2> "$tmp/out"; then could+="$repo $label: $(tr '\n' ' ' < "$tmp/out")"$'\n'; continue; fi
    own="$(numbered "$label" "$iid" < "$tmp/added")"
    [[ "$(jq length <<< "$own")" -gt 0 ]] || continue
    if ! in_repo "$repo" tree "$base" > "$tmp/tree" 2> "$tmp/out"; then could+="$repo $label: $(tr '\n' ' ' < "$tmp/out")"$'\n'; continue; fi
    target="$(numbered "$base" null < "$tmp/tree")"
    if [[ -z "$theirs" ]]; then theirs="$(others "$url")" || { could+="$repo: could not read its open merge requests from the forge"$'\n'; continue; }; fi
    # Every open one but this: by its iid, or, not yet opened, its branch.
    mine="$(jq -c --argjson iid "$iid" --arg b "$branch" 'map(select(if $iid != null then .iid != $iid else .branch != $b end))' <<< "$theirs")"
    checked=$((checked + $(jq --argjson t "$target" '[.[] | select(.path as $p | any($t[]; .path == $p) | not)] | length' <<< "$own")))
    judge() { jq -nc --argjson own "$own" --argjson target "$target" --argjson others "$mine" --argjson iid "$iid" --arg base "$base" --argjson next "$1" "$JUDGE"; }
    found="$(judge '{}')"
    [[ "$found" != '[]' ]] || continue
    # The kinds that collide and declare a command: their free number from it, once per repository and kind.
    next='{}'
    while IFS=$'\t' read -r kind run; do
      if [[ -z "${next_of[$repo/$kind]+x}" ]]; then
        if in_repo "$repo" next "$run" > "$tmp/next" 2> "$tmp/next-error"; then next_of[$repo/$kind]="$(grep -oE '[0-9]+' "$tmp/next" | tail -1 || true)"; else next_of[$repo/$kind]=""; fi
        [[ -n "${next_of[$repo/$kind]}" ]] || report+=$'\n'"⚠ $repo: \`$run\` gave no number (exit/output: $(tr '\n' ' ' < "$tmp/next-error" | cut -c1-300)$(tr '\n' ' ' < "$tmp/next" | cut -c1-200)); the fallback is used"$'\n'
      fi
      [[ -z "${next_of[$repo/$kind]}" ]] || next="$(jq -c --arg k "$kind" --argjson n "$((10#${next_of[$repo/$kind]}))" '.[$k] = $n' <<< "$next")"
    done < <(jq -r --argjson rules "$rules" '[.[].kind] | unique[] as $k | $rules[] | select(.kind == $k and .command != null) | [.kind, .command] | @tsv' <<< "$found")
    found="$(judge "$next")"
    collisions="$(jq -c --argjson f "$found" --arg r "$repo" --arg b "$branch" --arg base "$base" '. + ($f | map({ repository: $r, "merge-request": .label, branch: $b, base: $base, file: .path, kind, number: .n,
      "renumber-to": .to, "rename-to": .renamed, reason, "free-number-from": .from }))' <<< "$collisions")"
  done
done

lines="$(jq -r --argjson rules "$rules" '.[] | "- \(.repository) \(.["merge-request"]) (\(.branch)): \(.file) → \(.["rename-to"]) — \(.kind) \(.reason); free number \(.["renumber-to"]) from " + (. as $c | if .["free-number-from"] == "command" then "`\(first($rules[] | select(.kind == $c.kind)) | .command)`" else "one above the highest on \(.base) and in the other open merge requests" end)' <<< "$collisions")"
n="$(jq length <<< "$collisions")"
if [[ $n -gt 0 ]]; then
  report+=$'\n'"## ✗ $n numbered file(s) collide: renumber each (git mv, and every reference to it, the recorded automated tests included), then push"$'\n\n'"$lines"$'\n'
else
  report+=$'\n'"## ✓ $checked numbered file(s) the ticket's merge requests add: none collides with its target branch or another open merge request"$'\n'
fi
[[ -z "$could" ]] || report+=$'\n'"## ⚠ Could not check"$'\n\n'"$could"
write_results "$report"
[[ -z "$could" ]] || { echo "$command: could not check every repository: $could" >&2; exit 3; }
if [[ $n -gt 0 ]]; then
  { echo "$command: $n numbered file(s) the ticket's merge requests add collide with their target branch or another open merge request; renumber each (git mv, and every reference to it, the recorded automated tests included), then push:"; echo "$lines"; } >&2
  jq -nc --argjson c "$checked" --argjson l "$collisions" '{ checked: $c, collisions: $l }'
  exit 1
fi
jq -nc --argjson c "$checked" '{ checked: $c, collisions: [] }'
