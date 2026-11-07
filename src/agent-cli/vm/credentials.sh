#!/usr/bin/env bash
# Description: Log a running VM in with its project's credentials, from the keychain, onto its tmpfs — vm:credentials <project> <vm>.
set -euo pipefail

# Reads the project's declared credentials (~/.harness/vm-credentials.json,
# see vm-credentials.bash) from the Mac's keychain — all but atlassian: no
# Jira credential goes into a VM (ASS-238; Jira work runs on the host) —
# failing before anything is sent when any item is missing, empty or
# unreadable (AC4). Then pipes one
# generated script to `limactl shell <vm> -- bash -s`, so the tokens travel on
# stdin, never on a command line. In the VM the script:
# - re-creates /run/harness (0700, the VM user's) and refuses to go on unless
#   it is on tmpfs: credentials never reach the VM's disk, and a restart
#   clears them, so every start re-reads the keychain (AC5);
# - keeps vm:start's forwarder files, agent-token and agent-url, across that
#   re-creation (ASS-215), so a run on a running VM leaves its agent.sh able
#   to reach the forwarder; held meanwhile in a shell variable only, never in
#   a copy on the VM's disk;
# - writes /run/harness/env (KEY=value lines): CLAUDE_CODE_OAUTH_TOKEN or
#   ANTHROPIC_API_KEY,
#   GH_TOKEN, GITLAB_TOKEN + GITLAB_HOST for the kinds declared — for git
#   and the npm registries only: merge requests are read and edited on the
#   host (merge-request:view/update, ASS-238) — and always
#   GH_CONFIG_DIR, GLAB_CONFIG_DIR, NPM_CONFIG_USERCONFIG and
#   GIT_CONFIG_GLOBAL pointing into /run/harness, so no tool writes its login
#   or config to the disk;
# - writes /run/harness/gitconfig: user.name/user.email from the git entry,
#   a credential helper per forge that answers with the env token over https,
#   and an insteadOf rule turning git@<forge>: remotes into https (no SSH
#   agent forwarding);
# - writes /run/harness/npmrc with gitlab's npm-registries (scope → project
#   id), their auth taken from ${GITLAB_TOKEN};
# - writes /etc/profile.d/harness-credentials.sh, which holds no token and
#   sources the env file when present, so every login shell — and every
#   `limactl shell` command — has the credentials.
# A dev container in the VM (a project's) gets the same by being started with
# `--env-file /run/harness/env -v /run/harness:/run/harness` as the VM user:
# every path in the env file is the same inside it.
# On success prints the credential kind injected (ASS-215): `anthropic` or
# `claude`, the one the project declares, `both` when it declares both
# (ASS-217), or nothing when it declares neither.
# LIMA_HOME as lima-home.bash resolves it (ASS-273): the env var, else
# harness.local.json's lima-home (ASS-281), else harness.json's, else ~/.lima.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm-credentials.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../lima-home.bash"
LIMA_HOME="$(lima_home)"; export LIMA_HOME

[[ $# -eq 2 ]] || { echo "usage: vm:credentials <project> <vm>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "vm:credentials: invalid project '$1'" >&2; exit 1; }
[[ "$2" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "vm:credentials: invalid VM '$2'" >&2; exit 1; }
project="$1" vm="$2"

decl="$(declared_credentials vm:credentials "$project" | jq -c 'del(.atlassian)')"
read_tokens vm:credentials "$project" "$decl"
field() { jq -r --arg k "$1" --arg f "$2" '.[$k][$f] // empty' <<< "$decl"; }
gitlab_host="$(field gitlab host)"; gitlab_host="${gitlab_host:-gitlab.com}"
[[ "$gitlab_host" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "vm:credentials: invalid gitlab host '$gitlab_host'" >&2; exit 1; }

# q <words…> — each word quoted for the VM's bash.
q() { printf ' %q' "$@"; }

# helper <user> <env var> — a git credential helper answering with the token in that variable.
helper() { echo "!f() { test \"\$1\" = get && echo username=$1 && echo \"password=\$$2\"; }; f"; }

injection_script() {
  cat <<'EOF'
set -euo pipefail
umask 077
R="${HARNESS_VM_ROOT-}"   # empty in a VM; tests run this against a folder standing in for its root
h="$R/run/harness"
t=; u=
[ -r "$h/agent-token" ] && t="$(cat "$h/agent-token")"
[ -r "$h/agent-url" ] && u="$(cat "$h/agent-url")"
sudo rm -rf "$h"
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" "$h"
if [ "$(findmnt -n -o FSTYPE --target "$h")" != tmpfs ]; then
  sudo rm -rf "$h"; echo "vm:credentials: /run/harness is not on tmpfs; no credential written" >&2; exit 1
fi
[ -z "$t" ] || printf '%s\n' "$t" > "$h/agent-token"
[ -z "$u" ] || printf '%s\n' "$u" > "$h/agent-url"
EOF
  local env=(GH_CONFIG_DIR=/run/harness/gh GLAB_CONFIG_DIR=/run/harness/glab
             NPM_CONFIG_USERCONFIG=/run/harness/npmrc GIT_CONFIG_GLOBAL=/run/harness/gitconfig)
  [[ -v TOKENS[claude] ]] && env+=("CLAUDE_CODE_OAUTH_TOKEN=${TOKENS[claude]}")
  [[ -v TOKENS[anthropic] ]] && env+=("ANTHROPIC_API_KEY=${TOKENS[anthropic]}")
  [[ -v TOKENS[github] ]] && env+=("GH_TOKEN=${TOKENS[github]}")
  [[ -v TOKENS[gitlab] ]] && env+=("GITLAB_TOKEN=${TOKENS[gitlab]}" "GITLAB_HOST=$gitlab_host")
  echo "printf '%s\n'$(q "${env[@]}") > \"\$h/env\""

  local gc='git config --file "$h/gitconfig"'
  if [[ -n "$(field git user-name)" ]]; then
    echo "$gc user.name$(q "$(field git user-name)")"
    echo "$gc user.email$(q "$(field git user-email)")"
  fi
  if [[ -v TOKENS[github] ]]; then
    echo "$gc credential.https://github.com.helper$(q "$(helper x-access-token GH_TOKEN)")"
    echo "$gc url.https://github.com/.insteadOf git@github.com:"
  fi
  if [[ -v TOKENS[gitlab] ]]; then
    echo "$gc credential.https://$gitlab_host.helper$(q "$(helper oauth2 GITLAB_TOKEN)")"
    echo "$gc url.https://$gitlab_host/.insteadOf git@$gitlab_host:"
    local npmrc=() scope id
    while IFS=$'\t' read -r scope id; do
      [[ "$scope" =~ ^@[a-z0-9._-]+$ && "$id" =~ ^[0-9]+$ ]] || { echo "vm:credentials: invalid gitlab npm registry '$scope': '$id'" >&2; return 1; }
      npmrc+=("$scope:registry=https://$gitlab_host/api/v4/projects/$id/packages/npm/"
              "//$gitlab_host/api/v4/projects/$id/packages/npm/:_authToken=\${GITLAB_TOKEN}")
    done < <(jq -r '.gitlab["npm-registries"] // {} | to_entries[] | [.key, (.value | tostring)] | @tsv' <<< "$decl")
    [[ ${#npmrc[@]} -eq 0 ]] || echo "printf '%s\n'$(q "${npmrc[@]}") > \"\$h/npmrc\""
  fi
  cat <<'EOF'
printf '%s\n' '# Written by the harness (vm:credentials): this boot'\''s credentials, held on tmpfs.' \
  'if [ -r /run/harness/env ]; then set -a; . /run/harness/env; set +a; fi' | sudo tee "$R/etc/profile.d/harness-credentials.sh" >/dev/null
sudo chmod 0644 "$R/etc/profile.d/harness-credentials.sh"
EOF
}

script="$(injection_script)"
printf '%s\n' "$script" | limactl shell "$vm" -- bash -s \
  || { echo "vm:credentials: could not inject $project's credentials into VM '$vm'" >&2; exit 1; }
if [[ -v TOKENS[anthropic] && -v TOKENS[claude] ]]; then echo both; elif [[ -v TOKENS[anthropic] ]]; then echo anthropic; elif [[ -v TOKENS[claude] ]]; then echo claude; fi
