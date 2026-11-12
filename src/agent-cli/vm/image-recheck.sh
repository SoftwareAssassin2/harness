#!/usr/bin/env bash
# Description: Verify Repair Image's repair — the golden image current, the ticket's VM cloned from it, the blocked step's failing check passing there — vm:image-recheck <project> <ticket-key> <variation>; prints JSON.
set -euo pipefail

# ASS-392 AC4: grouped-blocked's Verify the Repaired Image, after Repair
# Image says it fixed the block. Done only when the failing check passes on
# a VM from the repaired image, so, in order:
#   1. golden-<project> is current (golden.bash golden_status): not being
#      built, and built from its definition as it is now — an edit of the
#      definition not yet built, or a build that failed, is no repair;
#   2. the variation's VM, when it has one, is a clone of that image: its
#      label's generation (vm.bash generation_of) is golden-<project>'s — an
#      older clone does not have the repair (vm:recreate puts it on the new one);
#   3. the blocked step's failing check passes there: ticket:recheck-block,
#      as Check First runs it, logged as this step.
# Exits, printing JSON (record-script-output keeps it on the run):
#   0  all three: the run is done, the ticket resumes — recheck-block's JSON
#      plus image-verified: true;
#   2  1 and 2 hold, but the harness has no check to re-run (the step blocked
#      is an agent's, or one that makes a VM: recheck-block's rechecked
#      false) — Repair Image's own run of it on the new VM stands;
#   3  not verified: { image-verified: false, ai-feedback-short,
#      ai-feedback-long } — Blocked for Human with what was tried;
#   1  bad arguments, an unknown ticket, variation or project (the step's
#      catch-all: Blocked for Human).
# Every outcome is logged in the variation's change log (work.bash blocked_log).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
source "$here_vm/work.bash"

command=vm:image-recheck title="Verify the Repaired Image"
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3"
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
[[ "$status" != building ]] || unverified "Repair Image: $golden is still being built" "$golden is still being built, so the repair cannot be checked on it yet. Have AI Try Again once it has finished."
[[ "$status" == current ]] || unverified "Repair Image: $golden is not built from its current definition" "$golden is not current: its definition changed since its last build, or its last build failed (see data/projects/$project/golden-image-build.log). The repair is not in an image any VM can be cloned from."
current="$(generation_of "$(limactl list "$golden" --format '{{.Dir}}' 2>/dev/null)")"
vm="$(jq -r --arg key "$key" --arg name "$variation" 'first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)))
  | first(.variations // [] | .[] | select(.name == $name and (.["is-deleted"] | not))) | .vm.name // empty' "$(sprint_file "$command" "$project")")"
if [[ -n "$vm" ]] && limactl list "$vm" --format '{{.Status}}' >/dev/null 2>&1; then
  mine="$(generation_of "$(limactl list "$vm" --format '{{.Dir}}')")"
  [[ -n "$current" && "$mine" == "$current" ]] \
    || unverified "Repair Image: $vm is not a clone of the repaired $golden" "$vm was cloned from an older $golden (generation ${mine:-unknown}, the image's ${current:-unknown}): it does not have the repair. vm:recreate $project $key $variation puts the ticket on a VM from the current image."
fi

code=0
out="$(RECHECK_STEP="$title" RECHECK_NEXT_PASS="The ticket resumes." RECHECK_NEXT_FAIL="Blocked for Human." RECHECK_NEXT_NONE="Repair Image's run of the failing check stands." "$agent" ticket:recheck-block "$project" "$key" "$variation")" || code=$?
on="${vm:-no VM yet}, $golden generation ${current:-unknown}"
if [[ $code -eq 0 ]]; then
  blocked_log "$project" "$key" "$variation" "$title" "Verified: the failing check passes on a VM from the repaired image ($on)."
  jq -c '. + { "image-verified": true }' <<< "$out"
  exit 0
fi
if [[ $code -eq 3 && "$(jq -r '.rechecked' <<< "$out" 2>/dev/null)" == false ]]; then
  blocked_log "$project" "$key" "$variation" "$title" "The image is current and the VM its clone ($on); the harness has no check of its own to re-run ($(jq -r '.["recheck-why"]' <<< "$out")): Repair Image's run of the failing check on it stands."
  jq -c '. + { "image-verified": true }' <<< "$out"
  exit 2
fi
[[ $code -eq 3 ]] || unverified "Repair Image: the failing check could not be re-run" "The image is current and the VM its clone ($on), but ticket:recheck-block failed (exit $code), so the repair is not shown to work."
unverified "Repair Image: the failing check still fails on a VM from the repaired image" "The image is current and the VM its clone ($on), but the blocked step's check still fails there: \`$(jq -r '.recheck.command' <<< "$out")\` exit $(jq -r '.recheck.exit' <<< "$out"). Its last lines: $(jq -r '.recheck.output // ""' <<< "$out")"
