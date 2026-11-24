# git against a project's forge from the Mac, with the forge credential the
# harness holds for that project (ASS-583): for substrate/relay.bash (each
# ls-remote, fetch, push and clone that moves a ticket's branches through the
# Mac) and code:hand-over (its forge checks, and its pushes and fetches from a
# Mac checkout).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../forge-git.bash"
#   forge_git <project> <url> <git args…>   # git <args> with <url>'s declared credential, if any; stderr kept to itself:
#                                           # on failure one line, "<command>: <repo> (<url>): <reason>", then git's status
#   forge_reason <git's stderr>             # "authentication failed (…)", "forge unreachable (…)", or git's first line
#
# Why: the Mac's own git has no HTTPS login for a private forge reached over
# https (a private GitLab: "could not read Username for 'https://gitlab.com':
# Device not configured"), and the relay and hand-over ran `git ls-remote …
# 2>/dev/null`, so an authentication failure read as "no branches" and moved
# nothing, silently (ASS-577's missing-VM fallback then reported all the work
# lost when nothing had been checked).
#
# The credential is the keychain item ~/.harness/vm-credentials.json declares
# for the project (vm-credentials.bash: `gitlab`, on its `host`, gitlab.com
# when none; `github`, on github.com or its `host`): the token its VMs and
# Substrate's egress gateway get. It is given to the one git call only, as a
# credential helper on git's command line (-c) that reads the keychain when
# git asks for it, the item's service name in that call's environment
# (HARNESS_FORGE_KEYCHAIN_SERVICE) — so the token is never in a git config, a
# URL, a file, an argv or a log: `security` hands it to the helper on a pipe,
# and the helper to git on its stdin. The helper list is emptied first (an
# empty credential.helper), so the Mac's own helpers (osxkeychain) neither
# answer for it nor store the token after it worked. Username: oauth2 on
# GitLab, x-access-token on GitHub (as vm:credentials' gitconfig).
#
# Without a declared credential for the url's host (a local-path origin, ssh,
# another forge, a project that declares none), git runs as it always did, with
# whatever logins the Mac has. Either way git never prompts
# (GIT_TERMINAL_PROMPT=0): a control child has no terminal, and an operator's
# run fails as control's would rather than waiting on a prompt.
# VM_CREDENTIALS_FILE names another declaration file (tests), as
# vm-credentials.bash; VM_KEYCHAIN_TIMEOUT bounds the keychain read (30 s).

# The helper git runs (through sh) for `get`: the token read from the keychain at that moment; nothing for store/erase.
# shellcheck disable=SC2016
forge_git_helper='!f() { cat >/dev/null; [ "$1" = get ] || return 0
  t="$(perl -e "alarm shift; exec @ARGV" "${VM_KEYCHAIN_TIMEOUT:-30}" security find-generic-password -s "$HARNESS_FORGE_KEYCHAIN_SERVICE" -w 2>/dev/null | tr -d "[:space:]")"
  [ -n "$t" ] || { echo "the keychain item \"$HARNESS_FORGE_KEYCHAIN_SERVICE\" could not be read" >&2; return 0; }
  printf "username=%s\npassword=%s\n" "$HARNESS_FORGE_USER" "$t"; }; f'

# forge_credential <project> <url> — "<keychain service>\t<username>" of the credential declared for <url>'s host; nothing
# when none is (or the url is not https).
forge_credential() {
  local file="${VM_CREDENTIALS_FILE:-$HOME/.harness/vm-credentials.json}" host
  [[ "$2" =~ ^https://([^/@]+)(/|$) ]] || return 0
  host="${BASH_REMATCH[1],,}"
  [[ -f "$file" ]] || return 0
  jq -r --arg p "$1" --arg h "$host" '
    (.[$p] // {}) | objects
    | [ (.gitlab | objects | select(((.host // "gitlab.com") | ascii_downcase) == $h) | [.["keychain-service"], "oauth2"]),
        (.github | objects | select(((.host // "github.com") | ascii_downcase) == $h) | [.["keychain-service"], "x-access-token"]) ]
    | map(select(.[0] | strings | length > 0)) | first // empty | @tsv' "$file" 2>/dev/null || true
}

# forge_reason <stderr> — what went wrong, in words control's log and the ticket's feedback can carry.
forge_reason() {
  local first
  first="$(grep -v '^[[:space:]]*$' <<< "$1" | grep -m 1 -iE 'fatal|error|denied|could not|unable|not found|refused|timed out' || grep -m 1 . <<< "$1" || true)"
  first="${first#"${first%%[![:space:]]*}"}"
  if grep -qiE 'authentication failed|could not read (username|password)|terminal prompts disabled|access denied|invalid (username|credentials)|returned error: 40[13]|HTTP 40[13]|requested URL returned error: 40[13]|you don.t have permission|repository not found|could not be read' <<< "$1"; then
    echo "authentication failed${first:+ ($first)}"
  elif grep -qiE 'could not resolve host|failed to connect|connection (refused|timed out)|operation timed out|network is unreachable|couldn.t connect' <<< "$1"; then
    echo "forge unreachable${first:+ ($first)}"
  else echo "${first:-git failed with no message}"; fi
}

forge_git() {
  local project="$1" url="$2" cred service user err status=0 name
  shift 2
  cred="$(forge_credential "$project" "$url")"
  err="$(mktemp)"
  if [[ -n "$cred" ]]; then
    IFS=$'\t' read -r service user <<< "$cred"
    HARNESS_FORGE_KEYCHAIN_SERVICE="$service" HARNESS_FORGE_USER="$user" GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="" SSH_ASKPASS="" \
      git -c credential.helper= -c "credential.helper=$forge_git_helper" "$@" 2>"$err" || status=$?
  else
    GIT_TERMINAL_PROMPT=0 git "$@" 2>"$err" || status=$?
  fi
  if [[ $status -ne 0 ]]; then
    name="$(basename "${url%.git}")"
    echo "${command:-forge}: $name ($url): $(forge_reason "$(cat "$err")")" >&2
  fi
  rm -f "$err"
  return $status
}
