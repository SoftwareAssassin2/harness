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
# even fetched; an entry of the plan naming no repository — an id-less one
# ticket:sync found on the forge — is in none, and is passed over (ASS-321).
# Prints "<repository>: <what happened>" for each, and exits 0
# whatever any one repository did; fails (1) only with no running VM.
#
# ASS-396: a passing hiccup is not a block. A VM it cannot reach (limactl
# shell failing: ssh's 255, the in-VM agent.sh's 125 "host forwarder
# unreachable", any other) and a fetch that fails as a network does (a
# timeout, a connection reset or refused, a host not resolved, an early EOF
# or RPC failure, a 5xx from the forge) are tried 3 times, 5s then 15s apart
# (REFRESH_RETRY_SLEEPS, the sleeps between attempts; the tests make them 0),
# only the repositories still to do each time. Still failing:
# - at grouped-build's Refresh steps (refresh-repositories,
#   refresh-before-testing: the variation's deepest status; v2-build's, the
#   same steps, likewise):
#   exit 2, the steps' waiting-exit-code — polled again on their 5-minute
#   timer, no visit or failure counted — until 30 minutes have passed since
#   the ticket entered the step (its sub-state-change into it in the
#   variation's state-changes), then exit 3 (→ Blocked), printing
#   { ai-feedback-short, ai-feedback-long } naming each failing call and its
#   last error, which the step's record-script-output hands to the Build
#   step. While it waits the variation's ai-feedback says "Refresh
#   Repositories: can't reach <the VM/the forge>, retrying (attempt n, since
#   <time>)", kept with the attempt as refresh-wait { entered, since, attempt,
#   feedback }, written only when it changes (as ASS-386's); a run that gets
#   through clears both, the feedback only while it is still that one.
# - anywhere else (by hand): exit 3 at once, nothing written.
# Any other fetch failure (no such repository, say) is not retried: left as
# it is, a line saying so, as before; a dangling origin/HEAD likewise. Any
# unexpected failure exits 4, never a command's own status (2 or 3 would read
# as waiting or blocked): it matches no exit, so the step tries again.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"
command=vm:refresh-repositories
set -E
trap 'exit 4' ERR
read -ra sleeps <<< "${REFRESH_RETRY_SLEEPS-5 15}"
WAIT_MINUTES=30

[[ $# -eq 3 ]] || { echo "usage: vm:refresh-repositories <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
vm="$(running_vm vm:refresh-repositories "$project" "$key" "$variation")" || exit 1
name='sub("\\.git$"; "") | split("/") | last'
own="$("$agent" ticket:merge-request-plan "$project" "$key" "$variation" | jq -r ".[] | select(.repository != null) | .repository | $name")" || exit 1
refs=() lines=""   # ASS-396: a line per repository, printed once it got through (on giving up, stdout is the feedback alone)
while read -r repo; do
  if grep -qxF -- "$repo" <<< "$own"; then lines+="$repo: the ticket's own, untouched"$'\n'; else refs+=("$repo"); fi
done < <(jq -r ".repositories[]?.url | $name" "$projects/$project/project.json")

# ASS-396: forget_wait — the wait kept on the variation dropped, and its feedback with it while it is still the one written here.
forget_wait() {
  update_whole_ticket "$command" "$project" "$key" --arg name "$variation" '
    .variations |= map(if .name != $name or .["is-deleted"] then . else
      (if .["ai-feedback-long"] == .["refresh-wait"].feedback then .["ai-feedback-short"] = null | .["ai-feedback-long"] = null else . end)
      | del(.["refresh-wait"]) end)'
}
# ran — it got through: any wait kept for it cleared.
ran() {
  [[ "$(variation_field '.["refresh-wait"] != null' "$command" "$project" "$key" "$variation" 2> /dev/null)" == true ]] || return 0
  if forget_wait; then echo "$command: $key $variation: refreshed; its retry feedback cleared" >&2; else echo "$command: could not clear $key $variation's retry feedback" >&2; fi
}
[[ ${#refs[@]} -gt 0 ]] || { ran; printf '%s' "$lines"; exit 0; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# refresh <repo…> — the refresh in the VM; a fetch failing as a network does prints "!transient<TAB><repo><TAB><its error>" (ASS-396).
refresh() {
limactl shell --workdir / "$vm" -- bash -s "$@" <<'EOF'
R="${HARNESS_VM_ROOT-}"   # empty in a VM; tests run this against a folder standing in for its root
for name in "$@"; do
  d="$R/repos/$name"
  say() { echo "$name: $*"; }
  [ -d "$d/.git" ] || { say "left as is: no checkout"; continue; }
  if ! err="$(git -C "$d" fetch -q origin 2>&1 > /dev/null)"; then
    if grep -qiE 'timed out|timeout|connection (reset|refused|closed)|could not resolve host|temporary failure in name resolution|early EOF|RPC failed|returned error: 5[0-9][0-9]|HTTP 5[0-9][0-9]|network is unreachable|broken pipe' <<< "$err"; then
      printf '!transient\t%s\t%s\n' "$name" "$(tr '\n' ' ' <<< "$err" | cut -c1-300)"
    else say "left as is: could not fetch"; fi
    continue
  fi
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
}

# ASS-396: up to 3 attempts, each for the repositories still to do — done once a line names it; still to do after a
# transient fetch, or when the VM was not reached.
pending=("${refs[@]}")
vm_error=""
declare -A fetch_error=() said=() transient=()
for s in ${sleeps[@]+"${sleeps[@]}"} last; do
  rc=0
  refresh "${pending[@]}" > "$tmp/out" 2> "$tmp/err" || rc=$?
  said=() transient=()
  while IFS= read -r line; do
    if [[ "$line" == '!transient'$'\t'* ]]; then rest="${line#*$'\t'}"; transient[${rest%%$'\t'*}]="${rest#*$'\t'}"
    elif [[ "$line" == *": "* ]]; then said[${line%%: *}]="$line"; fi
  done < "$tmp/out"
  next=()
  for repo in "${pending[@]}"; do
    if [[ -n "${said[$repo]-}" ]]; then lines+="${said[$repo]}"$'\n'; unset "fetch_error[$repo]"
    else [[ -z "${transient[$repo]-}" ]] || fetch_error[$repo]="${transient[$repo]}"; next+=("$repo"); fi
  done
  vm_error=""
  [[ $rc -eq 0 ]] || vm_error="limactl shell $vm (exit $rc): $(tr '\n' ' ' < "$tmp/err" | cut -c1-300)"
  pending=(${next[@]+"${next[@]}"})
  [[ ${#pending[@]} -gt 0 ]] || break
  [[ "$s" == last ]] || sleep "$s"
done
[[ ${#pending[@]} -gt 0 ]] || { ran; printf '%s' "$lines"; exit 0; }
printf '%s' "$lines" >&2

# Still failing after its retries: what it could not reach, and each failing call with its last error.
could="" reach=""
could_not() { could+="$2"$'\n'; [[ ", $reach, " == *", $1, "* ]] || reach+="${reach:+, }$1"; }
[[ -z "$vm_error" ]] || could_not "the VM ($vm)" "$vm_error"
for repo in "${pending[@]}"; do
  [[ -z "${fetch_error[$repo]-}" ]] || could_not "the forge, from the VM ($vm)" "$repo: git fetch origin in the VM: ${fetch_error[$repo]}"
done
echo "$command: could not refresh ${pending[*]}: $could" >&2

# At grouped-build's (or v2-build's) Refresh steps it waits, up to WAIT_MINUTES since the ticket entered the step, then gives up (3); anywhere else, 3 at once.
was="$(variation_field '{
    at: ([.["harness-status"] | recurse(.["sub-status"] // empty) | "\(.["state-engine"])/\(.state)"] | last),
    entered: (last(.["state-changes"] // [] | .[] | select([recurse(.["sub-state-change"] // empty)] | last
      | (.["state-engine"] | IN("grouped-build", "v2-build")) and (.["to-state"] | IN("refresh-repositories", "refresh-before-testing")) and .["from-state"] != .["to-state"]) | .timestamp) // null),
    kept: .["refresh-wait"], long: .["ai-feedback-long"] }' "$command" "$project" "$key" "$variation")" || exit 3
[[ "$(jq -r .at <<< "$was")" =~ ^(grouped|v2)-build/refresh-(repositories|before-testing)$ ]] || exit 3
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
wait="$(jq -c --arg now "$now" --argjson limit "$WAIT_MINUTES" '
  def secs: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
  (.kept != null and .kept.entered == .entered) as $same
  | { entered, since: (if .entered != null then .entered elif $same then .kept.since else $now end), attempt: (if $same then .kept.attempt + 1 else 1 end) }
  | .over = (($now | secs) - (.since | secs) >= $limit * 60)' <<< "$was")"
IFS=$'\t' read -r since attempt over < <(jq -r '[.since, .attempt, .over] | @tsv' <<< "$wait")
if [[ "$over" == true ]]; then
  short="Refresh Repositories: still can't reach $reach after $WAIT_MINUTES minutes (attempt $attempt, since $since); Blocked"
  long="$short. What kept failing, with its last error:"$'\n'"$could"
  forget_wait || true
  echo "$command: $key $variation: $short" >&2
  jq -nc --arg short "$short" --arg long "$long" '{ "ai-feedback-short": $short, "ai-feedback-long": $long }'
  exit 3
fi
short="Refresh Repositories: can't reach $reach, retrying (attempt $attempt, since $since)"
long="$short. What failed, with its last error:"$'\n'"$could"
if ! jq -e --arg long "$long" '.kept.feedback == $long and .long == $long' <<< "$was" > /dev/null; then
  update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --arg short "$short" --arg long "$long" --argjson wait "$wait" '
    .variations |= map(if .name != $name or .["is-deleted"] then . else
      .["ai-feedback-short"] = $short | .["ai-feedback-long"] = $long | .["refresh-wait"] = ($wait | del(.over) | .feedback = $long) end)'
  echo "$command: $key $variation: $short" >&2
fi
exit 2
