#!/bin/bash
# Never a commit on master (ASS-468 AC10, operator, 2026-11-15): a commit on
# a repository's default branch puts the local one out of step with GitLab's,
# so every repository the harness's agents work in — the GCP workstation's
# shared repositories, a ticket variation's VM's — refuses one. Run in the
# machine over the machine layer:
#
#   bash -s -- install <ticket-branch-hint> <name>…   < this script
#
# (HARNESS_VM_ROOT the root its repos/ are under, empty in a VM), or
# concatenated before step-trees.sh, which calls harness_hooks itself.
#
# harness_hooks <checkout> <default-branch> <ticket-branch> — the
# repository's hooks folder becomes <git-dir>/harness-hooks (core.hooksPath),
# holding a wrapper for every hook git runs: each runs the hook the
# repository had — in the hooks folder it named before (kept as
# harness.chained-hooks-path, its own core.hooksPath, husky's say) or its
# .git/hooks — so its own hooks keep working; pre-commit and
# pre-merge-commit first refuse a commit while HEAD is the default branch
# (harness.default-branch), naming the ticket's branch to use
# (harness.ticket-branch). Idempotent: run again, it rewrites the wrappers and
# the two names, never chaining to itself. Prints nothing; fails only when
# git config cannot be written.
harness_hooks() {
  local d="$1" default="$2" ticket="$3" gd hd cur name
  gd="$(git -C "$d" rev-parse --absolute-git-dir)" || return 1
  hd="$gd/harness-hooks"
  cur="$(git -C "$d" config --get core.hooksPath || true)"
  if [ "$cur" != "$hd" ]; then git -C "$d" config harness.chained-hooks-path "$cur" && git -C "$d" config core.hooksPath "$hd" || return 1; fi
  git -C "$d" config harness.default-branch "$default" && git -C "$d" config harness.ticket-branch "$ticket" || return 1
  mkdir -p "$hd"
  for name in applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit \
      pre-rebase post-checkout post-merge pre-push post-rewrite pre-auto-gc reference-transaction push-to-checkout sendemail-validate; do
    {
      echo '#!/bin/sh'
      echo "# The harness's wrapper (ASS-468): runs the repository's own $name hook, if it has one."
      if [ "$name" = pre-commit ] || [ "$name" = pre-merge-commit ]; then
        cat <<'HOOK'
b="$(git symbolic-ref -q --short HEAD)"
d="$(git config --get harness.default-branch)"
if [ -n "$b" ] && [ "$b" = "$d" ]; then
  echo "harness (ASS-468): no commit on $d, the repository's default branch — it is kept in step with GitLab's and never pushed to. Commit on the ticket's branch instead: $(git config --get harness.ticket-branch) (git checkout it first, making it from origin/$d when it does not exist yet)." >&2
  exit 1
fi
HOOK
      fi
      cat <<HOOK
orig="\$(git config --get harness.chained-hooks-path)"
[ -n "\$orig" ] || orig="\$(git rev-parse --absolute-git-dir)/hooks"
[ ! -x "\$orig/$name" ] || exec "\$orig/$name" "\$@"
exit 0
HOOK
    } > "$hd/$name.tmp" && chmod 755 "$hd/$name.tmp" && mv -f "$hd/$name.tmp" "$hd/$name" || return 1
  done
}

if [ "${1-}" = install ]; then
  hint="$2"; shift 2
  R="${HARNESS_VM_ROOT-}" rc=0
  for name in "$@"; do
    d="$R/repos/$name"
    [ -d "$d/.git" ] || continue
    default="$(git -C "$d" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)"; default="${default:-origin/master}"
    harness_hooks "$d" "${default#origin/}" "$hint" || { echo "could not install the harness's git hooks in $d" >&2; rc=1; }
  done
  exit "$rc"
fi
