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
# 3 when it could not check: a malformed declaration, no VM (→ Blocked).
#
# ASS-386: a forge or VM hiccup is not a block. Each forge read (glab auth
# status, the open merge requests and the files each adds) and each git call
# in the VM (fetch, default, added, tree) gets up to 3 attempts, 5s then 15s
# apart (NUMBERED_FILES_RETRY_SLEEPS, the sleeps between attempts; the tests
# make them 0). Still failing, it could not check, and where that goes
# depends on who ran it:
# - at grouped-build's Check Numbered Files (the variation's deepest status):
#   exit 2, the step's waiting-exit-code — control polls it again on its
#   5-minute timer, no visit or failure counted — until 30 minutes have passed
#   since the ticket entered the step (its sub-state-change into it in the
#   variation's state-changes: every run since then failed to check, as any
#   other exit moves it on), then exit 3 (→ Blocked), printing
#   { ai-feedback-short, ai-feedback-long } naming what kept failing (which
#   forge call or VM command, and its last error), which the step's
#   record-script-output hands to the Build step, set as the ticket's health
#   after its move to Blocked. While it waits the variation's ai-feedback says
#   "Check Numbered Files: can't reach <the forge/the VM>, retrying (attempt
#   n, since <time>)", kept with the attempt as numbered-files-wait
#   { entered, since, attempt, feedback } (as ticket:set-ai-feedback writes
#   it, and only when it changes, as await-dependencies' ASS-359); one kept
#   for an earlier entry into the step is not counted on. A run that checks
#   (exit 0 or 1) clears both, the feedback only while it is still that one.
# - anywhere else (an agent running it before a push): exit 3 at once, as
#   before, with nothing written to the variation.
# Any other failure exits 4, never a command's own status (jq's 2 or 3 would
# read as waiting or blocked): it matches no exit, so the step tries again.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-requests.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../numbered-files.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work.bash"
command=merge-request:check-numbered-files
# ASS-386: an unexpected failure exits 4 (see above).
set -E
trap 'exit 4' ERR
read -ra sleeps <<< "${NUMBERED_FILES_RETRY_SLEEPS-5 15}"
WAIT_MINUTES=30

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
  exec 9>&-   # ASS-386: the lock released, so the variation's write after it (update_json, on 9 too) can take its own
}

# ASS-386: forget_wait — the wait kept on the variation dropped, and its feedback with it while it is still the one written here.
forget_wait() {
  update_whole_ticket "$command" "$project" "$key" --arg name "$variation" '
    .variations |= map(if .name != $name or .["is-deleted"] then . else
      (if .["ai-feedback-long"] == .["numbered-files-wait"].feedback then .["ai-feedback-short"] = null | .["ai-feedback-long"] = null else . end)
      | del(.["numbered-files-wait"]) end)'
}
# ran — the check ran (exit 0 or 1): any wait kept for it cleared.
ran() {
  [[ "$(variation_field '.["numbered-files-wait"] != null' "$command" "$project" "$key" "$variation" 2> /dev/null)" == true ]] || return 0
  if forget_wait; then echo "$command: $key $variation: the check ran; its retry feedback cleared" >&2; else echo "$command: could not clear $key $variation's retry feedback" >&2; fi
}
nothing() { write_results "$heading"$'\n'"Nothing to check: $1."$'\n'; ran; jq -nc '{ checked: 0, collisions: [] }'; exit 0; }

[[ "$(jq length <<< "$rules")" -gt 0 ]] || nothing "$project declares no numbered files (\"numbered-files\": [])"
plan="$(variation_field '.["merge-request"] // []' "$command" "$project" "$key" "$variation")" || exit 3
rows="$(jq -c '[to_entries[] | .value + { row: .key } | select((.status | IN("Merged", "Closed") | not) and .repository != null and .branch != null)]' <<< "$plan")"
[[ "$(jq length <<< "$rows")" -gt 0 ]] || nothing "no merge request of the ticket's is open or still to open"
vm="$(vm_of "$command" "$project" "$key" "$variation")" || exit 3
[[ -n "$vm" ]] || fail "$key $variation has no VM: its checkouts are there"

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

# ASS-386: retried <stdout-file> <command…> — the command, up to 3 attempts (the sleeps between them NUMBERED_FILES_RETRY_SLEEPS'),
# its stdout in <stdout-file>, the last attempt's stderr in $tmp/err (err: on one line) and its exit status in $status.
retried() {
  local out="$1" s; shift
  for s in ${sleeps[@]+"${sleeps[@]}"} last; do
    "$@" > "$out" 2> "$tmp/err" && return 0
    status=$?
    [[ "$s" == last ]] || sleep "$s"
  done
  return 1
}
err() { tr '\n' ' ' < "$tmp/err" | cut -c1-500; }
# could_not <what> <line> — the check could not run: <line> says which call failed and its last error; <what>, the forge or the VM, what it could not reach.
could="" reach=""
could_not() { could+="$2"$'\n'; [[ ", $reach, " == *", $1, "* ]] || reach+="${reach:+, }$1"; }

# unreachable — it could not check, after each call's retries: at Check Numbered Files, waiting (exit 2) until WAIT_MINUTES
# since the ticket entered the step, then Blocked (exit 3) with feedback naming what kept failing; anywhere else, exit 3 at once.
unreachable() {
  local was now wait short long
  was="$(variation_field '{
      at: ([.["harness-status"] | recurse(.["sub-status"] // empty) | .state] | last),
      entered: (last(.["state-changes"] // [] | .[] | select([recurse(.["sub-state-change"] // empty)] | last
        | .["to-state"] == "check-numbered-files" and .["from-state"] != "check-numbered-files") | .timestamp) // null),
      kept: .["numbered-files-wait"], long: .["ai-feedback-long"] }' "$command" "$project" "$key" "$variation")" || exit 3
  [[ "$(jq -r .at <<< "$was")" == check-numbered-files ]] || exit 3
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  wait="$(jq -c --arg now "$now" --argjson limit "$WAIT_MINUTES" '
    def secs: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
    (.kept != null and .kept.entered == .entered) as $same
    | { entered, since: (if .entered != null then .entered elif $same then .kept.since else $now end), attempt: (if $same then .kept.attempt + 1 else 1 end) }
    | .over = (($now | secs) - (.since | secs) >= $limit * 60)' <<< "$was")"
  IFS=$'\t' read -r since attempt over < <(jq -r '[.since, .attempt, .over] | @tsv' <<< "$wait")
  if [[ "$over" == true ]]; then
    short="Check Numbered Files: still can't reach $reach after $WAIT_MINUTES minutes (attempt $attempt, since $since); Blocked"
    long="$short. What kept failing, with its last error:"$'\n'"$could"
    forget_wait || true
    echo "$command: $key $variation: $short" >&2
    jq -nc --arg short "$short" --arg long "$long" '{ "ai-feedback-short": $short, "ai-feedback-long": $long }'
    exit 3
  fi
  short="Check Numbered Files: can't reach $reach, retrying (attempt $attempt, since $since)"
  long="$short. What failed, with its last error:"$'\n'"$could"
  if ! jq -e --arg long "$long" '.kept.feedback == $long and .long == $long' <<< "$was" > /dev/null; then
    update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --arg short "$short" --arg long "$long" --argjson wait "$wait" '
      .variations |= map(if .name != $name or .["is-deleted"] then . else
        .["ai-feedback-short"] = $short | .["ai-feedback-long"] = $long | .["numbered-files-wait"] = ($wait | del(.over) | .feedback = $long) end)'
    echo "$command: $key $variation: $short" >&2
  fi
  exit 2
}

# The forge's glab login, when any repository is on GitLab (ASS-386: retried, and a failure waits as any forge call's).
if jq -e 'any(.[]; .repository | startswith("https://github.com/") | not)' <<< "$rows" > /dev/null; then
  retried "$tmp/out" glab_authenticated "$command" || could_not "the forge (GitLab)" "glab auth status: $(err)"
fi

# numbered <label> <iid> — the numbered files among the paths on stdin, as JSON [{ path, kind, folder, n, label, iid }].
numbered() {
  jq -Rsc --argjson rules "$rules" --arg label "$1" --argjson iid "$2" "$NUMBERED_JQ"'
    ($rules | map(.re = (.glob | glob_re))) as $rules
    | [split("\n")[] | select(. != "") | . as $p | (first($rules[] | select(.re as $re | $p | test($re))) // null) as $r
       | select($r != null and ($p | number) != null)
       | { path: $p, kind: $r.kind, folder: ($p | split("/") | .[:-1] | join("/")), n: ($p | number), label: $label, iid: $iid }]'
}

# others <url> — the repository's open merge requests on its forge, each with the numbered files it adds: [{ path, kind, folder, n, label, iid, branch }].
# ASS-386: each read retried (retried); one still failing is named on stderr with its last error.
others() {
  local url="$1" list iid label files all='[]' call
  if on_github "$url"; then
    call="GET repos/$(path_of "$url")/pulls"
    retried "$tmp/forge" gh_run "$command" api --paginate "repos/$(path_of "$url")/pulls?state=open&per_page=100" || { echo "$call: $(err)" >&2; return 1; }
    list="$(jq -sc 'add // [] | map({ iid: .number, branch: .head.ref, label: "#\(.number)" })' "$tmp/forge")" || { echo "$call: unreadable" >&2; return 1; }
  else
    call="GET projects/$(path_of "$url")/merge_requests"
    retried "$tmp/forge" lab "$command" "$url" "/merge_requests?state=opened&per_page=100" --paginate || { echo "$call: $(err)" >&2; return 1; }
    list="$(jq -sc 'add // [] | map({ iid, branch: .source_branch, label: "!\(.iid)" })' "$tmp/forge")" || { echo "$call: unreadable" >&2; return 1; }
  fi
  while IFS=$'\t' read -r iid label branch; do
    if on_github "$url"; then
      call="GET repos/$(path_of "$url")/pulls/$iid/files"
      retried "$tmp/forge" gh_run "$command" api --paginate "repos/$(path_of "$url")/pulls/$iid/files?per_page=100" || { echo "$call: $(err)" >&2; return 1; }
      files="$(jq -sr 'add // [] | .[] | select(.status | IN("added", "renamed", "copied")) | .filename' "$tmp/forge")" || { echo "$call: unreadable" >&2; return 1; }
    else
      call="GET projects/$(path_of "$url")/merge_requests/$iid/diffs"
      retried "$tmp/forge" lab "$command" "$url" "/merge_requests/$iid/diffs?per_page=100" --paginate || { echo "$call: $(err)" >&2; return 1; }
      files="$(jq -sr 'add // [] | .[] | select(.new_file or .renamed_file) | .new_path' "$tmp/forge")" || { echo "$call: unreadable" >&2; return 1; }
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

checked=0 collisions='[]' report="$heading" urls=""
declare -A next_of=()
# ASS-386: each call into the VM and each forge read retried; one still failing is could_not's, named with its last error.
[[ -n "$could" ]] || urls="$(jq -r '[.[].repository] | unique[]' <<< "$rows")"
for url in $urls; do
  repo="$(sed -E 's#\.git$##; s#.*/##' <<< "$url")" host="$(host_of "$url")"
  # A fetch that fails as ssh does (255: limactl shell never reached the VM) is the VM's; any other, git's reach of the forge.
  if ! retried "$tmp/out" in_repo "$repo" fetch; then
    if [[ $status -eq 255 ]]; then could_not "the VM ($vm)" "$repo: could not reach the VM to fetch origin (limactl shell, exit 255): $(err)"
    else could_not "the forge ($host), from the VM ($vm)" "$repo: could not fetch origin (git fetch in the VM, exit $status): $(err)"; fi
    continue
  fi
  retried "$tmp/out" in_repo "$repo" default || { could_not "the VM ($vm)" "$repo: origin's default branch (git in the VM): $(err)"; continue; }
  default="$(< "$tmp/out")"
  theirs=""
  for j in $(jq -r --arg u "$url" '.[] | select(.repository == $u) | .row' <<< "$rows"); do
    IFS=$'\t' read -r branch base iid label < <(jq -r --argjson j "$j" --arg d "$default" '.[$j] | [.branch, (.base // $d),
      (.key // "" | tostring | ltrimstr("!") | ltrimstr("#") | if test("^[0-9]+$") then . else "null" end), "MR \(.id // "?")\(if .key then " (\(.key))" else "" end)"] | @tsv' <<< "$plan")
    retried "$tmp/added" in_repo "$repo" added "$branch" "$base" || { could_not "the VM ($vm)" "$repo $label: the files $branch adds (git diff in the VM): $(err)"; continue; }
    own="$(numbered "$label" "$iid" < "$tmp/added")"
    [[ "$(jq length <<< "$own")" -gt 0 ]] || continue
    retried "$tmp/tree" in_repo "$repo" tree "$base" || { could_not "the VM ($vm)" "$repo $label: the files on $base (git ls-tree in the VM): $(err)"; continue; }
    target="$(numbered "$base" null < "$tmp/tree")"
    if [[ -z "$theirs" ]]; then theirs="$(others "$url" 2> "$tmp/out")" || { could_not "the forge ($host)" "$repo: could not read its open merge requests from the forge: $(tr '\n' ' ' < "$tmp/out")"; continue; }; fi
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
[[ -z "$could" ]] || { echo "$command: could not check every repository: $could" >&2; unreachable; }
ran   # ASS-386: it checked; any wait kept for it cleared.
if [[ $n -gt 0 ]]; then
  { echo "$command: $n numbered file(s) the ticket's merge requests add collide with their target branch or another open merge request; renumber each (git mv, and every reference to it, the recorded automated tests included), then push:"; echo "$lines"; } >&2
  jq -nc --argjson c "$checked" --argjson l "$collisions" '{ checked: $c, collisions: $l }'
  exit 1
fi
jq -nc --argjson c "$checked" '{ checked: $c, collisions: [] }'
