#!/usr/bin/env bash
# Description: Save a project's Atlassian API token to the keychain and log acli in with it — project:set-atlassian-token <project> [--stdin]; the token is read from the clipboard (or stdin) and never printed.
set -euo pipefail

# ASS-561. The one command the dashboard's Atlassian chip (frame.js
# headerWarnings) and project:check-credentials' atlassian problems name.
#   1. The keychain item: the one the project's `atlassian` entry in
#      ~/.harness/vm-credentials.json names ({ keychain-service, site, email },
#      vm-credentials.bash). With no such entry it says what to add and fails.
#   2. The token: the clipboard (pbpaste), or stdin with --stdin; whitespace
#      stripped, refused (unprinted) unless it is token characters alone.
#   3. Saved with `security -i`, the add-generic-password command on its stdin,
#      so the token is never on a command line (ps shows none): -U replaces an
#      item already there, -T /usr/bin/security lets only `security` read it
#      without a prompt. Read back to check it was saved.
#   4. The clipboard cleared (pbcopy < /dev/null), when it came from there.
#   5. `acli jira auth login --site <site> --email <email> --token`, the token
#      on its stdin; what acli says is printed with the token masked.
#   6. project:check-credentials run again, so the chip clears now rather than
#      at control's next check.
# The downloader's analytics read the token from that item (cycle.js
# analyticsAuth). Never prints the token. PROJECTS_DIR overrides the projects
# folder; VM_KEYCHAIN_TIMEOUT (default 30) limits each keychain call.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm-credentials.bash"   # declared_credentials
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"
command=project:set-atlassian-token

from=clipboard
[[ $# -eq 2 && "$2" == --stdin ]] && { from=stdin; set -- "$1"; }
[[ $# -eq 1 ]] || { echo "usage: $command <project> [--stdin]" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
project="$1" json="$projects/$1/project.json"
[[ -f "$json" ]] || { echo "$command: no project $project" >&2; exit 1; }
limit="${VM_KEYCHAIN_TIMEOUT:-30}"
timed() { perl -e 'alarm shift; exec @ARGV' "$limit" "$@"; }

# 1. Where it goes.
ws_site="$(jq -r '[."work-sources"[]? | select(.type == "jira")][0].url // ""' "$json" | sed -E 's#^[a-z]+://##; s#[/?#].*$##')"
add_entry() {
  echo "$command: add an atlassian entry for $project to ~/.harness/vm-credentials.json, then run this again:" >&2
  echo "  \"$project\": { …, \"atlassian\": { \"keychain-service\": \"Atlassian API Token ($project)\", \"site\": \"${ws_site:-<site>.atlassian.net}\", \"email\": \"<your Atlassian account's email>\" } }" >&2
  exit 1
}
file="${VM_CREDENTIALS_FILE:-$HOME/.harness/vm-credentials.json}"
[[ -f "$file" ]] && jq -e --arg p "$project" '.[$p].atlassian | objects' "$file" >/dev/null 2>&1 || add_entry
decl="$(declared_credentials "$command" "$project")" || exit 1
service="$(jq -r '.atlassian["keychain-service"]' <<< "$decl")"
email="$(jq -r '.atlassian.email' <<< "$decl")"
site="$(jq -r '.atlassian.site' <<< "$decl" | sed -E 's#^[a-z]+://##; s#[/?#].*$##')"
[[ "$service" != *[\"\\]* ]] || { echo "$command: the keychain-service name may not hold \" or \\" >&2; exit 1; }
[[ "$email" =~ ^[^[:space:]\"\\]+$ && "$site" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "$command: $project's atlassian entry needs a plain email and site" >&2; exit 1; }

# 2. The token.
if [[ "$from" == stdin ]]; then
  token="$(cat)"
else
  command -v pbpaste >/dev/null || { echo "$command: no pbpaste: pipe the token in with --stdin" >&2; exit 1; }
  token="$(pbpaste)"
fi
token="${token//[[:space:]]/}"
[[ -n "$token" ]] || { echo "$command: the $from is empty: copy the Atlassian API token (id.atlassian.com, Security, API tokens) first" >&2; exit 1; }
[[ "$token" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || { echo "$command: what the $from holds is not an API token (it has characters a token never has); nothing saved" >&2; exit 1; }

# 3. The keychain item, the token on security's stdin only.
printf 'add-generic-password -U -s "%s" -a "%s" -T /usr/bin/security -w "%s"\n' "$service" "$USER" "$token" | timed security -i >/dev/null 2>&1 || true
saved="$(timed security find-generic-password -s "$service" -w 2>/dev/null)" || saved=""
if [[ "${saved//[[:space:]]/}" != "$token" ]]; then
  unset saved token
  echo "$command: the token could not be saved as keychain item \"$service\" (is the login keychain locked? security unlock-keychain)" >&2
  exit 1
fi
unset saved
echo "$project: saved the Atlassian API token as keychain item \"$service\""

# 4. The clipboard.
if [[ "$from" == clipboard ]]; then
  pbcopy < /dev/null && echo "$project: cleared the clipboard"
fi

# 5. acli, the token on its stdin.
status=0
said="$(printf '%s' "$token" | acli jira auth login --site "$site" --email "$email" --token 2>&1)" || status=$?
said="${said//"$token"/<token>}"
unset token
if [[ $status -ne 0 ]]; then
  echo "$command: acli could not log in to $site as $email (exit $status); the keychain item is saved:" >&2
  [[ -z "$said" ]] || sed 's/^/  /' <<< "$said" >&2
  exit 1
fi
echo "$project: acli logged in to $site as $email"

# 6. The check again, so the dashboard's chip clears now.
"$here/check-credentials.sh" "$project" >/dev/null 2>&1 || echo "$project: project:check-credentials could not run; control's next check clears the dashboard's chip" >&2
