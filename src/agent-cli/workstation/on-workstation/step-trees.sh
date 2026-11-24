#!/bin/bash
# A step's working trees (ASS-468), run in the machine a ticket variation's
# step runs in — the GCP workstation's shared repositories, or, in
# vm+workstation mode, the variation's VM — over the machine layer
# (workstation-variation.bash wsv_trees), git-hooks.sh sent before it:
#
#   bash -s -- start <slug> <name>:<branch>:<base>:<url>…                   < git-hooks.sh step-trees.sh
#   bash -s -- end <slug> <completed|incomplete> <message> <name>:…          < git-hooks.sh step-trees.sh
#
# with HARNESS_VM_ROOT the root its repos/ are under (~/harness on a
# workstation; empty in a VM, whose repositories are /repos/<name>). Each
# argument is one of the project's repositories: its name (the checkout's
# folder), the variation's branch there (change/<KEY>-<id>, from its
# merge-request plan; empty for a repository the plan has nothing in), that
# branch's planned base (empty: origin's default branch) and its url (to
# clone it when it is missing; the rest of the argument, colons and all).
# <slug> is the variation's: <KEY>, or <KEY>.<variation> for one other than A.
#
# ASS-480 (with ASS-478, which pushes only the variation's own planned
# branch): a branch is the variation's own when it is its branch in that
# repository, or is named change/<slug>-<n>. The repositories on a
# workstation are shared, so they may hold another ticket's local branch
# with commits GitLab lacks. ASS-478 leaves one its ticket's next step can
# still push (ahead of GitLab's, or not on GitLab yet) where it is; but one
# that has parted from GitLab's branch, which moved on since (an earlier
# step's push rejected), could never be pushed, and would be rejected — and
# blamed — at every release: such a stray is never pushed, nor forced: once
# GitLab's branches are fetched it is set aside, its tip kept under refs/harness/stray/<branch>/<UTC time> (out of
# the way of every checkout, never pushed) and its local branch deleted, so
# it is checked out fresh from GitLab later; said with !set-aside, for
# control to report it on the Health of the ticket the branch belongs to.
# At the end that happens after the default branch is checked out; at the
# start before any checkout.
#
# start (the step's start, before any agent or script runs): each
# repository cloned when it is missing (once: the shared repositories — and,
# ASS-529, each slot's — are kept across steps and restarts, under /home), fetched, and left clean
# (changes a step that ended uncleanly left are discarded, each file named);
# its git hooks set to refuse a commit on its default branch (git-hooks.sh,
# AC10), naming the branch to use — the planned one, else
# change/<slug>-<id>; its stale branches pruned (ASS-478: a local branch
# whose GitLab branch is gone — deleted after its merge request merged — and
# whose work is all on origin's default branch, merged or squashed, is
# deleted; one with work the default branch lacks is kept, said; a local
# branch GitLab has is set to track it, so its deletion is seen later); then
# a planned one checked out on its branch — the
# local one when there is one, fast-forwarded to GitLab's (one with commits
# GitLab never had is kept as it is, said; one GitLab had, its branch
# rewritten since by a rebase pushed from elsewhere, takes GitLab's), else
# GitLab's, else made from origin/<base> (not on GitLab yet) — and every
# other on its default branch at the latest. ASS-480 AC4: a local branch of
# its own that has parted from GitLab's with commits GitLab never had is no
# longer kept as it is (the step would start on stale commits): it is set
# aside as a stray is, and GitLab's taken. One merely ahead of GitLab's (a
# push that failed) is kept, its end pushing it.
#
# end (the step's end, whatever its outcome, before the machine is given
# up): in each repository, what is not committed (changes and untracked
# files, never the ignored ones — node_modules, build output: dependency and
# build caches kept) is, when the step completed and the checkout is on a
# branch other than the default one, committed there with <message> (AC9:
# every step commits its own work; this is the harness's safety net, said as
# such), else discarded, each file named; then the variation's own planned
# branch's commits that are not on GitLab (counted against GitLab's branch
# when it has one) pushed to the same branch (never forced: a rejected push
# is said, its commits kept on the local branch for the variation's next
# step). ASS-478: only its own — another ticket's local branches on the
# shared workstation are left for that ticket's own next step to push — and
# never one whose GitLab branch is gone (it tracked GitLab's, deleted since:
# merged, its source branch removed), which is skipped and said, so a merged
# branch is never pushed back (ASS-480: another's that could never be pushed
# as it is is set aside instead, above). Never the default branch's: a local default branch ahead of
# GitLab's is reset to it, its commits named (AC10) — and the default branch
# checked out at GitLab's latest. Every tree is checked clean on the default
# branch at the end.
#
# Prints a line per thing done, "<name>: <what>", and for the Mac:
#   !pushed <TAB> <name> <TAB> <branch> <TAB> <commits>
#   !push-failed <TAB> <name> <TAB> <branch> <TAB> <why>
#   !committed <TAB> <name> <TAB> <branch> <TAB> <files, comma-separated>   (end, a completed step's leftovers)
#   !discarded <TAB> <name> <TAB> <branch> <TAB> <files, comma-separated>
#   !master-reset <TAB> <name> <TAB> <branch> <TAB> <commits discarded: "<hash> <subject>" joined by "; ">
#   !unclean <TAB> <name> <TAB> <why>            (a tree that could not be checked out or made clean)
#   !set-aside <TAB> <name> <TAB> <branch> <TAB> <ref> <TAB> <commits GitLab lacks> <TAB> <why>   (ASS-480)
# Exits 0, or 3 when any tree is !unclean.
set -uo pipefail
R="${HARNESS_VM_ROOT-}"
mode="$1"; shift
if [ "$mode" = start ]; then slug="$1"; shift; else slug="$1" completed="$2" message="$3"; shift 3; fi
export GIT_TERMINAL_PROMPT=0
bad=0
unclean() { printf '!unclean\t%s\t%s\n' "$name" "$1"; bad=1; }
say() { echo "$name: $*"; }
oneline() { tr '\n' ' ' | cut -c1-300; }
dirty() { git status --porcelain --untracked-files=all 2>/dev/null; }
files() { dirty | cut -c4- | paste -sd, - | cut -c1-1000; }
# ASS-478: a branch whose GitLab branch is gone — it tracks origin's branch of the same name (set when it was pushed or
# taken from GitLab), and origin has it no more (fetch --prune removed it: deleted on GitLab, after a merge).
tracks() { [ "$(git config --get "branch.$1.remote")" = origin ] && [ "$(git config --get "branch.$1.merge")" = "refs/heads/$1" ]; }
gone() { tracks "$1" && ! git show-ref -q --verify "refs/remotes/origin/$1"; }
track() { git config "branch.$1.remote" origin && git config "branch.$1.merge" "refs/heads/$1"; }
# ASS-478: a branch with no work origin's default branch lacks — in its history, or merging it changes nothing there,
# or its whole change is one commit there (a squash merge) — never one with work only it has.
merged() {
  local b="refs/heads/$1" o="origin/$default" t mb
  git merge-base --is-ancestor "$b" "$o" 2>/dev/null && return 0
  t="$(git merge-tree --write-tree "$o" "$b" 2>/dev/null)" && [ "$t" = "$(git rev-parse -q --verify "$o^{tree}")" ] && return 0
  mb="$(git merge-base "$o" "$b" 2>/dev/null)" || return 1
  t="$(git diff "$mb" "$b" | git patch-id --stable | cut -d' ' -f1)"
  [ -n "$t" ] && git log -p --no-merges "$mb..$o" | git patch-id --stable | cut -d' ' -f1 | grep -qxF "$t"
}
upper() { tr '[:lower:]' '[:upper:]' <<< "$1"; }
# own <branch> — ASS-480: the variation's own: its branch in this repository, or named change/<slug>-<n>.
own() {
  [ -n "$branch" ] && [ "$1" = "$branch" ] && return 0
  [[ "$1" =~ ^change/(.+)-[0-9]+$ ]] && [ "$(upper "${BASH_REMATCH[1]}")" = "$(upper "$slug")" ]
}
# ahead <branch> — how many of its commits GitLab lacks (on no branch of origin's, as last fetched).
ahead() { git rev-list --count "refs/heads/$1" --not --remotes=origin 2>/dev/null || echo 0; }
# set_aside <branch> <why> — ASS-480: its tip kept under refs/harness/stray/<branch>/<UTC time>, its local branch deleted
# (HEAD detached first when it is checked out), said.
set_aside() {
  local b="$1" why="$2" n ref
  n="$(ahead "$b")" ref="refs/harness/stray/$b/$(date -u +%Y%m%dT%H%M%SZ)"
  if ! git update-ref "$ref" "refs/heads/$b" 2>/dev/null; then say "could not set $b aside; left as it is"; return 1; fi
  [ "$(git symbolic-ref -q --short HEAD)" != "$b" ] || git checkout -q -f --detach
  git branch -q -D "$b" >/dev/null 2>&1 || { say "could not delete $b (kept under $ref too)"; return 1; }
  printf '!set-aside\t%s\t%s\t%s\t%s\t%s\n' "$name" "$b" "$ref" "$n" "$why"
  say "set $b aside under $ref ($n commit(s) GitLab lacks; $why): never pushed; its local branch deleted"
}
# strays — ASS-480 with ASS-478: the local branches, neither the variation's own nor the default one, with commits GitLab
# lacks that could never be pushed as they are — GitLab has the branch and it has moved on, so a push (never forced) is
# rejected: the local one has parted from it. One merely ahead of GitLab's, or not on GitLab yet, is left for its own
# ticket's next step to push (ASS-478), and one whose GitLab branch is gone to ASS-478's prune at the claim. One per line.
strays() {
  local b
  while IFS= read -r b; do
    [ -n "$b" ] && [ "$b" != "$default" ] && [ "$b" != master ] && [ "$b" != main ] || continue
    own "$b" && continue
    git show-ref -q --verify "refs/remotes/origin/$b" || continue
    git merge-base --is-ancestor "origin/$b" "refs/heads/$b" 2>/dev/null && continue
    [ "$(ahead "$b")" -gt 0 ] && echo "$b"
  done < <(git for-each-ref --format='%(refname:short)' refs/heads)
}
STRAY="not this ticket variation's branch, and parted from GitLab's, which moved on: a push would be rejected"
mkdir -p "$R/repos"

for spec in "$@"; do
  IFS=: read -r name branch base url <<< "$spec"
  d="$R/repos/$name"
  if [ ! -d "$d/.git" ]; then
    [ "$mode" = start ] || continue
    # ASS-529: a slot's folder (<home>/harness/slots/<n>) clones with the shared root's checkout as a reference when
    # it has one, its objects copied (--dissociate), so a second ticket on the machine fetches only what it lacks.
    ref=(); shared="$HOME/harness/repos/$name"
    [ "$d" = "$shared" ] || [ ! -d "$shared/.git" ] || ref=(--reference-if-able "$shared" --dissociate)
    if ! err="$(git clone -q ${ref[@]+"${ref[@]}"} "$url" "$d" 2>&1)"; then unclean "could not clone $url: $(oneline <<< "$err")"; continue; fi
    if [ ${#ref[@]} -gt 0 ]; then say "cloned, with the shared root checkout as a reference"; else say "cloned"; fi
  fi
  cd "$d" || { unclean "no checkout"; continue; }
  fetched=yes
  err="$(git fetch -q --prune origin 2>&1)" || err="$(git fetch -q --prune origin 2>&1)" || { fetched=""; say "could not fetch: $(oneline <<< "$err")"; }
  default="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)"
  [ -n "$default" ] || { git remote set-head origin -a >/dev/null 2>&1; default="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)"; }
  default="${default:-origin/master}"; default="${default#origin/}"
  on="$(git symbolic-ref -q --short HEAD)"

  if [ "$mode" = end ]; then
    # What is not committed: a completed step's committed on its ticket branch (the safety net), else discarded.
    if [ -n "$(dirty)" ]; then
      f="$(files)" kept=""
      if [ "$completed" = completed ] && [ -n "$on" ] && [ "$on" != "$default" ] && [ "$on" != master ] && [ "$on" != main ]; then
        who=(); [ -n "$(git config user.email)" ] || who=(-c user.name=harness -c user.email=harness@localhost)
        if git add -A . && git "${who[@]+"${who[@]}"}" commit -q --no-verify -m "$message" >/dev/null 2>&1; then
          printf '!committed\t%s\t%s\t%s\n' "$name" "$on" "$f"; say "the step left changes uncommitted on $on; committed them there ($f)"; kept=yes
        fi
      fi
      if [ -z "$kept" ]; then
        git reset -q --hard && git clean -q -ffd
        printf '!discarded\t%s\t%s\t%s\n' "$name" "${on:-(detached)}" "$f"; say "discarded its uncommitted changes ($f)"
      fi
    fi
    # Committed work, pushed (ASS-478): the variation's own planned branch's commits GitLab lacks, to that branch — never
    # another ticket's, never one whose GitLab branch is gone (merged: never pushed back), never the default branch,
    # never forced.
    # ASS-480: another ticket's stray branches, set aside once the default branch is checked out (below).
    aside=""; [ -z "$fetched" ] || aside="$(strays)"
    b="$branch"
    if [ -n "$b" ] && [ "$b" != "$default" ] && [ "$b" != master ] && [ "$b" != main ] && git show-ref -q --verify "refs/heads/$b"; then
      if gone "$b"; then
        n="$(git rev-list --count "refs/heads/$b" --not "origin/$default" 2>/dev/null)"
        say "not pushing $b: its branch on GitLab is gone (deleted, its merge request merged); its ${n:-0} commit(s) are not pushed back"
      else
        if git show-ref -q --verify "refs/remotes/origin/$b"; then n="$(git rev-list --count "origin/$b..refs/heads/$b" 2>/dev/null)"
        else n="$(git rev-list --count "refs/heads/$b" --not --remotes=origin 2>/dev/null)"; fi
        if [ "${n:-0}" -gt 0 ]; then
          if err="$(git push -q origin "refs/heads/$b:refs/heads/$b" 2>&1)"; then
            track "$b"
            printf '!pushed\t%s\t%s\t%s\n' "$name" "$b" "$n"; say "pushed $n commit(s) to $b"
          else
            printf '!push-failed\t%s\t%s\t%s\n' "$name" "$b" "$(oneline <<< "$err")"; say "could not push $b: its $n commit(s) stay on the local branch"
          fi
        fi
      fi
    fi
    # A detached HEAD's commits on no branch are not kept: named, as the default branch's are.
    if [ -z "$on" ] && lost="$(git log --format='%h %s' HEAD --not --branches --remotes=origin 2>/dev/null)" && [ -n "$lost" ]; then
      printf '!master-reset\t%s\t%s\t%s\n' "$name" "(detached)" "$(paste -sd';' - <<< "$lost" | sed 's/;/; /g' | cut -c1-1000)"
    fi
    git checkout -q -f "$default" 2>/dev/null || git checkout -q -f -B "$default" "origin/$default" 2>/dev/null || { unclean "could not check out $default"; continue; }
    while IFS= read -r b; do [ -z "$b" ] || set_aside "$b" "$STRAY"; done <<< "$aside"
    # At GitLab's latest; never pushed to: commits of its own (a commit on master, AC10) discarded and named.
    if [ -n "$fetched" ]; then
      lost="$(git log --format='%h %s' "origin/$default..$default" 2>/dev/null)"
      if [ -n "$lost" ]; then
        printf '!master-reset\t%s\t%s\t%s\n' "$name" "$default" "$(paste -sd';' - <<< "$lost" | sed 's/;/; /g' | cut -c1-1000)"
        say "its $default had commits GitLab lacks; reset to GitLab's, they are discarded: $(paste -sd';' - <<< "$lost")"
      fi
      git reset -q --hard "origin/$default"
    fi
    # What the branch ignored and the default branch does not: not left behind as untracked files there.
    git clean -q -ffd
    if [ -n "$(dirty)" ] || [ "$(git symbolic-ref -q --short HEAD)" != "$default" ]; then unclean "not clean on $default"; continue; fi
    say "on $default at $(git rev-parse --short HEAD)"
    continue
  fi

  # start
  if [ -n "$(dirty)" ]; then
    f="$(files)"
    git reset -q --hard && git clean -q -ffd
    printf '!discarded\t%s\t%s\t%s\n' "$name" "${on:-(detached)}" "$f"
    say "discarded changes a step that did not end cleanly left uncommitted ($f)"
  fi
  hint="$branch"
  [ -n "$hint" ] || hint="the ticket's branch for this repository, change/$slug-<id> (none is planned in it yet: agent.sh ticket:add-merge-request plans one)"
  harness_hooks "$d" "$default" "$hint" || say "could not install the harness's git hooks"
  # Stale branches pruned (ASS-478), after a fetch that worked: a branch GitLab deleted whose work is all on its default
  # branch is deleted; one with work only it has is kept. A branch GitLab has tracks it, so its deletion shows later.
  if [ -n "$fetched" ]; then
    while IFS= read -r b; do
      [ -n "$b" ] && [ "$b" != "$default" ] && [ "$b" != master ] && [ "$b" != main ] && [ "$b" != "$on" ] || continue
      if git show-ref -q --verify "refs/remotes/origin/$b"; then tracks "$b" || track "$b"; continue; fi
      gone "$b" || continue
      if merged "$b"; then
        git branch -q -D "$b" >/dev/null 2>&1 && say "removed $b: its branch on GitLab is gone and its work is on $default"
      else
        say "kept $b: its branch on GitLab is gone, but it has commits $default lacks: $(git log --format='%h %s' "refs/heads/$b" --not "origin/$default" | head -5 | paste -sd';' - | sed 's/;/; /g')"
      fi
    done < <(git for-each-ref --format='%(refname:short)' refs/heads)
  fi
  # ASS-480 AC4: another's stray local branch set aside before any checkout (only against GitLab's branches as just fetched).
  if [ -n "$fetched" ]; then
    aside="$(strays)"
    while IFS= read -r b; do [ -z "$b" ] || set_aside "$b" "$STRAY"; done <<< "$aside"
  fi
  if [ -n "$branch" ]; then
    if git show-ref -q --verify "refs/heads/$branch"; then
      git checkout -q -f "$branch" || { unclean "could not check out $branch"; continue; }
      if git show-ref -q --verify "refs/remotes/origin/$branch" && ! git merge -q --ff-only "origin/$branch" >/dev/null 2>&1 \
          && ! git merge-base --is-ancestor "origin/$branch" HEAD; then
        # Parted: GitLab's rewritten elsewhere (a rebase pushed from another machine) when the local tip is one GitLab
        # had (in its remote-tracking reflog: pushed or fetched before) — then GitLab's is taken; else its commits
        # never reached GitLab (a push that failed, GitLab's moved on since): ASS-480 AC4, the local one is set aside,
        # its commits kept out of the way, and GitLab's taken, so the step never starts on stale commits.
        if git reflog show --format=%H "refs/remotes/origin/$branch" 2>/dev/null | grep -qx "$(git rev-parse HEAD)"; then
          git reset -q --hard "origin/$branch"; say "GitLab's $branch was rewritten since; taken"
        elif set_aside "$branch" "it had parted from GitLab's $branch, which moved on since; GitLab's taken"; then
          git checkout -q -f -b "$branch" --track "origin/$branch" || { unclean "could not check out $branch"; continue; }
          say "its $branch and GitLab's had parted; the local one set aside, GitLab's taken"
        else say "its $branch and GitLab's have parted; the local one could not be set aside, so it is kept"; fi
      fi
    elif git show-ref -q --verify "refs/remotes/origin/$branch"; then
      git checkout -q -f -b "$branch" --track "origin/$branch" || { unclean "could not check out $branch"; continue; }
    else
      from="${base:-$default}"
      git checkout -q -f --no-track -b "$branch" "origin/$from" 2>/dev/null || { unclean "could not make $branch from origin/$from"; continue; }
      say "made $branch from origin/$from (not on GitLab yet)"
    fi
  else
    git checkout -q -f "$default" 2>/dev/null || git checkout -q -f -B "$default" "origin/$default" 2>/dev/null || { unclean "could not check out $default"; continue; }
    git merge -q --ff-only "origin/$default" >/dev/null 2>&1 || say "its $default has commits GitLab lacks; left as it is (the step's end resets it)"
  fi
  say "on $(git symbolic-ref -q --short HEAD) at $(git rev-parse --short HEAD)"
done

exit $((bad * 3))
