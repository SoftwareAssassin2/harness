#!/bin/bash
# Golden image step (vm:build-golden), shared by every project: clones each
# repository URL given ($@) to /repos/<basename>, owned by the VM user (Claude
# refuses root). stdin: the GitHub token, then the GitLab token, one per line
# (either may be empty). They live only in this process's environment: an
# inline credential helper answers git with them, so no token reaches the
# disk, a git config or a remote URL.
set -euo pipefail
IFS= read -r GH_TOKEN || true; IFS= read -r GITLAB_TOKEN || true
export GH_TOKEN GITLAB_TOKEN GIT_TERMINAL_PROMPT=0
sudo install -d -o "$(id -u)" -g "$(id -g)" /repos
for url in "$@"; do
  dir="/repos/$(basename "$url" .git)"
  [[ -d "$dir" ]] && continue
  case "$url" in https://github.com/*) user=x-access-token var=GH_TOKEN ;; *) user=oauth2 var=GITLAB_TOKEN ;; esac
  git -c credential.helper= -c "credential.helper=!f() { test \"\$1\" = get && echo username=$user && echo \"password=\$$var\"; }; f" \
    clone -q "$url" "$dir"
  echo "cloned $url"
done
