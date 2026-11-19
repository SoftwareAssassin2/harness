# ASS-509: a ticket's branch brought up to date with its base, and a
# numbered file whose number is taken renamed — mechanically, in the
# variation's machine (its VM, or the workstation its step holds), never by
# the operator. Sourced after code.bash (in_project, variation_field):
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../catch-up-base.bash"
#   catch_up_base <command> <project> <key> <variation> <machine> <checked-out-only: yes|no> [<repository>]
#     each of the variation's merge requests neither Merged nor Closed, naming a
#     repository and a branch (only <repository>'s, by its last path segment,
#     when given), in /repos/<repository>: the branch brought up to date with
#     the latest origin/<base>. With yes, only a branch checked out there is
#     touched (a step's own checkout, as automated-tests:verify-success and
#     ci-checks:verify find it); with no, one not checked out is checked out
#     for it, its tree clean, and the checkout put back after. Prints a JSON
#     list, one { repository, branch, base, status, behind, detail } per
#     merge request; never fails on what one finds.
#   renumber_file <command> <project> <key> <machine> <repository> <branch> <base> <file> <rename-to> <reason>
#     the file git mv'd to its new name on the branch, every reference to it
#     in a file the branch adds or changes rewritten (its path, or its name
#     standing alone: never inside a longer name, nor the same name under
#     another folder), only those staged, committed and pushed (never
#     forced). Prints one { status, detail, files } object.
#   rewrite_references <from> <to> — stdin to stdout with the same rule (the
#     recorded automated tests, on the Mac).
#
# A branch behind origin/<base> (the base's commits it lacks: a repository
# check that reads files master added since as deleted) has the base brought
# in. How depends on its merge request (review finding, ASS-509 AC2):
# - not opened on the forge yet (no key): rebased onto origin/<base> and
#   pushed --force-with-lease (the lease its origin copy as just fetched; -u
#   when not on origin yet), as Generate Solution's prompt does by hand — the
#   forge refusing the forced push, the base is merged in instead;
# - opened (it has a key): origin/<base> merged in and pushed plainly —
#   never a rewrite of a branch a merge request on the forge shows, whose
#   review and approvals are of its commits.
# The rebase or merge is made on a detached HEAD and pushed from there; only
# once the push has gone through is the local branch moved to it — so a run
# killed part way leaves the branch as it was, or behind its origin copy
# (fast-forwarded next time), never parted from it. A rebase or merge left
# in progress by such a run is aborted first, and a HEAD left detached at the
# branch's own tip put back on it. Every fetch and push has a time limit
# (CATCH_UP_NET_SECONDS, 300). Origin is fetched with --prune, so a branch
# the forge deleted (merged) is seen gone: one whose merge request has a key
# and whose branch is no longer on origin, or one with no commit of its own
# beyond origin/<base>, is skipped — never pushed again (ASS-423). The
# repository's own git hooks are not run (--no-verify): only the base's
# commits, or a rename, come in. Its statuses:
#   up-to-date      nothing to bring in
#   rebased|merged  brought in and pushed
#   conflict        a rebase (or the merge) that does not apply cleanly: the
#                   branch left exactly as it was — for Generate Solution
#   not-mechanical  changes not committed, or the branch and its origin copy
#                   parted — left as it was, for Generate Solution
#   push-failed     brought in but not pushed: the local branch as it was
#   fetch-failed    origin could not be fetched (twice): nothing changed
#   skipped         not checked out here (yes), not made yet, no origin/<base>,
#                   gone from origin, or nothing of its own beyond the base
CATCH_UP_GIT='set -uo pipefail
export GIT_TERMINAL_PROMPT=0
mode="$1"; shift
field() { printf "%s" "$1" | tr "\t\r\n" "   "; }
say() { printf "%s\t%s\t%s\t%s\n" "$(field "$1")" "$(field "$2")" "$(field "$3")" "$(field "${4:-}")"; exit 0; }
one() { tr "\n\t" "  " | cut -c1-400; }
clean() { [ -z "$(git status --porcelain --untracked-files=no 2> /dev/null)" ]; }
limit="${CATCH_UP_NET_SECONDS:-300}"
net() { if command -v timeout > /dev/null 2>&1; then timeout "$limit" "$@"; else "$@"; fi; }
who=(); [ -n "$(git config user.email)" ] || who=(-c user.name=harness -c user.email=harness@localhost)
back=""
restore() { [ -z "$back" ] || git checkout -q "$back" > /dev/null 2>&1 || true; }
trap restore EXIT
fetch() { err="$(net git fetch -q --prune origin 2>&1)" || err="$(net git fetch -q --prune origin 2>&1)"; }
# settle <branch> — what a run killed part way left: a rebase or merge in progress aborted, a HEAD detached at the branch put back on it.
settle() {
  local gd; gd="$(git rev-parse --absolute-git-dir)"
  if [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; then git rebase --abort > /dev/null 2>&1 || true; fi
  if [ -f "$gd/MERGE_HEAD" ]; then git merge --abort > /dev/null 2>&1 || true; fi
  if ! git symbolic-ref -q HEAD > /dev/null && git show-ref -q --verify "refs/heads/$1" && [ "$(git rev-parse HEAD)" = "$(git rev-parse "refs/heads/$1")" ]; then
    git checkout -q "$1" > /dev/null 2>&1 || true
  fi
}
# onto <branch> <only> — the branch checked out (or why not: say), its tree clean, at least at its origin copy.
onto() {
  local b="$1" only="$2" on
  on="$(git symbolic-ref -q --short HEAD || true)"
  if [ "$on" != "$b" ]; then
    [ "$only" != yes ] || say skipped 0 "$b is not checked out here (on ${on:-a detached HEAD})"
    clean || say not-mechanical 0 "changes not committed on ${on:-a detached HEAD}, so $b could not be checked out"
    if git show-ref -q --verify "refs/heads/$b"; then git checkout -q "$b" > /dev/null 2>&1 || say not-mechanical 0 "$b could not be checked out"
    elif git show-ref -q --verify "refs/remotes/origin/$b"; then git checkout -q -b "$b" --track "origin/$b" > /dev/null 2>&1 || say not-mechanical 0 "$b could not be checked out"
    else say skipped 0 "$b is not made yet"; fi
    back="${on:-$(git rev-parse HEAD)}"
  fi
  clean || say not-mechanical 0 "$b has changes not committed"
  if git show-ref -q --verify "refs/remotes/origin/$b" && ! git merge-base --is-ancestor "origin/$b" HEAD; then
    git merge -q --ff-only "origin/$b" > /dev/null 2>&1 || say not-mechanical 0 "$b and origin/$b have parted (each has commits the other lacks)"
  fi
}
# land <branch> <new sha> — the local branch moved to what was pushed, and checked out there.
land() { git update-ref "refs/heads/$1" "$2" && git checkout -q "$1" > /dev/null 2>&1; }
# merged_in <branch> <old> <base> — origin/<base> merged into <old> on a detached HEAD; fails (conflict files in $files) when it does not apply.
merged_in() {
  git checkout -q --detach "$2" > /dev/null 2>&1 || return 1
  if ! err="$(git "${who[@]+"${who[@]}"}" merge -q --no-verify --no-edit -m "Merge origin/$3 into $1" "origin/$3" 2>&1)"; then
    files="$(git diff --name-only --diff-filter=U | paste -sd, -)"
    git merge --abort > /dev/null 2>&1; git checkout -q -f "$1" > /dev/null 2>&1; git reset -q --hard "$2"
    return 1
  fi
}
case "$mode" in
  catch-up)
    b="$1" base="$2" only="$3" opened="${4:-}"
    settle "$b"
    fetch || say fetch-failed 0 "could not fetch origin: $(one <<< "$err")"
    [ -n "$base" ] || { ref="$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/master)"; base="${ref#origin/}"; }
    git rev-parse -q --verify "origin/$base^{commit}" > /dev/null || say skipped 0 "no origin/$base" "$base"
    # ASS-423: a merge request on the forge whose branch is gone from origin (merged, its branch deleted) is never pushed again.
    if [ -n "$opened" ] && ! git show-ref -q --verify "refs/remotes/origin/$b"; then say skipped 0 "$b is gone from origin (its merge request merged, or the branch deleted): never pushed again" "$base"; fi
    onto "$b" "$only"
    at="$(git rev-parse --short "origin/$base")"
    [ "$(git rev-list --count "origin/$base..HEAD")" -gt 0 ] || say skipped 0 "$b has no commit of its own beyond origin/$base ($at): nothing to bring the base into" "$base"
    behind="$(git rev-list --count "HEAD..origin/$base")"
    [ "$behind" -gt 0 ] || say up-to-date 0 "$b has every commit of origin/$base ($at)" "$base"
    old="$(git rev-parse HEAD)" remote="$(git rev-parse -q --verify "refs/remotes/origin/$b" || true)"
    refused=""
    if [ -z "$opened" ]; then
      # Not opened on the forge yet: rebased, on a detached HEAD.
      git checkout -q --detach "$old" > /dev/null 2>&1 || say not-mechanical 0 "$b could not be detached for its rebase" "$base"
      if ! err="$(git "${who[@]+"${who[@]}"}" rebase -q --no-verify "origin/$base" 2>&1)"; then
        files="$(git diff --name-only --diff-filter=U | paste -sd, -)"
        git rebase --abort > /dev/null 2>&1; git checkout -q -f "$b" > /dev/null 2>&1; git reset -q --hard "$old"
        say conflict "$behind" "rebasing $b onto origin/$base ($at, $behind commit(s) ahead of it) does not apply cleanly: $(if [ -n "$files" ]; then echo "conflicts in $files"; else one <<< "$err"; fi)" "$base"
      fi
      new="$(git rev-parse HEAD)"
      if [ -z "$remote" ]; then
        err="$(net git push -q --no-verify origin "$new:refs/heads/$b" 2>&1)" || { git checkout -q -f "$b" > /dev/null 2>&1; say push-failed "$behind" "rebased onto origin/$base ($at) but could not push $b (left as it was): $(one <<< "$err")" "$base"; }
        land "$b" "$new"; git branch -q --set-upstream-to "origin/$b" "$b" > /dev/null 2>&1 || true
        say rebased "$behind" "rebased $b onto origin/$base ($at, $behind commit(s) brought in) and pushed it (new on origin; no merge request opened yet), now $(git rev-parse --short HEAD)" "$base"
      fi
      if err="$(net git push -q --no-verify --force-with-lease="refs/heads/$b:$remote" origin "$new:refs/heads/$b" 2>&1)"; then
        land "$b" "$new"
        say rebased "$behind" "rebased $b onto origin/$base ($at, $behind commit(s) brought in) and pushed it (--force-with-lease; no merge request opened yet), now $(git rev-parse --short HEAD)" "$base"
      fi
      refused="; the forced push of the rebase was refused ($(one <<< "$err"))"
      git checkout -q -f "$b" > /dev/null 2>&1
    fi
    # Opened on the forge (or the forced push refused): origin/<base> merged in, never a rewrite.
    merged_in "$b" "$old" "$base" || say conflict "$behind" "merging origin/$base ($at, $behind commit(s)) into $b does not apply cleanly$refused: $(if [ -n "$files" ]; then echo "conflicts in $files"; else one <<< "$err"; fi)" "$base"
    new="$(git rev-parse HEAD)"
    err="$(net git push -q --no-verify origin "$new:refs/heads/$b" 2>&1)" || { git checkout -q -f "$b" > /dev/null 2>&1; say push-failed "$behind" "merged origin/$base into $b but could not push it (left as it was)$refused: $(one <<< "$err")" "$base"; }
    land "$b" "$new"
    say merged "$behind" "merged origin/$base ($at, $behind commit(s)) into $b and pushed it (plain push${opened:+: its merge request $opened is open on the forge, so never rewritten}$refused), now $(git rev-parse --short HEAD)" "$base" ;;
  renumber)
    b="$1" base="$2" from="$3" to="$4" message="$5"
    settle "$b"
    fetch || say fetch-failed 0 "could not fetch origin: $(one <<< "$err")"
    [ -n "$base" ] || { ref="$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/master)"; base="${ref#origin/}"; }
    onto "$b" no
    [ -e "$from" ] || say not-mechanical 0 "$from is not on $b"
    [ ! -e "$to" ] || say not-mechanical 0 "$to is on $b already"
    old="$(git rev-parse HEAD)" remote="$(git rev-parse -q --verify "refs/remotes/origin/$b" || true)"
    mkdir -p "$(dirname "$to")"
    git mv "$from" "$to" > /dev/null 2>&1 || say not-mechanical 0 "git mv $from $to failed"
    # Every reference to it in a file the branch adds or changes (none elsewhere can name a file only the branch has):
    # its path, or its name standing alone — never inside a longer name, nor the same name under another folder.
    mb="$(git merge-base HEAD "origin/$base" 2> /dev/null || true)"
    export FROM="$from" TO="$to"
    changed=()
    while IFS= read -r f; do
      [ -n "$f" ] && [ -f "$f" ] && grep -IqF -- "${from##*/}" "$f" 2> /dev/null || continue
      before="$(git hash-object "$f")"
      perl -pi -e "$REWRITE" "$f" && [ "$(git hash-object "$f")" != "$before" ] && changed+=("$f")
    done < <({ [ -z "$mb" ] || git diff --name-only "$mb" HEAD; git diff --name-only --cached; } | sort -u)
    # Only what the rename touched is staged: the git mv already is; never an untracked file left in the checkout.
    [ ${#changed[@]} -eq 0 ] || git add -- "${changed[@]}" > /dev/null 2>&1
    git "${who[@]+"${who[@]}"}" commit -q --no-verify -m "$message" > /dev/null 2>&1 || { git reset -q --hard "$old"; say not-mechanical 0 "could not commit the rename of $from to $to"; }
    files="$(printf "%s\n" ${changed[@]+"${changed[@]}"} | paste -sd, -)"
    new="$(git rev-parse HEAD)"
    if [ -z "$remote" ]; then err="$(net git push -q --no-verify -u origin "HEAD:refs/heads/$b" 2>&1)"
    else err="$(net git push -q --no-verify origin "HEAD:refs/heads/$b" 2>&1)"; fi || { git reset -q --hard "$old"; say push-failed 0 "renamed $from to $to but could not push $b (put back as it was): $(one <<< "$err")" "$files"; }
    say renumbered 0 "renamed $from to $to on $b and pushed it, now $(git rev-parse --short "$new")" "$files" ;;
esac'
# The rewrite (perl, $FROM and $TO in the environment): the file's path, then its name standing alone (not after a /,
# nor next to a letter, digit, _, . or -), each never inside a longer name.
REWRITE='BEGIN { ($fn = $ENV{FROM}) =~ s{.*/}{}; ($tn = $ENV{TO}) =~ s{.*/}{}; }
  s{(?<![A-Za-z0-9_.-])\Q$ENV{FROM}\E(?![A-Za-z0-9_.-])}{$ENV{TO}}g;
  s{(?<![A-Za-z0-9_./-])\Q$fn\E(?![A-Za-z0-9_.-])}{$tn}g;'

# catch_up_rows <command> <project> <key> <variation> [<repository>] — the live merge requests' rows: [{ repository (its name), url, branch, base, key }].
catch_up_rows() {
  variation_field '.["merge-request"] // []' "$1" "$2" "$3" "$4" | jq -c --arg r "${5:-}" '
    [.[] | select((.status | IN("Merged", "Closed") | not) and (.repository | type) == "string" and (.branch | type) == "string")
      | { repository: (.repository | sub("\\.git$"; "") | sub("/$"; "") | split("/") | last), url: .repository, branch, base: (.base // ""), key: (.key // "" | tostring) }
      | select($r == "" or .repository == $r)]'
}

catch_up_base() {
  local command="$1" project="$2" key="$3" variation="$4" machine="$5" only="$6" filter="${7:-}" rows out status behind detail base all='[]' repo branch row_base url mr
  rows="$(catch_up_rows "$command" "$project" "$key" "$variation" "$filter")" || { echo '[]'; return 0; }
  # Fields joined by the unit separator, not a tab: a tab is IFS whitespace, so an empty base would collapse into the next field.
  while IFS=$'\x1f' read -r repo url branch row_base mr; do
    if out="$(in_project "$command" "$project" "/repos/$repo" "export REWRITE=$(printf '%q' "$REWRITE") CATCH_UP_NET_SECONDS=${CATCH_UP_NET_SECONDS:-300}; set -- catch-up $(printf '%q ' "$branch" "$row_base" "$only" "$mr"); $CATCH_UP_GIT" "$machine" 2> /dev/null)" && [[ -n "$out" ]]; then
      IFS=$'\t' read -r status behind detail base <<< "$(tail -n 1 <<< "$out")"
    else status=skipped behind=0 detail="/repos/$repo could not be read in $machine" base="$row_base"; fi
    all="$(jq -c --arg r "$repo" --arg u "$url" --arg b "$branch" --arg base "${base:-$row_base}" --arg s "$status" --arg n "${behind:-0}" --arg d "$detail" \
      '. + [{ repository: $r, url: $u, branch: $b, base: $base, status: $s, behind: ($n | tonumber? // 0), detail: $d }]' <<< "$all")"
  done < <(jq -r '.[] | [.repository, .url, .branch, .base, .key] | join("\u001f")' <<< "$rows")
  echo "$all"
}

renumber_file() {
  local command="$1" project="$2" key="$3" machine="$4" repo="$5" branch="$6" base="$7" from="$8" to="$9" reason="${10}" out status behind detail files
  local message="$key: renumber ${from##*/} to ${to##*/}, its number taken ($reason)"
  if out="$(in_project "$command" "$project" "/repos/$repo" "export REWRITE=$(printf '%q' "$REWRITE") CATCH_UP_NET_SECONDS=${CATCH_UP_NET_SECONDS:-300}; set -- renumber $(printf '%q ' "$branch" "$base" "$from" "$to" "$message"); $CATCH_UP_GIT" "$machine" 2> /dev/null)" && [[ -n "$out" ]]; then
    IFS=$'\t' read -r status behind detail files <<< "$(tail -n 1 <<< "$out")"
  else status=not-mechanical detail="/repos/$repo could not be read in $machine" files=""; fi
  jq -nc --arg s "$status" --arg d "$detail" --arg f "$files" '{ status: $s, detail: $d, files: ($f | split(",") | map(select(. != ""))) }'
}

# rewrite_references <from> <to> — stdin with every reference to <from> (as renumber_file finds them) made <to>.
rewrite_references() { FROM="$1" TO="$2" perl -pe "$REWRITE"; }

# catch_up_lines <results-json> — each merge request's result as a line, for a results file or a change log.
catch_up_lines() { jq -r '.[] | "- \(.repository) \(.branch): \(.status) — \(.detail)"' <<< "$1"; }
