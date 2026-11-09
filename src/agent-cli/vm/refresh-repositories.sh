#!/usr/bin/env bash
# Description: Bring a ticket variation's reference checkouts up to date in its VM — vm:refresh-repositories <project> <ticket-key> <variation>; prints a line per repository.
set -euo pipefail

# ASS-218. Every repository starts at the golden image's snapshot, and
# vm:create checks out master once only, so a check that compares one
# repository with another's master (a parity check) passed or failed in
# the VM unlike CI. The grouped and v2 Build engines run this first, and
# again before each Automated Testing. In the running VM recorded on the
# variation, each repository of project.json's that none of the ticket's
# merge requests (ticket:merge-request-plan) is in is fetched and checked
# out on origin's default branch — from wherever it is, detached (Automated
# Testing's to-master leaves it so) or on another branch — when it is clean
# and neither HEAD nor its local default branch has a commit origin's lacks.
# Otherwise it is left as it is: changes not committed, commits of its own,
# a fetch that failed. The ticket's own repositories are never touched, not
# even fetched. Prints "<repository>: <what happened>" for each, and exits 0
# whatever any one repository did; fails (1) only with no running VM, or
# when the VM cannot be reached.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

[[ $# -eq 3 ]] || { echo "usage: vm:refresh-repositories <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
vm="$(running_vm vm:refresh-repositories "$project" "$key" "$variation")"
name='sub("\\.git$"; "") | split("/") | last'
own="$("$agent" ticket:merge-request-plan "$project" "$key" "$variation" | jq -r ".[] | select(.repository != null) | .repository | $name")"
refs=()
while read -r repo; do
  if grep -qxF -- "$repo" <<< "$own"; then echo "$repo: the ticket's own, untouched"; else refs+=("$repo"); fi
done < <(jq -r ".repositories[]?.url | $name" "$projects/$project/project.json")
[[ ${#refs[@]} -gt 0 ]] || exit 0

limactl shell --workdir / "$vm" -- bash -s "${refs[@]}" <<'EOF' || { echo "vm:refresh-repositories: could not reach $vm" >&2; exit 1; }
R="${HARNESS_VM_ROOT-}"   # empty in a VM; tests run this against a folder standing in for its root
for name in "$@"; do
  d="$R/repos/$name"
  say() { echo "$name: $*"; }
  [ -d "$d/.git" ] || { say "left as is: no checkout"; continue; }
  git -C "$d" fetch -q origin > /dev/null 2>&1 || { say "left as is: could not fetch"; continue; }
  branch="$(git -C "$d" symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/master)"
  [ -z "$(git -C "$d" status --porcelain)" ] || { say "left as is: changes not committed"; continue; }
  ahead="$(git -C "$d" rev-list --count HEAD $(git -C "$d" rev-parse -q --verify "refs/heads/${branch#origin/}") --not "$branch" 2> /dev/null)" \
    || { say "left as is: no $branch"; continue; }
  [ "$ahead" -eq 0 ] || { say "left as is: $ahead commit(s) not on $branch"; continue; }
  from="$(git -C "$d" rev-parse --short HEAD)"
  git -C "$d" checkout -q -B "${branch#origin/}" "$branch" 2> /dev/null || { say "left as is: could not check out $branch"; continue; }
  to="$(git -C "$d" rev-parse --short HEAD)"
  if [ "$from" = "$to" ]; then say "current at $to"; else say "brought from $from to $to ($branch)"; fi
done
EOF
