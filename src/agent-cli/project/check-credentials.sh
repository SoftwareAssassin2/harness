#!/usr/bin/env bash
# Description: Check a project's credentials and hold its new work while one is missing or failing — project:check-credentials <project>; prints project:credentials-status's { held, since, problems }.
set -euo pipefail

# ASS-395. Every credential the project is declared to need, checked where it
# can be done cheaply and without a prompt:
#   - each keychain item its ~/.harness/vm-credentials.json entry names
#     (vm-credentials.bash: KINDS, declared_credentials), read by its
#     attributes alone — `security find-generic-password -s <service>`, neither
#     -w nor -g: no secret is read and no access is asked for (read_stamps'
#     read) — so a missing item (security's 44) or one that cannot be read is
#     found; an entry the declaration itself gets wrong is one problem. A
#     project with no entry (or no file) declares none: nothing to check;
#   - the host's forge login for each of project.json's repositories: gh for
#     one on github.com, glab for any other (merge-requests.bash's split),
#     `<tool> auth status --hostname <host>`; skipped with GH_DISABLED=1 /
#     GLAB_DISABLED=1 (code.bash's switches, the tests'); one that does not
#     answer within CREDENTIALS_CHECK_TIMEOUT seconds (default 20) is left
#     unknown, not a problem: an offline Mac holds nothing;
#   - the gcloud and glab logins control already probes for a project with
#     check-for-expired-<tool>-auth (triggers.js loginCheck): its
#     <tool>-requires-reauthentication file reads `true`;
#   - the Claude account: project.json's account-hold (dispatch.js
#     accountHold, from expected-account) is there.
# Each problem is { credential, problem, fix }: which one, what is wrong, and
# the exact command or step that fixes it. With any, the hold is recorded in
# data/projects/<project>/credentials-hold.json — { since, problems }, since
# kept while it stays held, written only when the problems change — and
# control starts no new agent or VM setup of the project until a check finds
# none, when the file is removed (src/control/credentials.js). Prints
# project:credentials-status. PROJECTS_DIR overrides the projects folder.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm-credentials.bash"   # KINDS, declared_credentials
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
projects="${PROJECTS_DIR:-$here/../../../data/projects}"
command=project:check-credentials

[[ $# -eq 1 ]] || { echo "usage: $command <project>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
project="$1" dir="$projects/$1"
[[ -f "$dir/project.json" ]] || { echo "$command: no project $project" >&2; exit 1; }
json="$dir/project.json"
limit="${CREDENTIALS_CHECK_TIMEOUT:-20}"

problems=()
problem() { problems+=("$(jq -cn --arg c "$1" --arg p "$2" --arg f "$3" '{ credential: $c, problem: $p, fix: $f }')"); }
timed() { perl -e 'alarm shift; exec @ARGV' "$limit" "$@"; }

# The keychain items its VM credentials declare.
declared="$HOME/.harness/vm-credentials.json"
if [[ -f "$declared" ]] && ! jq empty "$declared" 2>/dev/null; then
  problem "~/.harness/vm-credentials.json" "is not valid JSON" "correct the file (its shape is in src/agent-cli/vm-credentials.bash)"
elif [[ -f "$declared" ]] && jq -e --arg p "$project" 'has($p)' "$declared" >/dev/null 2>&1; then
  if decl="$(declared_credentials "$command" "$project" 2>&1)"; then
    for kind in "${KINDS[@]}"; do
      service="$(jq -r --arg k "$kind" '.[$k]["keychain-service"] // empty' <<< "$decl")"
      [[ -n "$service" ]] || continue
      save="security add-generic-password -U -s \"$service\" -a \"\$USER\" -T /usr/bin/security -w \"\$(pbpaste)\" (with the $kind token copied)"
      status=0
      timed security find-generic-password -s "$service" >/dev/null 2>&1 || status=$?
      if [[ $status -eq 44 ]]; then problem "keychain item \"$service\" ($kind)" "missing from the keychain" "$save"
      elif [[ $status -eq 142 ]]; then problem "keychain item \"$service\" ($kind)" "no answer within ${limit}s: is the login keychain locked?" "security unlock-keychain"
      elif [[ $status -ne 0 ]]; then problem "keychain item \"$service\" ($kind)" "unreadable (security exited $status)" "security unlock-keychain, or save it again: $save"
      fi
    done
  else
    problem "~/.harness/vm-credentials.json" "${decl#"$command: "}" "correct $project's entry in ~/.harness/vm-credentials.json (its shape is in src/agent-cli/vm-credentials.bash)"
  fi
fi

# The host's forge logins its repositories need, one check per tool and host.
declare -A asked=()
while IFS= read -r url; do
  [[ -n "$url" ]] || continue
  host="$(sed -E 's#^[a-z+]+://##; s#^[^@/]*@##; s#[:/].*$##' <<< "$url")"
  [[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || continue
  if [[ "$host" == github.com ]]; then tool=gh; else tool=glab; fi
  [[ -z "${asked[$tool/$host]:-}" ]] || continue
  asked[$tool/$host]=1
  [[ "$tool" == gh && "${GH_DISABLED:-}" == 1 || "$tool" == glab && "${GLAB_DISABLED:-}" == 1 ]] && continue
  status=0
  timed "$tool" auth status --hostname "$host" >/dev/null 2>&1 || status=$?
  [[ $status -eq 0 || $status -eq 142 ]] && continue   # 142: no answer in time, unknown
  problem "the $tool login ($host)" "$tool is not authenticated on $host" "$tool auth login --hostname $host"
done < <(jq -r '.repositories[]?.url // empty' "$json")

# The logins control probes itself (check-for-expired-<tool>-auth), as last found.
for tool in gcloud glab; do
  jq -e --arg k "check-for-expired-$tool-auth" '.[$k] == true' "$json" >/dev/null || continue
  [[ "$(cat "$dir/$tool-requires-reauthentication" 2>/dev/null)" == true ]] || continue
  printf '%s\n' "${problems[@]}" | jq -e --arg t "$tool" 'select(.credential | startswith("the \($t) login"))' >/dev/null 2>&1 && continue
  problem "the $tool login" "the $tool login has expired" "$tool auth login"
done

# The Claude account its expected-account names.
if hold="$(jq -ce '.["account-hold"] // empty | objects' "$json" 2>/dev/null)"; then
  expected="$(jq -r '.expected // ""' <<< "$hold")" actual="$(jq -r '.actual // ""' <<< "$hold")" config="$(jq -r '.["config-dir"] // ""' <<< "$hold")"
  if [[ -n "$actual" ]]; then actual="logged in as $actual"; else actual="not logged in"; fi
  problem "the Claude account" "$expected expected; $actual" "${config:+CLAUDE_CONFIG_DIR=$config }claude, then /login as $expected"
fi

record="$dir/credentials-hold.json"
list="$(printf '%s\n' "${problems[@]}" | jq -sc '.')"
if [[ "$list" == '[]' ]]; then
  rm -f "$record"
elif ! jq -e --argjson l "$list" '.problems == $l' "$record" >/dev/null 2>&1; then
  update_json --create "$record" --argjson l "$list" '{ since: (.since // (now | floor | todate)), problems: $l }'
fi
exec "$here/credentials-status.sh" "$project"
