#!/usr/bin/env bash
# Description: Get pnpm a working token for the GitLab npm registries a project's workspace uses — npm-registry-login <project>; asks you to make one only when needed.
set -euo pipefail

# The registries are the gitlab.com `@scope:registry=` lines of the workspace's
# .npmrc (project.json's local-pc folder). For each, a token pnpm already holds
# (user config, //host/path:_authToken) is kept when GitLab still accepts it.
# Otherwise the browser opens GitLab's new-token page, filled in for a
# read_api token, and the token you paste (hidden) is tried against the
# registry's project before pnpm stores it; three refusals and it gives up.
# A personal access token, not glab's: glab's is OAuth and expires in hours.
# The token goes only to GitLab and to pnpm's user config, never the repo.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../agent-cli/code.bash"

[[ $# -eq 1 ]] || { echo "usage: npm-registry-login <project>" >&2; exit 1; }
workspace="$(workspace_of npm-registry-login "$1")"
token_page='https://gitlab.com/-/user_settings/personal_access_tokens?name=harness-pnpm&scopes=read_api'

# accepted <registry> <token> — GitLab answers 200 for the registry's project with this token.
accepted() {
  local api="${1%/packages/npm/}"
  [[ "$(printf 'header = "PRIVATE-TOKEN: %s"\n' "$2" | curl -s -o /dev/null -w '%{http_code}' -K - "$api")" == 200 ]]
}

registries="$(sed -nE 's#^@[^:]+:registry=(https://gitlab\.com/api/v4/projects/[0-9]+/packages/npm/)[[:space:]]*$#\1#p' "$workspace/.npmrc" 2>/dev/null | sort -u)"
[[ -n "$registries" ]] || { echo "No GitLab npm registry in $workspace/.npmrc; nothing to log in to."; exit 0; }

while read -r registry <&3; do
  key="//${registry#https://}:_authToken"
  held="$(pnpm config get --location=user "$key" 2>/dev/null || true)"
  if [[ -n "$held" && "$held" != undefined ]] && accepted "$registry" "$held"; then
    echo "✓ $registry: pnpm's token still works."
    continue
  fi
  echo "pnpm needs a GitLab token for $registry."
  echo "Opening GitLab's new-token page (name and read_api scope filled in): pick an expiry, Create, copy the token."
  echo "  $token_page"
  open "$token_page" 2>/dev/null || true
  for attempt in 1 2 3; do
    read -rsp "Paste the token: " token || { echo; echo "No token given." >&2; exit 1; }
    echo
    if accepted "$registry" "$token"; then
      pnpm config set --location=user "$key" "$token"
      echo "✓ $registry: token accepted and stored in pnpm's user config."
      continue 2
    fi
    echo "✗ GitLab rejected that token (needs read_api scope, and access to the project)."
  done
  echo "Gave up after three rejected tokens." >&2
  exit 1
done 3<<< "$registries"

echo "Done. New worktrees will install their dependencies on their own."
