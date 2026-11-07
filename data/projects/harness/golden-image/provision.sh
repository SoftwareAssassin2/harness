#!/bin/bash
# The harness project's setup in its golden VM (vm:build-golden), as the VM user
# (passwordless sudo). No credentials. git >= 2.48 comes from the shared git.sh.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive   # for NodeSource's setup, through sudo -E
# sudo resets the environment (env_reset), so DEBIAN_FRONTEND is set on apt's
# own command line; apt's output is kept quiet but printed in full when it fails.
apt() {
  local out
  out="$(sudo DEBIAN_FRONTEND=noninteractive apt-get -y "$@" 2>&1)" || { printf '%s: apt-get %s failed:\n%s\n' "${0##*/}" "$1" "$out" >&2; return 1; }
}
apt update
apt install jq perl uuid-runtime ca-certificates curl gnupg
# Node 24 from NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null
apt install nodejs
# gh (runtime only for harness; installed so the image is a complete dev env)
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
apt update && apt install gh
# Claude Code CLI (no login; its token comes in at start, vm:credentials)
sudo npm install -g --silent @anthropic-ai/claude-code >/dev/null
apt clean
node --version; jq --version; gh --version | head -1; claude --version
