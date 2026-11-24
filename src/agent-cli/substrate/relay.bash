# A ticket variation's branches moved into and out of a machine through the
# Mac (ASS-535), for code:hand-over and substrate:sandbox-up / -delete: a
# Substrate sandbox had no forge credentials nor egress of its own when this
# was written, so its work never leaves it by its own git push, nor comes in
# by its own fetch. (ASS-538 gives it both through the egress gateway — git
# over HTTPS to its forges, the token injected there — so a later ticket may
# let it push and fetch for itself, as a VM does; the relay stays meanwhile,
# and for a project with no forge credential declared, a local-path origin or
# a forge with a private CA the gateway can't trust.) Git bundles
# carry it instead, over the machine layer (machine.bash machine_run,
# machine_copy_in / _copy_out), and the Mac — which holds the forge logins —
# pushes and fetches for it. A Lima VM is reached the same way, so a branch
# moves between a sandbox and a VM in both directions alike.
#
#   relay_out <command> <project> <key> <variation> <machine> <from-target>
#       In <machine>: each repository under /repos on one of the variation's own
#       branches (change/<KEY>-<n>, change/<KEY>.<variation>-<n>: ASS-478's
#       naming) has what is left uncommitted committed ("<KEY>: work left
#       uncommitted on <from-target>") and is bundled — the branch, less what
#       its origin's default branch has — and the bundles copied to the Mac;
#       there each repository's relay (below) fetches its bundle and pushes the
#       branch to origin (never forced: one that diverged from origin's fails).
#       Prints "<repo>\t<branch>" per branch moved.
#   relay_in <command> <project> <key> <variation> <machine>
#       For each repository under /repos in <machine>: the variation's own
#       branches on its origin (git ls-remote, from the Mac) fetched into the
#       repository's relay and bundled — less the commit the machine's own
#       origin default is at, when the relay has it — the bundles copied in,
#       and in the machine each branch fetched as origin/<branch> and checked
#       out (fast-forwarded when it is there already; one that diverged, or a
#       checkout with uncommitted work, fails). Prints "<repo>\t<branch>" per
#       branch moved.
#
#   relay_clone <command> <machine> <name> <url>
#       ASS-551: a repository the machine lacks (one added to the project after
#       its sandbox image was built: project:add-repository, or vm:create on a
#       substrate target) cloned into its /repos/<name> through the Mac: cloned
#       there (its default branch alone, full history, with the Mac's logins),
#       bundled, copied in, and cloned from the bundle in the machine, its
#       origin then the url (origin/HEAD its default branch), so the relays
#       above find it as any other. One already there is left alone. Fails,
#       naming <command> and the url, when the Mac cannot clone it or the
#       machine cannot take it in; nothing is left half-cloned in /repos.
#
# The relay of a repository: a bare, blob-less (--filter=blob:none) clone of
# its origin on the Mac, <substrate dir>/relay/<project>/<name>.git (name: the
# URL's last part), kept between moves so each fetch is small. Fails, naming
# <command> and the repository, when a move fails; what moved before it stays.
here_relay="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
substrate_dir="${substrate_dir:-${HARNESS_SUBSTRATE_DIR:-$HOME/.harness/substrate}}"

# relay_slug <key> <variation> — the variation's branch names' regex (workstation-steps.js ownBranch).
relay_slug() {
  local key; key="$(tr '[:lower:]' '[:upper:]' <<< "$1")"
  if [[ "$2" == A ]]; then printf '^change/%s-[0-9]+$' "${key//./\\.}"; else printf '^change/%s\\.%s-[0-9]+$' "${key//./\\.}" "$2"; fi
}

# relay_repo <project> <url> — the repository's relay on the Mac, made when missing; prints its folder.
relay_repo() {
  local dir name
  name="$(basename "${2%.git}")"; name="${name//[^A-Za-z0-9._-]/-}"
  dir="$substrate_dir/relay/$1/$name.git"
  if [[ ! -d "$dir" ]]; then
    mkdir -p "$dir" && git init --quiet --bare "$dir" && git -C "$dir" remote add origin "$2" && git -C "$dir" config remote.origin.promisor true \
      && git -C "$dir" config remote.origin.partialclonefilter blob:none || { rm -rf "$dir"; return 1; }
  fi
  [[ "$(git -C "$dir" remote get-url origin)" == "$2" ]] || git -C "$dir" remote set-url origin "$2"
  echo "$dir"
}

# What runs in the machine to bundle its branches out ($1 the regex, $2 the leftovers' message): a line per branch,
# "<repo>\t<branch>\t<origin url>\t<origin's default>\t<bundled: yes|no>", the bundles in /tmp/harness-relay-out.
# shellcheck disable=SC2016
relay_out_script='set -o pipefail; o="${HARNESS_VM_ROOT-}/tmp/harness-relay-out"; rm -rf "$o"; mkdir -p "$o" || exit 1
cd "${HARNESS_VM_ROOT-}/repos" 2>/dev/null || exit 0
for r in */; do r="${r%/}"; [ -e "$r/.git" ] || continue
  b="$(git -C "$r" symbolic-ref --quiet --short HEAD)" || continue
  [[ "$b" =~ $1 ]] || continue
  if [ -n "$(git -C "$r" status --porcelain)" ]; then git -C "$r" add -A && git -C "$r" commit --quiet -m "$2" || { echo "$r: could not commit what was left" >&2; exit 1; }; fi
  d="$(git -C "$r" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"; d="${d#origin/}"
  basis=""; [ -z "$d" ] || basis="$(git -C "$r" rev-parse -q --verify "refs/remotes/origin/$d^{commit}" 2>/dev/null)"
  f=no; git -C "$r" bundle create "$o/$r.bundle" "refs/heads/$b" ${basis:+"^$basis"} >/dev/null 2>&1 && f=yes
  printf "%s\t%s\t%s\t%s\t%s\n" "$r" "$b" "$(git -C "$r" remote get-url origin)" "$d" "$f"
done'

relay_out() {
  local command="$1" project="$2" key="$3" variation="$4" machine="$5" from="$6" lines tmp r b url d f relay sha moved=""
  lines="$(machine_run "$machine" -- bash -c "$relay_out_script" relay "$(relay_slug "$key" "$variation")" "$(tr '[:lower:]' '[:upper:]' <<< "$key"): work left uncommitted on $from" </dev/null)" \
    || { echo "$command: could not bundle $key $variation's branches in $machine" >&2; return 1; }
  [[ -n "$lines" ]] || return 0
  tmp="$(mktemp -d)"
  if grep -q $'\tyes$' <<< "$lines"; then machine_copy_out "$machine" /tmp/harness-relay-out "$tmp/out" || { rm -rf "$tmp"; echo "$command: could not copy $key $variation's bundles out of $machine" >&2; return 1; }; fi
  while IFS=$'\t' read -r r b url d f; do
    [[ -n "$r" ]] || continue
    relay="$(relay_repo "$project" "$url")" || { rm -rf "$tmp"; echo "$command: no relay for $r ($url)" >&2; return 1; }
    [[ -z "$d" ]] || git -C "$relay" fetch --quiet --filter=blob:none origin "+refs/heads/$d:refs/heads/$d" 2>/dev/null || true
    if [[ "$f" == yes ]]; then
      git -C "$relay" fetch --quiet "$tmp/out/$r.bundle" "+refs/heads/$b:refs/heads/$b" || { rm -rf "$tmp"; echo "$command: $r's bundle of $b could not be read (its basis missing on the Mac?)" >&2; return 1; }
    fi
    sha="$(git -C "$relay" rev-parse -q --verify "refs/heads/$b^{commit}" 2>/dev/null || true)"
    [[ -n "$sha" ]] || { [[ "$f" == no ]] && continue; }
    git -C "$relay" push --quiet origin "refs/heads/$b:refs/heads/$b" 2>/dev/null \
      || { rm -rf "$tmp"; echo "$command: $b of $r could not be pushed to origin (diverged from origin's?)" >&2; return 1; }
    moved+="$r"$'\t'"$b"$'\n'
  done <<< "$lines"
  rm -rf "$tmp"
  machine_run "$machine" -- bash -c 'rm -rf "${HARNESS_VM_ROOT-}/tmp/harness-relay-out"' </dev/null >/dev/null 2>&1 || true
  printf '%s' "$moved"
}

# What runs in the machine to list its repositories: "<repo>\t<origin url>\t<the commit its origin default is at>".
# shellcheck disable=SC2016
relay_list_script='cd "${HARNESS_VM_ROOT-}/repos" 2>/dev/null || exit 0
for r in */; do r="${r%/}"; [ -e "$r/.git" ] || continue
  d="$(git -C "$r" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
  printf "%s\t%s\t%s\n" "$r" "$(git -C "$r" remote get-url origin)" "$( [ -n "$d" ] && git -C "$r" rev-parse -q --verify "$d^{commit}" 2>/dev/null)"
done'

# What runs in the machine to take the bundles in /tmp/harness-relay-in ($@: "<repo>\t<branch>" pairs). ASS-577: the
# bundles' folder is left when it can't be removed — in a real sandbox machine_copy_in writes it as root and this runs as
# its agent, so `rm` was refused and a move whose branches had all been checked out failed (the next copy overwrites it).
# shellcheck disable=SC2016
relay_in_script='set -e; i="${HARNESS_VM_ROOT-}/tmp/harness-relay-in"
for p in "$@"; do IFS="$(printf "\t")" read -r r b <<< "$p"; g="${HARNESS_VM_ROOT-}/repos/$r"
  git -C "$g" fetch --quiet "$i/$r--${b//\//_}.bundle" "+refs/heads/$b:refs/remotes/origin/$b"
  if git -C "$g" show-ref --verify --quiet "refs/heads/$b"; then
    [ -z "$(git -C "$g" status --porcelain)" ] || [ "$(git -C "$g" symbolic-ref --quiet --short HEAD)" = "$b" ] || { echo "$r has uncommitted work on another branch" >&2; exit 1; }
    git -C "$g" checkout --quiet "$b"; git -C "$g" merge --quiet --ff-only "origin/$b" || { echo "$r: $b has diverged from the one on origin" >&2; exit 1; }
  else
    [ -z "$(git -C "$g" status --porcelain)" ] || { echo "$r has uncommitted work" >&2; exit 1; }
    git -C "$g" checkout --quiet -b "$b" "origin/$b"
  fi
done
rm -rf "$i" 2>/dev/null || true'

relay_in() {
  local command="$1" project="$2" key="$3" variation="$4" machine="$5" list r url basis relay b tmp pairs=() re
  re="$(relay_slug "$key" "$variation")"
  list="$(machine_run "$machine" -- bash -c "$relay_list_script" </dev/null)" || { echo "$command: could not list the repositories in $machine" >&2; return 1; }
  tmp="$(mktemp -d)"; mkdir -p "$tmp/harness-relay-in"
  while IFS=$'\t' read -r r url basis; do
    [[ -n "$r" && -n "$url" ]] || continue
    while read -r b; do
      [[ -n "$b" ]] || continue
      relay="$(relay_repo "$project" "$url")" || { rm -rf "$tmp"; echo "$command: no relay for $r ($url)" >&2; return 1; }
      git -C "$relay" fetch --quiet --filter=blob:none origin "+refs/heads/$b:refs/heads/$b" || { rm -rf "$tmp"; echo "$command: could not fetch $b of $r from origin" >&2; return 1; }
      if [[ -n "$basis" ]] && git -C "$relay" cat-file -e "$basis^{commit}" 2>/dev/null && ! git -C "$relay" merge-base --is-ancestor "refs/heads/$b" "$basis" 2>/dev/null; then
        git -C "$relay" bundle create "$tmp/harness-relay-in/$r--${b//\//_}.bundle" "refs/heads/$b" "^$basis" >/dev/null 2>&1
      else git -C "$relay" bundle create "$tmp/harness-relay-in/$r--${b//\//_}.bundle" "refs/heads/$b" >/dev/null 2>&1; fi \
        || { rm -rf "$tmp"; echo "$command: could not bundle $b of $r" >&2; return 1; }
      pairs+=("$r"$'\t'"$b")
    done < <(git ls-remote --heads "$url" 2>/dev/null | awk '{ sub("^refs/heads/", "", $2); print $2 }' | grep -E "$re" || true)
  done <<< "$list"
  if [[ ${#pairs[@]} -gt 0 ]]; then
    machine_copy_in "$machine" "$tmp/harness-relay-in" /tmp/harness-relay-in \
      && machine_run "$machine" -- bash -c "$relay_in_script" relay "${pairs[@]}" </dev/null >&2 \
      || { rm -rf "$tmp"; echo "$command: could not bring $key $variation's branches into $machine" >&2; return 1; }
    printf '%s\n' "${pairs[@]}"
  fi
  rm -rf "$tmp"
}

# What runs in the machine to take a clone's bundle in /tmp/harness-relay-clone ($1 the name, $2 the url, $3 its
# default branch): cloned beside /repos/<name> first, then moved there whole.
# shellcheck disable=SC2016
relay_clone_script='set -e; R="${HARNESS_VM_ROOT-}"; i="$R/tmp/harness-relay-clone"; n="$1" u="$2" d="$3"
if [ ! -e "$R/repos/$n/.git" ]; then
  rm -rf "$R/repos/.$n.cloning"
  git clone --quiet --branch "$d" "$i/$n.bundle" "$R/repos/.$n.cloning"
  git -C "$R/repos/.$n.cloning" remote set-url origin "$u"
  git -C "$R/repos/.$n.cloning" symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/$d"
  mv "$R/repos/.$n.cloning" "$R/repos/$n"
fi
rm -rf "$i" 2>/dev/null || true'

relay_clone() {
  local command="$1" machine="$2" name="$3" url="$4" tmp d
  tmp="$(mktemp -d)"; mkdir -p "$tmp/harness-relay-clone"
  if ! git clone --quiet --bare --single-branch "$url" "$tmp/$name.git" 2>"$tmp/err"; then
    echo "$command: could not clone $url on the Mac: $(grep -m 1 . "$tmp/err")" >&2; rm -rf "$tmp"; return 1
  fi
  d="$(git -C "$tmp/$name.git" symbolic-ref --quiet --short HEAD)" \
    && git -C "$tmp/$name.git" bundle create "$tmp/harness-relay-clone/$name.bundle" "refs/heads/$d" >/dev/null 2>&1 \
    || { echo "$command: could not bundle $url's ${d:-default branch} on the Mac" >&2; rm -rf "$tmp"; return 1; }
  machine_copy_in "$machine" "$tmp/harness-relay-clone" /tmp/harness-relay-clone \
    && machine_run --workdir / "$machine" -- bash -c "$relay_clone_script" relay "$name" "$url" "$d" </dev/null >&2 \
    || { echo "$command: could not clone $url into $machine's /repos/$name" >&2; rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}
