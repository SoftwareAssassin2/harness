#!/usr/bin/env bash
# Description: Name the ticket(s) whose base commits touch a rebase's conflicting files, with each one's intent — merge-request:conflicting-tickets <project> <ticket-key> <variation>.
set -euo pipefail

# Read-only (ASS-198): run in a checkout stopped mid-rebase, it finds the
# ticket(s) whose commits on the base touch the conflicting files and prints,
# per ticket, its title, description, acceptance criteria, execution plan and
# recorded test commands, for the variation its commits pick. It writes
# nothing: every fact comes from git state and the project's sprint and work
# files (read with jq); the keys it finds leave only as output, so the
# forwarder still binds project/ticket/variation to the caller.
#
# The conflicted checkout is found cwd-first — a host agent runs the command in
# it — else in the variation's VM, every repository in /repos/ through
# `limactl shell --workdir /repos/`, the verify-success.sh pattern: a call
# forwarded from a VM (generate-solution-grouped) arrives on the Mac with cwd
# the ticket folder, so the VM's git state is only reachable that way. A second
# checkout also mid-rebase is named but not reported. Mid-rebase is
# <git-dir>/rebase-merge/onto or rebase-apply/onto; base is that onto commit,
# merge-base is `git merge-base onto ORIG_HEAD` (the rebase directory's
# orig-head when ORIG_HEAD is gone), and the base log over merge-base..onto,
# per unmerged path, gives the ticket keys from its commit subjects.
#
# A path with no key is reported "no ticket identified" and never fails the
# command; a key no sprint lists is reported found: false, its files still
# named. The variation is chosen and named ("variation-from"): a
# change/<KEY>[.<V>]-<id> branch name in a subject → that variation; else a
# #<n>/!<n> matching a Merged merge-request row → that row's; else the ticket's
# selected-variation; else A. When no checkout is mid-rebase it fails with a
# clear message naming where it looked, writing nothing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

command="merge-request:conflicting-tickets"
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" ticket="$(upper "$2")" variation="$3"

# The git facts of the first mid-rebase checkout reachable from where this
# runs, and a REBASE line per mid-rebase checkout (first first). Single-quoted
# so the cwd and VM calls share the body (verify-success.sh).
SHIM='
set -euo pipefail
first=1
for cand in $(
  if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then echo .;
  else for d in */; do [ -e "$d/.git" ] && echo "${d%/}"; done; fi
); do
  gd="$(git -C "$cand" rev-parse --git-dir 2> /dev/null)" || continue
  case "$gd" in /*) ;; *) gd="$cand/$gd" ;; esac
  rd=""
  [ -f "$gd/rebase-merge/onto" ] && rd="$gd/rebase-merge"
  [ -f "$gd/rebase-apply/onto" ] && rd="$gd/rebase-apply"
  [ -n "$rd" ] || continue
  abs="$(cd "$cand" && pwd)"
  printf "REBASE\t%s\n" "$abs"
  [ "$first" = 1 ] || continue
  first=0
  onto="$(cat "$rd/onto")"
  orig="$(git -C "$cand" rev-parse -q --verify ORIG_HEAD 2> /dev/null || true)"
  [ -n "$orig" ] || orig="$(cat "$rd/orig-head")"
  mb="$(git -C "$cand" merge-base "$onto" "$orig")"
  printf "CHECKOUT\t%s\n" "$abs"
  printf "BASE\t%s\n" "$onto"
  printf "MERGEBASE\t%s\n" "$mb"
  git -C "$cand" diff --name-only --diff-filter=U | while IFS= read -r p; do
    printf "U\t%s\n" "$p"
    git -C "$cand" log --format="%H%x09%s" "$mb..$onto" -- "$p" | while IFS= read -r line; do
      printf "C\t%s\t%s\n" "$p" "$line"
    done
  done
done
'

# cwd first, when it is a git work tree; else, and for the "also mid-rebase"
# list, the variation's VM under /repos/.
vm="$(vm_of "$command" "$project" "$2" "$variation" 2> /dev/null || true)"
host_out="" vm_out=""
git rev-parse --is-inside-work-tree > /dev/null 2>&1 && host_out="$(bash -c "$SHIM")" || true
[[ -n "$vm" ]] && vm_out="$(LIMA_HOME="$(lima_home)" limactl shell --workdir /repos/ "$vm" -- bash -c "$SHIM" < /dev/null || true)" || true

if grep -q '^CHECKOUT' <<< "$host_out"; then chosen="$host_out"; vmj=null
elif grep -q '^CHECKOUT' <<< "$vm_out"; then chosen="$vm_out"; vmj="$(jq -nc --arg v "$vm" '$v')"
else
  echo "$command: no checkout is mid-rebase (looked in $PWD${vm:+ and VM $vm under /repos/})" >&2
  exit 1
fi

# Parse the chosen checkout's git facts.
checkout="" base="" mergebase=""
declare -a files_order=() keys_order=()
declare -A file_keys=() ticket_files=() file_subjects=() ticket_commits=()
note_key() { case " ${keys_order[*]-} " in *" $1 "*) ;; *) keys_order+=("$1") ;; esac; }
add_to() { local -n ref="$1"; case " ${ref[$2]-} " in *" $3 "*) ;; *) ref[$2]="${ref[$2]-} $3" ;; esac; }
while IFS= read -r l; do
  [ -n "$l" ] || continue
  tag="${l%%$'\t'*}" rest="${l#*$'\t'}"
  case "$tag" in
    CHECKOUT) checkout="$rest" ;;
    BASE) base="$rest" ;;
    MERGEBASE) mergebase="$rest" ;;
    U) files_order+=("$rest") ;;
    C) p="${rest%%$'\t'*}" r2="${rest#*$'\t'}" sha="${r2%%$'\t'*}" subject="${r2#*$'\t'}"
      file_subjects[$p]="${file_subjects[$p]-}${subject}"$'\n'
      while read -r k; do
        note_key "$k"; add_to file_keys "$p" "$k"; add_to ticket_files "$k" "$p"
        ticket_commits[$k]="$(jq -c --arg sha "$sha" --arg subject "$subject" '. + [{sha:$sha, subject:$subject}]' <<< "${ticket_commits[$k]:-[]}")"
      done < <(grep -oE '[A-Z][A-Z0-9]*-[0-9]+' <<< "$subject" | awk '!seen[$0]++') ;;
  esac
done <<< "$chosen"

# Every mid-rebase checkout but the one reported.
declare -a also=()
while IFS= read -r p; do [ -z "$p" ] || [ "$p" = "$checkout" ] || also+=("$p"); done \
  < <({ grep '^REBASE' <<< "$host_out" || true; grep '^REBASE' <<< "$vm_out" || true; } | cut -f2-)
if [[ ${#also[@]} -eq 0 ]]; then also_json='[]'; else also_json="$(printf '%s\n' "${also[@]}" | jq -R . | jq -sc 'unique_by(.) | .')"; fi

# Each sprint file, the active one first (a conflicting ticket is often released).
sprint_files() {
  local active f
  active="$(sprint_file "$command" "$project" 2> /dev/null || true)"
  [ -n "$active" ] && echo "$active"
  for f in "$projects/$project"/sprints/sprint-*/sprint.json; do
    [ -f "$f" ] && [ "$f" != "$active" ] && echo "$f"
  done
}
find_ticket() {
  local f t
  while read -r f; do
    t="$(jq -c --arg key "$1" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase))) // empty' "$f")"
    [ -n "$t" ] && { echo "$t"; return 0; }
  done < <(sprint_files)
  return 1
}

# V, FROM — the variation a found ticket's commits pick, and the rule that
# fired. The subjects of every commit on the ticket's conflicting files, so a
# merge-row marker on a commit that does not itself name the key still counts.
pick_variation() {
  local key="$1" t="$2" subj v markers subjects="" f
  for f in ${ticket_files[$key]}; do subjects="${subjects}${file_subjects[$f]-}"; done
  while IFS= read -r subj; do
    [ -n "$subj" ] || continue
    if [[ "$subj" =~ change/${key}\.([A-Za-z0-9]+)-[0-9] ]]; then V="${BASH_REMATCH[1]}" FROM=branch; return; fi
    if [[ "$subj" =~ change/${key}-[0-9] ]]; then V=A FROM=branch; return; fi
  done <<< "$subjects"
  markers="$(grep -oE '[#!][0-9]+' <<< "$subjects" || true)"
  markers="$(jq -Rsc 'split("\n") | map(select(length > 0))' <<< "$markers")"
  v="$(jq -r --argjson m "$markers" 'first(.variations[]? | . as $v | ($v["merge-request"] // [])[] | select(.status == "Merged" and (.key | IN($m[]))) | $v.name) // empty' <<< "$t")"
  [ -n "$v" ] && { V="$v" FROM=merge-request; return; }
  v="$(jq -r '.["selected-variation"].name // empty' <<< "$t")"
  [ -n "$v" ] && { V="$v" FROM=selected-variation; return; }
  V=A FROM=default
}

files_json='[]'
for f in ${files_order[@]+"${files_order[@]}"}; do
  if [ -n "${file_keys[$f]-}" ]; then
    keysj="$(printf '%s\n' ${file_keys[$f]} | jq -R . | jq -sc .)"
    entry="$(jq -nc --arg file "$f" --argjson keys "$keysj" '{file:$file, keys:$keys}')"
  else
    entry="$(jq -nc --arg file "$f" '{file:$file, note:"no ticket identified"}')"
  fi
  files_json="$(jq -c --argjson e "$entry" '. + [$e]' <<< "$files_json")"
done

tickets_json='{}'
for key in ${keys_order[@]+"${keys_order[@]}"}; do
  if t="$(find_ticket "$key")"; then
    pick_variation "$key" "$t"
    title="$(jq -r '.title // ""' <<< "$t")" description="$(jq -r '.description // ""' <<< "$t")"
    ac="$(jq -c --arg v "$V" '[.variations[]? | select(.name == $v) | .["acceptance-criteria"]] | first // []' <<< "$t")"
    tfiles="$(printf '%s\n' ${ticket_files[$key]} | jq -R . | jq -sc .)"
    plan_file="$projects/$project/work/$key/execution-plan-$V.md"
    [ -f "$plan_file" ] && plan_arg=(--rawfile plan "$plan_file") || plan_arg=(--arg plan "")
    tests_file="$projects/$project/work/$key/automated-tests-$V.json"
    tests_json='[]'; [ -f "$tests_file" ] && tests_json="$(cat "$tests_file")"
    obj="$(jq -nc --arg key "$key" --arg variation "$V" --arg from "$FROM" --arg title "$title" --arg description "$description" \
      --argjson ac "$ac" "${plan_arg[@]}" --argjson tests "$tests_json" --argjson files "$tfiles" --argjson commits "${ticket_commits[$key]:-[]}" \
      '{key:$key, variation:$variation, "variation-from":$from, title:$title, description:$description, "acceptance-criteria":$ac, "execution-plan":$plan, "test-commands":$tests, files:$files, commits:$commits}')"
  else
    obj="$(jq -nc --arg key "$key" '{key:$key, found:false}')"
  fi
  tickets_json="$(jq -c --arg key "$key" --argjson obj "$obj" '. + {($key):$obj}' <<< "$tickets_json")"
done

jq -n --arg checkout "$checkout" --argjson vm "$vmj" --arg base "$base" --arg mergebase "$mergebase" \
  --argjson files "$files_json" --argjson tickets "$tickets_json" --argjson also "$also_json" \
  '{checkout:$checkout, vm:$vm, base:$base, "merge-base":$mergebase, files:$files, tickets:$tickets, "also-mid-rebase":$also}'
