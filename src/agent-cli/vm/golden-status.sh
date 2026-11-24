#!/usr/bin/env bash
# Description: Whether a project's golden image is current, being built, or its build failed, with the logs — vm:golden-status <project>; prints JSON.
set -euo pipefail

# ASS-151: how a fast-tracked "Rebuild golden-<project>" ticket's agents
# (Build, which starts the build with vm:build-golden-start, and Test, which
# judges it once settled — the engine waits, ASS-157: vm:golden-ready) see the build from their VM: the forwarder allows it for a
# fast-tracked ticket's VM alone. Prints golden.bash's golden_status:
#   { project, image, status: current | building | failed, exit-code, log, run-log }
# Reads, never builds; fails, naming why, when the project or its
# definition is missing.
#
# ASS-534: a project declaring a Substrate sandbox (sandbox/services.yaml) is
# reported with its sandbox images, one per declared architecture
# (sandbox-image.bash sandbox_status) —
#   { …, status, "vm-status": <the VM image's>, "sandbox-images": { <arch>: { image, arch, status, digest, ref, built-at, exit-code, log, … } } }
# — and status is the golden environment's as a whole: building while the VM
# image or a sandbox image builds (or the started run lives); else current
# when every one of them is; else failed. So a rebuild ticket's Await the
# Golden Build (vm:golden-ready) and Test judge both. A project declaring
# none prints exactly the VM image's, as before.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate/sandbox-image.bash"

[[ $# -eq 1 ]] || { echo "usage: vm:golden-status <project>" >&2; exit 1; }
sandbox_definition vm:golden-status "$1"
vm="$(golden_status "$1")"
if [[ "$declared" != true ]]; then echo "$vm"; exit 0; fi
jq -c --argjson s "$(sandbox_statuses "$1")" '
  .status as $vm | [$s[].status] as $all
  | . + { status: (if $vm == "building" or any($all[]; . == "building") then "building"
                   elif $vm == "current" and all($all[]; . == "current") then "current" else "failed" end),
          "vm-status": $vm, "sandbox-images": $s }' <<<"$vm"
