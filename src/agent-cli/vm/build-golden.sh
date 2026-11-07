#!/usr/bin/env bash
# Description: Build a project's golden VM image, or reuse it when none of its inputs changed — vm:build-golden <project> [--fix <what it fixed>].
set -euo pipefail

# The image is the Lima instance golden-<project> under LIMA_HOME (the env
# var, else harness.local.json's lima-home, else harness.json's, else ~/.lima: lima-home.bash, ASS-273),
# where VMs, copy-on-write clones of it, must live too. Its definition is the folder project.json's "golden-image" names —
#   { "folder": "projects/<project>/golden-image" }   (relative to the data folder, data/)
# — and, optionally, "tools": the build tools its VM agents need (ASS-229),
# which provision.sh installs; each is checked on the VM's PATH after it, one
# missing failing the build before its long steps. Not an input of the hash.
# With them, claude when the project declares the claude or anthropic
# credential (ASS-234): the one credential kind whose tool runs in a VM —
# forge and Jira work runs on the host, its tokens in a VM for git and npm.
# The folder holds:
#   template.yaml  the Lima template
#   provision.sh   the project's setup, run in the VM as its user (passwordless sudo)
#   images.txt     images to bake in, one per line (# comments), pulled through
#                  the project's zot, which must be running (registry:up)
#   warm.sh        optional, run last: warms caches with the cloned repositories;
#                  stdin as repositories.sh's
#   tests.json     with run-test.sh, every repository's automated tests, for
#                  vm:test-repos (ASS-105); not inputs of the image
#   ci-checks.json the merge-request CI checks ci-checks:verify runs in a ticket's
#                  VM (ASS-249); not an input of the image either (ASS-250)
# Around them run the harness's shared steps (golden-image/ beside this file):
# git.sh, desktop.sh (ASS-76), registry.sh, a restart (for group changes and
# desktop.sh's kernel), repositories.sh (a clone
# of each repository at /repos/<basename>), images.sh, finish.sh.
#
# The image is tagged with the sha256 of its inputs, recorded in
# <LIMA_HOME>/golden-<project>/golden-image.json: every file of the definition
# and of the shared steps, the repository URLs, and the registry mirror. Not
# the repositories' commits or files: VMs fetch master when they start. When
# golden-<project> already has the current hash, nothing is built (AC2).
# Otherwise it is built as golden-<project>-build, and replaces golden-<project>
# only once complete; a failed build is left for inspection and deleted by the
# next run. Tokens for private clones (gh, glab) reach the VM over stdin only.
# Before it is recorded, the stopped build is scanned (vm:scan-image, AC4) for
# the project's declared tokens and those gh and glab tokens, which go to the
# scan in its environment; any found fails the build. So the scan cannot fail
# on them after a long build, the declared items are read before it starts.
# A build given --fix (ASS-234: it fixes a defect of the last image) records
# it in the label, as fix (<what it fixed>) and fixed-at (its built-at);
# a later build carries the last fix on, so vm:create recreates a VM cloned
# from an image older than it whose Setup never completed.
# Build time and disk size are printed, recorded in the label, and every
# step's output goes to data/projects/<project>/golden-image-build.log.
# One build of a project runs at a time (ASS-149): a second, while the lock
# data/projects/<project>/golden-build.lock is held, fails at once, saying so,
# rather than clobber golden-<project>-build. It is held to the end — not by
# the build VM's host agent, which outlives this shell: started without its
# descriptor. The project's VM lock (vm.bash lock_vms) is held for the
# delete-and-rename swap only, as vm:create holds it while it clones
# golden-<project>, so no VM is cloned from half an image; the ~50-minute
# build itself takes no VM lock, and touches no VM but its own and the image.
# GOLDEN_IMAGE_SHARED overrides the shared steps' folder, for tests.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm-credentials.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"   # lock_vms

[[ $# -eq 1 || ( $# -eq 3 && "$2" == --fix && -n "$3" ) ]] || { echo "usage: vm:build-golden <project> [--fix <what it fixed>]" >&2; exit 1; }
project="$1" fix="${3-}"
golden_definition vm:build-golden "$project"
golden="golden-$project" build="golden-$project-build"
lock_on 7 "$projects/$project/golden-build.lock" vm:build-golden 1 2>/dev/null \
  || { echo "vm:build-golden: $golden is being built already ($projects/$project/golden-build.lock is held); not starting another" >&2; exit 1; }
label="$(golden_label "$project")"
if [[ -f "$label" && "$(jq -r .hash "$label")" == "$hash" ]]; then
  echo "vm:build-golden: $golden is current (inputs ${hash:0:12}); nothing built"
  exit 0
fi

decl="$(declared_credentials vm:build-golden "$project")"
read_tokens vm:build-golden "$project" "$decl"
! jq -e 'has("claude") or has("anthropic")' <<< "$decl" >/dev/null || [[ " ${tools[*]} " == *" claude "* ]] || tools+=(claude)
if [[ -n "$images" ]] && ! curl -fs -o /dev/null "http://127.0.0.1:$port/v2/"; then
  echo "vm:build-golden: $project's registry is not answering on 127.0.0.1:$port, and images.txt is pulled through it — start it (registry:up $project) and run again" >&2
  exit 1
fi
forge_tokens vm:build-golden "${repos[@]}"
tokens() { printf '%s\n%s\n' "$gh_token" "$gl_token"; }

log="$(cd "$projects/$project" && pwd -P)/golden-image-build.log"
: > "$log"
started=$SECONDS
# step <name> <command…> — runs it with its output in the log, printing how long it took; stops the build on failure.
step() {
  local name="$1" t=$SECONDS; shift
  echo "== $name" >> "$log"
  "$@" >> "$log" 2>&1 || { echo "vm:build-golden: $name failed — see $log; $build is left for inspection (the next run deletes it)" >&2; exit 1; }
  echo "vm:build-golden: $name $((SECONDS - t))s"
}
# in_vm <script> <args…> — runs a local script in the build VM, as its user.
in_vm() { local script="$1"; shift; limactl shell --workdir / "$build" -- bash -c "$(cat "$script")" "$(basename "$script")" "$@"; }

echo "vm:build-golden: building $golden (inputs ${hash:0:12}); log: $log"
[[ ! -d "$LIMA_HOME/$build" ]] || step "delete the last failed build" limactl delete -f "$build"
step create limactl create --name="$build" --tty=false "$folder/template.yaml"
step start limactl start --tty=false "$build" 7>&-
step provision in_vm "$folder/provision.sh" </dev/null
[[ ${#tools[@]} -eq 0 ]] || step tools limactl shell --workdir / "$build" -- bash -c 'f=0; for t; do command -v "$t" || { echo "$t is not on PATH"; f=1; }; done; exit $f' tools "${tools[@]}" </dev/null
step git in_vm "$shared/git.sh" </dev/null
step desktop in_vm "$shared/desktop.sh" </dev/null
[[ -z "$hosts_toml" ]] || printf '%s\n' "$hosts_toml" | step registry in_vm "$shared/registry.sh" "$upstream"
step stop limactl stop "$build"
step start limactl start --tty=false "$build" 7>&-
tokens | step repositories in_vm "$shared/repositories.sh" "${repos[@]}"
[[ -z "$images" ]] || printf '%s\n' "$images" | step images in_vm "$shared/images.sh"
[[ ! -f "$folder/warm.sh" ]] || tokens | step warm in_vm "$folder/warm.sh"
step finish in_vm "$shared/finish.sh" </dev/null
step stop limactl stop "$build"
SCAN_GH_TOKEN="$gh_token" SCAN_GL_TOKEN="$gl_token" step scan "$agent" vm:scan-image "$project" "$build"

seconds=$((SECONDS - started))
kib="$(du -sk "$LIMA_HOME/$build" | cut -f1)"
jq -n --arg p "$project" --arg h "$hash" --arg in "$inputs" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson s "$seconds" --argjson b "$((kib * 1024))" \
  --arg fix "$fix" --slurpfile old <(cat "$label" 2>/dev/null || true) \
  '{ project: $p, hash: $h, "built-at": $at, "build-seconds": $s, "disk-bytes": $b, inputs: ($in | rtrimstr("\n") | split("\n")) }
  + if $fix != "" then { fix: $fix, "fixed-at": $at } else ($old[0] // {} | with_entries(select(.key == "fix" or .key == "fixed-at"))) end' > "$LIMA_HOME/$build/golden-image.json"
lock_vms vm:build-golden "$project"
[[ ! -d "$LIMA_HOME/$golden" ]] || step "delete the old image" limactl delete -f "$golden"
step rename limactl rename "$build" "$golden"
unlock_vms
summary="built $golden in $((seconds / 60))m $((seconds % 60))s; $(awk -v k="$kib" 'BEGIN { printf "%.2f GiB", k / 1048576 }') on disk; inputs ${hash:0:12}"
echo "$summary" >> "$log"
echo "vm:build-golden: $summary"
