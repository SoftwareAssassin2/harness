#!/usr/bin/env bash
# Description: Verify Blocked's VM or image repair on the ticket's fixed VM — the blocked step's failing check passing there, the image's state logged — vm:image-recheck <project> <ticket-key> <variation>; prints JSON.
set -euo pipefail

# ASS-392 AC4, ASS-427 AC6: grouped-blocked's Verify the Repaired Image,
# after Repair the VM (its fix made in the ticket's VM, the same fix written
# into its source) or Repair Image says it fixed the block. It verifies the
# ticket on its fixed VM: the blocked step's failing check passes there
# (ticket:recheck-block, as Check First runs it, logged as this step) — the
# ticket's VM need not be a clone of the newest golden image, nor the image
# current: a rebuild started for the fix is checked by its own build (its
# tools check), its result logged on the ticket by vm:golden-followup, never
# waited on here. What the image and the VM are is logged with the outcome:
# golden-<project>'s status (current, building, or not built from its
# definition as it is now) and generation, and the VM's own generation.
# Exits, printing JSON (record-script-output keeps it on the run):
#   0  the check passes: the run is done, the ticket resumes — recheck-block's
#      JSON plus image-verified: true;
#   2  the harness has no check to re-run (the step blocked is an agent's, or
#      one that makes a VM: recheck-block's rechecked false) — the repair's
#      own run of it on the fixed VM stands;
#   3  not verified: { image-verified: false, ai-feedback-short,
#      ai-feedback-long } — Blocked for Human with what was tried;
#   1  bad arguments, an unknown ticket, variation or project (the step's
#      catch-all: Blocked for Human).
# Every outcome is logged in the variation's change log (work.bash blocked_log).
# ASS-474: a block that was a loop which ran out of visits is verified by the
# step that kept failing in it, not the step it was blocked at
# (RECHECK_LOOP_PASS: its pass is the repair's proof).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/work.bash"

command=vm:image-recheck title="Verify the Repaired Image"
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
lima_use "$project" || exit 1   # ASS-578: its Lima folder, for every limactl below
variation_exists "$command" "$project" "$key" "$variation"
golden_definition "$command" "$project"
golden="golden-$project"
# unverified <short> <long> — logged, printed, exit 3.
unverified() {
  blocked_log "$project" "$key" "$variation" "$title" "Not verified: $2"
  jq -nc --arg s "$1" --arg l "$2" '{ "image-verified": false, "ai-feedback-short": $s, "ai-feedback-long": $l }'
  echo "$command: $2" >&2
  exit 3
}

status="$(golden_status "$project" | jq -r .status)"
current="$(generation_of "$(lima_list "$golden" --format '{{.Dir}}' 2>/dev/null)")"
vm="$(jq -r --arg key "$key" --arg name "$variation" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
  | first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) | .vm.name // empty' "$(sprint_file "$command" "$project")")"
mine=""
[[ -z "$vm" ]] || ! machine_status "$vm" >/dev/null 2>&1 || mine="$(generation_of "$(lima_list "$vm" --format '{{.Dir}}')")"
case "$status" in
  current) image="$golden current (generation ${current:-unknown})" ;;
  building) image="$golden being rebuilt (its build checks itself; its result is logged here when it ends)" ;;
  *) image="$golden not built from its definition as it is now (generation ${current:-unknown}: a rebuild with the fix is followed by vm:golden-followup)" ;;
esac

code=0
out="$(RECHECK_LOOP_PASS=1 RECHECK_STEP="$title" RECHECK_NEXT_PASS="The ticket resumes." RECHECK_NEXT_FAIL="Blocked for Human." RECHECK_NEXT_NONE="The repair's own run of the failing check stands." "$agent" ticket:recheck-block "$project" "$key" "$variation")" || code=$?
on="${vm:-no VM yet}${mine:+, a clone of generation $mine}; $image"
if [[ $code -eq 0 ]]; then
  blocked_log "$project" "$key" "$variation" "$title" "Verified: the failing check passes on the ticket's fixed VM ($on)."
  jq -c '. + { "image-verified": true }' <<< "$out"
  exit 0
fi
if [[ $code -eq 3 && "$(jq -r '.rechecked' <<< "$out" 2>/dev/null)" == false ]]; then
  blocked_log "$project" "$key" "$variation" "$title" "The harness has no check of its own to re-run ($(jq -r '.["recheck-why"]' <<< "$out")): the repair's own run of the failing check on the fixed VM stands ($on)."
  jq -c '. + { "image-verified": true }' <<< "$out"
  exit 2
fi
[[ $code -eq 3 ]] || unverified "Repair: the failing check could not be re-run" "ticket:recheck-block failed (exit $code) on the ticket's VM ($on), so the repair is not shown to work."
unverified "Repair: the failing check still fails on the ticket's fixed VM" "The blocked step's check still fails on the ticket's VM after the repair ($on): \`$(jq -r '.recheck.command' <<< "$out")\` exit $(jq -r '.recheck.exit' <<< "$out"). Its last lines: $(jq -r '.recheck.output // ""' <<< "$out")"
