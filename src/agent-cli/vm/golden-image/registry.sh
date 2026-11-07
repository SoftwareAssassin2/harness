#!/bin/bash
# Golden image step (vm:build-golden), shared by every project: sends the VM's
# Docker pulls from $1 (Artifact Registry) through the project's zot. stdin is
# the hosts.toml registry:hosts-toml prints (ASS-70). Docker 29 reads it from
# its own certs.d (not /etc/containerd/certs.d), and only with the containerd
# image store, turned on here so no upgrade can turn it off. Takes effect at
# the restart that follows. An image without Docker is left alone.
set -euo pipefail
toml="$(cat)"
command -v docker >/dev/null || { echo "registry: no Docker in this image; nothing to configure"; exit 0; }
sudo install -d -m 0755 "/etc/docker/certs.d/$1"
printf '%s\n' "$toml" | sudo tee "/etc/docker/certs.d/$1/hosts.toml" >/dev/null
echo '{ "features": { "containerd-snapshotter": true } }' | sudo tee /etc/docker/daemon.json >/dev/null
