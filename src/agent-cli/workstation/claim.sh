#!/usr/bin/env bash
# Description: Claim a free GCP workstation of a project for one step of a ticket variation, its repositories on the variation's branches — workstation:claim <project> <ticket-key> <variation> [--workstation <id>]; prints { name, machine, credential-kind, pushed, … }, exits 4 when none is free.
set -euo pipefail

# ASS-468 AC1, AC2: a step's start. Control runs it as a step of the
# variation that runs on its machine — an agent's, or a script's such as
# ci-checks:verify — is about to start (src/control/workstation-steps.js),
# and the matching workstation:release at the step's end. Under the
# project's pool lock (workstations-pool.lock), the first workstation of its
# dev-environments list that is free (no holder) and usable now (its gcloud
# login live, connected, set up since: control connects and sets it up while
# a step wants it) is held for the variation: workstations.json's `holder` {
# ticket, variation, folder: <home>/harness, since }, and the variation's
# `workstation` { name, project, folder, since }, which makes it the
# variation's machine for the step (machine.bash $machine_of). Then, as
# workstation-variation.bash says: the shared root made (repos, ticket, mnt,
# run), the variation readied there as a VM is (wsv_start: credentials into
# the runtime folder, a fresh forwarder token and its binding, the ticket's
# read-only copy, the images once per boot), and the shared repositories
# fetched — cloned first when missing, once — and checked out on the
# variation's branches (its merge-request plan's change/<KEY>-<id> in each
# repository it plans one in, made from its planned base when GitLab has no
# such branch yet; every other repository on master at the latest), each
# repository's git hooks refusing a commit on master and naming the branch
# to use (git-hooks.sh, AC10) (step-trees.sh). A failure part way gives the workstation back
# (workstation:release's work) and fails (1). None free: exit 4, why each is
# not on stderr ("no workstation of <p>'s is free: <id>: held by <KEY> <v>;
# …"), nothing claimed. ASS-469: --workstation <id> claims that workstation
# or none — control's way to run a workstation-seat holder's step on its
# seat's workstation (machines follow seats, src/control/seats.js).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"

command=workstation:claim
[[ $# -eq 3 || ( $# -eq 5 && "$4" == --workstation ) ]] || { echo "usage: $command <project> <ticket-key> <variation> [--workstation <id>]" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")" variation="$3" only="${5:-}"
variation_exists "$command" "$project" "$key" "$variation"
[[ -z "$only" ]] || dev_environments_workstation "$command" "$project" "$only" >/dev/null || exit 1
rc=0; wsv_claim "$project" "$key" "$variation" "$only" || rc=$?
[[ $rc -ne 4 ]] || echo "$command: $wsv_why" >&2
exit "$rc"
