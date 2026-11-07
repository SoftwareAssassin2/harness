#!/usr/bin/env bash
# Description: Print the hosts.toml that sends a VM's Docker pulls through its project's registry — registry:hosts-toml <project>.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/registry.bash"

# For the golden image build (ASS-72). The file goes at
#   /etc/docker/certs.d/us-central1-docker.pkg.dev/hosts.toml
# — Docker's own folder: Docker 29 (containerd image store, its default and
# what a project's golden image runs) reads hosts.toml there and NOT in
# /etc/containerd/certs.d, as proven in a clone of a golden image. No image
# name changes, no credential in the VM: Docker asks the first host, then the
# next on a 404, and Artifact Registry itself only when zot fails.
#  1. <zot>/v2/0local — images pushed by registry:push, so a local rebuild wins.
#  2. <zot> — the cache, which fetches from Artifact Registry with the Mac's login.
# "referrers" is needed: without it Docker 29 asks Artifact Registry for each
# image's referrers, unauthenticated, and the pull fails.
#
# To verify in a VM: `docker pull <an Artifact Registry image>` succeeds with
# no login, and the project's <storage>/zot.log shows the GETs for it; pulled
# again (after `docker rmi`), the log shows no "sync: syncing image" for it.
# A project with no upstream (registry.bash) has nothing to mirror: prints
# nothing, and vm:build-golden configures no mirror.
[[ $# -eq 1 ]] || { echo "usage: registry:hosts-toml <project>" >&2; exit 1; }
registry_config registry:hosts-toml "$1"
[[ -n "$upstream" ]] || exit 0

cat <<EOF
server = "https://$upstream"

[host."http://host.lima.internal:$port/v2/$local_namespace"]
  capabilities = ["pull", "resolve", "referrers"]
  override_path = true

[host."http://host.lima.internal:$port"]
  capabilities = ["pull", "resolve", "referrers"]
EOF
