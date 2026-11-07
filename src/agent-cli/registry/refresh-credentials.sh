#!/usr/bin/env bash
# Description: Give a project's zot the Mac's current login to its upstream — registry:refresh-credentials <project>; control runs it every 30 minutes.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/registry.bash"

# Writes `gcloud auth print-access-token` (the Mac's own login; no credential
# ever reaches a VM) to the project's credentials.json, the sync credentialsFile
# zot reads, as { "<upstream>": { "username": "oauth2accesstoken", "password":
# <token> } }, 0600. Tokens last about an hour, so the half-hourly run always
# holds a live one. zot reads the file only when it loads its config, and
# reloads its config when the file changes, so a new token touches config.json:
# no restart, no pull cut off. An unchanged token writes nothing. Fails, the
# last login left be, when gcloud is not logged in. A project with no upstream
# (registry.bash) has nothing to log in to: says so, and never calls gcloud.
[[ $# -eq 1 ]] || { echo "usage: registry:refresh-credentials <project>" >&2; exit 1; }
registry_config registry:refresh-credentials "$1"
[[ -n "$upstream" ]] || { echo "$1's registry has no upstream; no credentials to refresh"; exit 0; }

token="$(gcloud auth print-access-token 2>/dev/null)" && [[ -n "$token" ]] \
  || { echo "registry:refresh-credentials: gcloud is not logged in on this Mac, so $1's registry cannot reach $upstream — run gcloud auth login, then registry:refresh-credentials $1" >&2; exit 1; }

mkdir -p "$storage"
file="$storage/credentials.json"
new="$(jq -n --arg host "$upstream" --arg token "$token" '{ ($host): { username: "oauth2accesstoken", password: $token } }')"
if [[ -f "$file" && "$(cat "$file")" == "$new" ]]; then echo unchanged; exit 0; fi

# Written beside, 0600 before the token is in it, and renamed over.
(umask 077; printf '%s\n' "$new" > "$file.$$") && mv -f "$file.$$" "$file"
[[ ! -f "$storage/config.json" ]] || touch "$storage/config.json"
echo refreshed
