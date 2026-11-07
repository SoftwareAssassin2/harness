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
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"

[[ $# -eq 1 ]] || { echo "usage: vm:golden-status <project>" >&2; exit 1; }
golden_definition vm:golden-status "$1"
golden_status "$1"
