# The credentials a project's VMs get (ASS-71), for vm:credentials and vm:scan-image.
# Control reads the declaration itself too (src/control/vm-credentials.js):
# which Claude login kinds a project declares (vm-lifecycle.js), and the
# github or gitlab keychain item whose token it asks the forge which account
# the project pushes as (ASS-307, src/control/push-account.js).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm-credentials.bash"
#   declared_credentials <command> <project>   # the project's object in ~/.harness/vm-credentials.json, as JSON; fails on a bad one
#   read_tokens <command> <project> <json>     # fills TOKENS[kind] and SERVICES[kind] from the keychain; fails naming every bad item at once
#   forge_tokens <command> <url…>              # sets gh_token and gl_token from the Mac's own gh and glab logins, for the forges the URLs are on;
#                                              # fails at once, before reading its token, when that login has expired (gh/glab auth status)
#
# forge_tokens is for the operator's own runs, not an agent's VM: the golden
# image's build (vm:build-golden) and its test run (vm:test-repos). Each token
# goes to the VM over stdin only.
#
# The declaration lives on the Mac, outside the repository and every project
# folder, so nothing mounted into a VM shows which credentials exist:
#
#   ~/.harness/vm-credentials.json
#   { "harness": {
#       "claude":    { "keychain-service": "Claude Token" },
#       "github":    { "keychain-service": "GitHub PAT" },
#       "git":       { "user-name": "Ada Example", "user-email": "ada@example.com" } },
#     "acme-shop": {
#       "gitlab":    { "keychain-service": "GitLab PAT", "host": "gitlab.com",
#                      "npm-registries": { "@acme": "12345678", "@acme-ui": "23456789" } },
#       "atlassian": { "keychain-service": "Atlassian API Key", "site": "example.atlassian.net", "email": "ada@example.com" },
#       … } }
#
# Claude Code authenticates with claude (a subscription token from
# `claude setup-token`, as CLAUDE_CODE_OAUTH_TOKEN) or anthropic (a Console API
# key, as ANTHROPIC_API_KEY: { "keychain-service": "Anthropic API Key" }).
# atlassian is never injected into a VM (ASS-238: Jira work runs on the host);
# declared, vm:scan-image still searches an image for it.
# A project may declare both (ASS-217): its VMs then hold both, and control
# picks one per agent, unsetting the other in its command (dispatch.js). A
# kind left out is not provisioned. The keychain service name alone finds
# the item, so keep one item per service. Save each item so only `security`
# reads it without a prompt (not -A, which lets every app read it); paste the
# token rather than typing it (typed input is cut at 128 characters):
#
#   security add-generic-password -s "<service>" -a "$USER" -T /usr/bin/security -w "$(pbpaste)"
#
# Items are only ever read, with `security find-generic-password -s <service> -w`
# and a VM_KEYCHAIN_TIMEOUT-second limit (default 30); the keychain is never
# unlocked, so a locked one is reported like any other unreadable item. A read
# takes ~7ms on an idle Mac (ASS-123), but under heavy load just starting a
# process took up to ~10s (ASS-109), so 30s leaves room for a loaded Mac while
# a read that never answers (a locked keychain, a prompt nobody sees) still
# fails the step within half a minute.
# Whitespace is stripped from every value. Whether a token still works is not
# checked: an expired one fails the step that uses it.

source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/code.bash"   # glab_authenticated

KINDS=(claude anthropic github gitlab atlassian git)
# The tools each kind needs besides its token.
declare -A NEEDS=([claude]="keychain-service" [anthropic]="keychain-service" [github]="keychain-service" [gitlab]="keychain-service"
                  [atlassian]="keychain-service site email" [git]="user-name user-email")
declare -A TOKENS=() SERVICES=()

declared_credentials() {
  local command="$1" project="$2" file="$HOME/.harness/vm-credentials.json" decl kind field missing
  [[ -f "$file" ]] || { echo "$command: no $file declaring which credentials each project's VMs get" >&2; return 1; }
  decl="$(jq -ce --arg p "$project" '.[$p] // empty | objects' "$file" 2>/dev/null)" \
    || { echo "$command: $file declares no VM credentials for project '$project'" >&2; return 1; }
  for kind in $(jq -r 'keys_unsorted[]' <<< "$decl"); do
    [[ "$kind" =~ ^[a-z]+$ && -v "NEEDS[$kind]" ]] || { echo "$command: $file: unknown credential kind '$kind' for '$project' (known: ${KINDS[*]})" >&2; return 1; }
    missing=()
    for field in ${NEEDS[$kind]}; do
      jq -e --arg k "$kind" --arg f "$field" '.[$k][$f] | strings | length > 0' <<< "$decl" >/dev/null || missing+=("$field")
    done
    [[ ${#missing[@]} -eq 0 ]] || { echo "$command: $file: '$project' $kind needs $(printf '%s, ' "${missing[@]}" | sed 's/, $//')" >&2; return 1; }
  done
  echo "$decl"
}

read_tokens() {
  local command="$1" project="$2" decl="$3" kind service value status problems=() limit="${VM_KEYCHAIN_TIMEOUT:-30}"
  for kind in "${KINDS[@]}"; do
    service="$(jq -r --arg k "$kind" '.[$k]["keychain-service"] // empty' <<< "$decl")"
    [[ -n "$service" ]] || continue
    status=0
    value="$(perl -e 'alarm shift; exec @ARGV' "$limit" security find-generic-password -s "$service" -w 2>/dev/null)" || status=$?
    value="${value//[[:space:]]/}"
    if [[ $status -eq 44 ]]; then problems+=("$kind: \"$service\" is missing")
    elif [[ $status -eq 142 ]]; then problems+=("$kind: \"$service\" is unreadable (no answer within ${limit}s: is the login keychain locked, or was the item saved without -T /usr/bin/security?)")
    elif [[ $status -ne 0 ]]; then problems+=("$kind: \"$service\" is unreadable (security exited $status)")
    elif [[ -z "$value" ]]; then problems+=("$kind: \"$service\" is empty")
    # Tokens go into the VM's env file and the injection script verbatim, so only token characters pass.
    elif [[ ! "$value" =~ ^[A-Za-z0-9._~+/=-]+$ ]]; then problems+=("$kind: \"$service\" is unreadable (it holds characters a token never has)")
    else TOKENS[$kind]="$value"; SERVICES[$kind]="$service"
    fi
  done
  [[ ${#problems[@]} -eq 0 ]] && return 0
  { echo "$command: $project's VM credentials cannot be read from the keychain:"; printf '  %s\n' "${problems[@]}"; } >&2
  return 1
}

forge_tokens() {
  local command="$1" url host; shift
  gh_token="" gl_token=""
  for url in "$@"; do
    if [[ "$url" == https://github.com/* ]]; then
      [[ -n "$gh_token" ]] && continue
      gh auth status >/dev/null 2>&1 || { echo "$command: gh is not authenticated" >&2; return 1; }
      gh_token="$(gh auth token)" || { echo "$command: cannot read a GitHub token (gh auth token) for $url" >&2; return 1; }
    else
      [[ -n "$gl_token" ]] && continue
      # glab's OAuth token expires within hours and only an API call refreshes it: auth status makes one,
      # asked afresh each time (vm:test-repos asks again for each test), not the pass code.bash remembers.
      unset glab_authenticated_already
      glab_authenticated "$command" || return 1
      host="$(cut -d/ -f3 <<<"$url")"
      gl_token="$(glab config get token --host "$host")" || { echo "$command: cannot read a GitLab token (glab config get token) for $url" >&2; return 1; }
    fi
  done
}
