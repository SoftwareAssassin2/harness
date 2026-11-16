#!/bin/bash
# A step's working trees (ASS-468), run in the machine a ticket variation's
# step runs in — the GCP workstation's shared repositories, or, in
# vm+workstation mode, the variation's VM — over the machine layer
# (workstation-variation.bash wsv_trees), git-hooks.sh sent before it:
#
#   bash -s -- start <slug> <name>:<branch>:<base>:<url>…            < git-hooks.sh step-trees.sh
#   bash -s -- end <completed|incomplete> <message> <name>:…          < git-hooks.sh step-trees.sh
#
# with HARNESS_VM_ROOT the root its repos/ are under (~/harness on a
# workstation; empty in a VM, whose repositories are /repos/<name>). Each
# argument is one of the project's repositories: its name (the checkout's
# folder), the variation's branch there (change/<KEY>-<id>, from its
# merge-request plan; empty for a repository the plan has nothing in), that
# branch's planned base (empty: origin's default branch) and its url (to
# clone it when it is missing; the rest of the argument, colons and all).
#
# start (the step's start, before any agent or script runs): each
# repository cloned when it is missing (once: the shared repositories are
# kept across steps and restarts, under /home), fetched, and left clean
# (changes a step that ended uncleanly left are discarded, each file named);
# its git hooks set to refuse a commit on its default branch (git-hooks.sh,
# AC10), naming the branch to use — the planned one, else
# change/<slug>-<id>; then a planned one checked out on its branch — the
# local one when there is one, fast-forwarded to GitLab's (one with commits
# GitLab never had is kept as it is, said; one GitLab had, its branch
# rewritten since by a rebase pushed from elsewhere, takes GitLab's), else
# GitLab's, else made from origin/<base> (not on GitLab yet) — and every
# other on its default branch at the latest.
#
# end (the step's end, whatever its outcome, before the machine is given
# up): in each repository, what is not committed (changes and untracked
# files, never the ignored ones — node_modules, build output: dependency and
# build caches kept) is, when the step completed and the checkout is on a
# branch other than the default one, committed there with <message> (AC9:
# every step commits its own work; this is the harness's safety net, said as
# such), else discarded, each file named; then every local branch's commits
# that are not on GitLab pushed to the same branch (never forced: a rejected
# push is said, its commits kept on the local branch for the variation's next
# step) — never the default branch's: a local default branch ahead of
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
# Exits 0, or 3 when any tree is !unclean.
set -uo pipefail
R="${HARNESS_VM_ROOT-}"
mode="$1"; shift
if [ "$mode" = start ]; then slug="$1"; shift; else completed="$1" message="$2"; shift 2; fi
export GIT_TERMINAL_PROMPT=0
bad=0
unclean() { printf '!unclean\t%s\t%s\n' "$name" "$1"; bad=1; }
say() { echo "$name: $*"; }
oneline() { tr '\n' ' ' | cut -c1-300; }
dirty() { git status --porcelain --untracked-files=all 2>/dev/null; }
files() { dirty | cut -c4- | paste -sd, - | cut -c1-1000; }
mkdir -p "$R/repos"

for spec in "$@"; do
  IFS=: read -r name branch base url <<< "$spec"
  d="$R/repos/$name"
  if [ ! -d "$d/.git" ]; then
    [ "$mode" = start ] || continue
    if ! err="$(git clone -q "$url" "$d" 2>&1)"; then unclean "could not clone $url: $(oneline <<< "$err")"; continue; fi
    say "cloned"
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
    # Committed work, pushed: each local branch's commits GitLab lacks, to that branch; never the default branch, never forced.
    while IFS= read -r b; do
      [ -n "$b" ] && [ "$b" != "$default" ] && [ "$b" != master ] && [ "$b" != main ] || continue
      n="$(git rev-list --count "refs/heads/$b" --not --remotes=origin 2>/dev/null)" || continue
      [ "${n:-0}" -gt 0 ] || continue
      if err="$(git push -q origin "refs/heads/$b:refs/heads/$b" 2>&1)"; then
        printf '!pushed\t%s\t%s\t%s\n' "$name" "$b" "$n"; say "pushed $n commit(s) to $b"
      else
        printf '!push-failed\t%s\t%s\t%s\n' "$name" "$b" "$(oneline <<< "$err")"; say "could not push $b: its $n commit(s) stay on the local branch"
      fi
    done < <(git for-each-ref --format='%(refname:short)' refs/heads)
    # A detached HEAD's commits on no branch are not kept: named, as the default branch's are.
    if [ -z "$on" ] && lost="$(git log --format='%h %s' HEAD --not --branches --remotes=origin 2>/dev/null)" && [ -n "$lost" ]; then
      printf '!master-reset\t%s\t%s\t%s\n' "$name" "(detached)" "$(paste -sd';' - <<< "$lost" | sed 's/;/; /g' | cut -c1-1000)"
    fi
    git checkout -q -f "$default" 2>/dev/null || git checkout -q -f -B "$default" "origin/$default" 2>/dev/null || { unclean "could not check out $default"; continue; }
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
  if [ -n "$branch" ]; then
    if git show-ref -q --verify "refs/heads/$branch"; then
      git checkout -q -f "$branch" || { unclean "could not check out $branch"; continue; }
      if git show-ref -q --verify "refs/remotes/origin/$branch" && ! git merge -q --ff-only "origin/$branch" >/dev/null 2>&1 \
          && ! git merge-base --is-ancestor "origin/$branch" HEAD; then
        # Parted: GitLab's rewritten elsewhere (a rebase pushed from another machine) when the local tip is one GitLab
        # had (in its remote-tracking reflog: pushed or fetched before) — then GitLab's is taken; else its commits
        # never reached GitLab (a push that failed), and the local one is kept.
        if git reflog show --format=%H "refs/remotes/origin/$branch" 2>/dev/null | grep -qx "$(git rev-parse HEAD)"; then
          git reset -q --hard "origin/$branch"; say "GitLab's $branch was rewritten since; taken"
        else say "its $branch and GitLab's have parted; the local one, with commits GitLab lacks, is kept"; fi
      fi
    elif git show-ref -q --verify "refs/remotes/origin/$branch"; then
      git checkout -q -f -b "$branch" --track "origin/$branch" || { unclean "could not check out $branch"; continue; }
    else
      from="${base:-$default}"
      git checkout -q -f -b "$branch" "origin/$from" 2>/dev/null || { unclean "could not make $branch from origin/$from"; continue; }
      say "made $branch from origin/$from (not on GitLab yet)"
    fi
  else
    git checkout -q -f "$default" 2>/dev/null || git checkout -q -f -B "$default" "origin/$default" 2>/dev/null || { unclean "could not check out $default"; continue; }
    git merge -q --ff-only "origin/$default" >/dev/null 2>&1 || say "its $default has commits GitLab lacks; left as it is (the step's end resets it)"
  fi
  say "on $(git symbolic-ref -q --short HEAD) at $(git rev-parse --short HEAD)"
done

exit $((bad * 3))
