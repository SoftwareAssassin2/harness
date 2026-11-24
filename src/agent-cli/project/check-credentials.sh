#!/usr/bin/env bash
# Description: Check a project's credentials and hold its new work while one is missing or failing — project:check-credentials <project>; prints project:credentials-status's { held, since, problems[, atlassian][, substrate] }.
set -euo pipefail

# ASS-395. Every credential the project is declared to need, checked where it
# can be done cheaply and without a prompt:
#   - each keychain item its ~/.harness/vm-credentials.json entry names
#     (vm-credentials.bash: KINDS, declared_credentials), read by its
#     attributes alone — `security find-generic-password -s <service>`, neither
#     -w nor -g: no secret is read and no access is asked for (read_stamps'
#     read) — so a missing item (security's 44) or one that cannot be read is
#     found; an entry the declaration itself gets wrong is one problem. A
#     project with no entry (or no file) declares none: nothing to check.
#     Its atlassian item holds nothing: ASS-561 checks it apart (below);
#   - the host's forge login for each of project.json's repositories: gh for
#     one on github.com, glab for any other (merge-requests.bash's split),
#     `<tool> auth status --hostname <host>`; skipped with GH_DISABLED=1 /
#     GLAB_DISABLED=1 (code.bash's switches, the tests'); one that does not
#     answer within CREDENTIALS_CHECK_TIMEOUT seconds (default 20) is left
#     unknown, not a problem: an offline Mac holds nothing. Nor does one
#     that fails at once only because the host could not be reached (ASS-429:
#     glab and gh print Go's network errors — no such host, dial tcp,
#     connection refused or reset, a timeout, a 502/503/504 — and exit 1, as
#     control's probe reads them, src/control/login.js), unless it also says
#     the login is gone (401, unauthorized, invalid token, not logged in);
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
# A forge login check's output: the host could not be reached (NETWORK), or
# the login is gone (LOST), as src/control/login.js's glab patterns (ASS-429).
NETWORK='no such host|dial tcp|connection refused|connection reset|network is unreachable|i/o timeout|timeout|timed out|(^|[^0-9])50[234]([^0-9]|$)|bad gateway|service unavailable|gateway time-?out'
LOST='(^|[^0-9])401([^0-9]|$)|unauthori[sz]ed|invalid[_ ]token|token (has )?(expired|been revoked|was revoked)|not (been )?authenticated|have been authenticated|not logged in|no token'

# The keychain items its VM credentials declare (atlassian's apart, below: ASS-561).
declared="$HOME/.harness/vm-credentials.json" declared_ok=1 atlassian_service=""
if [[ -f "$declared" ]] && ! jq empty "$declared" 2>/dev/null; then
  declared_ok=0
  problem "~/.harness/vm-credentials.json" "is not valid JSON" "correct the file (its shape is in src/agent-cli/vm-credentials.bash)"
elif [[ -f "$declared" ]] && jq -e --arg p "$project" 'has($p)' "$declared" >/dev/null 2>&1; then
  if decl="$(declared_credentials "$command" "$project" 2>&1)"; then
    for kind in "${KINDS[@]}"; do
      service="$(jq -r --arg k "$kind" '.[$k]["keychain-service"] // empty' <<< "$decl")"
      [[ -n "$service" ]] || continue
      [[ "$kind" == atlassian ]] && { atlassian_service="$service"; continue; }   # ASS-561: checked below, holding nothing
      save="security add-generic-password -U -s \"$service\" -a \"\$USER\" -T /usr/bin/security -w \"\$(pbpaste)\" (with the $kind token copied)"
      status=0
      timed security find-generic-password -s "$service" >/dev/null 2>&1 || status=$?
      if [[ $status -eq 44 ]]; then problem "keychain item \"$service\" ($kind)" "missing from the keychain" "$save"
      elif [[ $status -eq 142 ]]; then problem "keychain item \"$service\" ($kind)" "no answer within ${limit}s: is the login keychain locked?" "security unlock-keychain"
      elif [[ $status -ne 0 ]]; then problem "keychain item \"$service\" ($kind)" "unreadable (security exited $status)" "security unlock-keychain, or save it again: $save"
      fi
    done
  else
    declared_ok=0
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
  said="$(timed "$tool" auth status --hostname "$host" 2>&1)" || status=$?
  [[ $status -eq 0 || $status -eq 142 ]] && continue   # 142: no answer in time, unknown
  if grep -Eqi "$NETWORK" <<< "$said" && ! grep -Eqi "$LOST" <<< "$said"; then continue; fi   # ASS-429: unreachable, unknown
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

# ASS-533: what the project's Substrate clusters (dev-environments.substrate) need, checked alike but holding nothing —
# a cluster's trouble must not stop the project's VM work — and kept apart in substrate-needs.json ({ checked-at,
# problems }; removed for a project with no cluster), which credentials-status prints as `substrate`:
#   - the Mac's cluster: Docker answering on the Mac (Docker Desktop running), and the kit buildable — built already
#     (~/.harness/substrate/build/<release>/), or go, git and curl there to build it;
#   - a workstation's or cloud VM's: the gcloud login that reaches it (its live data's last connect not failing as
#     expired: CLOUDSDK_CONFIG=<its gcloud-config> gcloud auth login);
#   - a GKE entry: refused until the operator approves GKE (substrate-config.js GKE_REFUSED).
# Substrate's images are public (ghcr.io, Docker Hub): no registry login is needed.
# ASS-538 AC4: and, for each kind cluster, its egress gateway's credentials (src/substrate/egress.js) as the
# cluster's last substrate:health and substrate:credentials recorded them (substrate.json: its egress and
# credentials) — nothing asked of the cluster here: the credential provider's pod ready (else substrate:up with
# repair), its namespace policy granting the project's atespace its own namespace, and a Secret
# (harness-credential-<kind>) for each claude, anthropic, gitlab or github item the project declares (else
# substrate:credentials), the last sync not failed.
sub_problems=()
sub_problem() { sub_problems+=("$(jq -cn --arg m "$1" --arg c "$2" --arg p "$3" --arg f "$4" '{ machine: $m, credential: $c, problem: $p, fix: $f }')"); }
if sub_entries="$(node "$here/../substrate.js" "$projects" "$project" 2>/dev/null)" && [[ -n "$sub_entries" ]]; then
  sub_release="$(sed -n 's/^SUBSTRATE_RELEASE=//p' "$here/../substrate.bash")"
  want_kinds=()
  if [[ -n "${decl:-}" ]]; then while IFS= read -r k; do [[ -n "$k" ]] && want_kinds+=("$k"); done < <(jq -r '["claude", "anthropic", "gitlab", "github"][] as $k | select(.[$k]["keychain-service"]) | $k' <<< "$decl" 2>/dev/null); fi
  while IFS= read -r e; do
    m="$(jq -r .machine <<< "$e")" host="$(jq -r .host <<< "$e")"
    case "$host" in
      mac)
        status=0; timed docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || status=$?
        [[ $status -eq 0 || $status -eq 142 ]] || sub_problem "$m" "Docker on the Mac" "docker info failed: Docker Desktop is not running" "open -a Docker"
        if ! compgen -G "${HARNESS_SUBSTRATE_DIR:-$HOME/.harness/substrate}/build/$sub_release/darwin-*.tar.gz" >/dev/null; then
          for t in go git curl; do command -v "$t" >/dev/null || sub_problem "$m" "the Substrate kit" "not built yet, and building it needs $t on the Mac" "brew install $t, then ./agent.sh substrate:kit"; done
        fi ;;
      gke) sub_problem "$m" "GKE" "$(jq -r .refused <<< "$e")" "approve a GKE trial (docs/spikes/ASS-532-substrate.md section 7), or remove the gke entry" ;;
      *)
        if [[ "$(jq -r --arg m "$m" '.[$m]["last-error"].kind // empty' "$dir/workstations.json" 2>/dev/null)" == expired ]]; then
          cfg="$(jq -r --arg m "$m" '(."dev-environments".workstations // []) + (."dev-environments"."cloud-vms" // []) | map(select(.id == $m))[0]["gcloud-config"] // empty' "$json")"
          sub_problem "$m" "the gcloud login that reaches $m" "expired: its cluster can be neither checked nor set up" "${cfg:+CLOUDSDK_CONFIG=$cfg }gcloud auth login"
        fi ;;
    esac
    [[ "$host" != gke ]] || continue
    rec="$(jq -c --arg m "$m" '.[$m] // {}' "$dir/substrate.json" 2>/dev/null || echo '{}')"
    sync="./agent.sh substrate:credentials $project $m"
    if jq -e '.credentials.ok == false' <<< "$rec" >/dev/null; then
      sub_problem "$m" "the egress gateway's credentials" "the last sync failed: $(jq -r '.credentials.why // "unknown"' <<< "$rec")" "$sync"
    fi
    if jq -e '.egress | objects' <<< "$rec" >/dev/null; then
      jq -e '.egress.provider.ready == true' <<< "$rec" >/dev/null \
        || sub_problem "$m" "the egress gateway's credential provider" "not ready: $(jq -r '.egress.provider.why // "unknown"' <<< "$rec")" "HARNESS_SUBSTRATE_REPAIR=1 ./agent.sh substrate:up $project $m"
      if [[ ${#want_kinds[@]} -gt 0 ]]; then
        jq -e '.egress.policy.granted == true' <<< "$rec" >/dev/null \
          || sub_problem "$m" "the credential provider's namespace policy" "does not grant the atespace $(jq -r '.egress.policy.atespace // "?"' <<< "$rec") its own namespace's Secrets" "$sync"
        for k in "${want_kinds[@]}"; do
          jq -e --arg n "harness-credential-$k" '(.egress.secrets // []) | index($n)' <<< "$rec" >/dev/null \
            || sub_problem "$m" "Secret harness-credential-$k ($k)" "missing from the cluster: the gateway cannot inject $project's $k credential" "$sync"
        done
      fi
    fi
  done <<< "$sub_entries"
  printf '%s\n' "${sub_problems[@]+"${sub_problems[@]}"}" | jq -sc '[.[] | select(. != null)]' | jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{ "checked-at": $at, problems: . }' | replace_file "$dir/substrate-needs.json"
else
  rm -f "$dir/substrate-needs.json"
fi

# ASS-561: for a project with a jira work source, the Atlassian API token the downloader's analytics sign in with and
# the acli login its ticket sync (and ticket:set-ticket-system-status, ticket:raise-bug) runs under — checked alike but
# holding nothing (analytics and the Jira sync are degraded, agent work goes on), and kept apart in atlassian-needs.json
# ({ since, problems }, since kept while there are any, written only when they change; removed when there are none),
# which credentials-status prints as `atlassian` and the dashboard shows as a chip (frame.js headerWarnings):
#   - the keychain item its vm-credentials.json `atlassian` entry names, read by its attributes alone, as above; with
#     no such entry (and a declaration that is not itself wrong, a problem above), project.json's jira work source's
#     api-email and api-token (the analytics' fallback, cycle.js analyticsAuth), a problem only when both are missing;
#   - `acli jira auth status`: logged in, and to the work source's site. A check that does not answer in time, or fails
#     only because the site could not be reached (ASS-429's NETWORK without LOST), is unknown, not a problem.
# Each fix is project:set-atlassian-token, which saves the token and logs acli in. ACLI_DISABLED=1 skips acli.
atl_problems=()
atl_problem() { atl_problems+=("$(jq -cn --arg c "$1" --arg p "$2" --arg f "./agent.sh project:set-atlassian-token $project" '{ credential: $c, problem: $p, fix: $f }')"); }
if jira_source="$(jq -ce '[."work-sources"[]? | select(.type == "jira")][0] // empty' "$json" 2>/dev/null)"; then
  site="$(jq -r '.url // ""' <<< "$jira_source" | sed -E 's#^[a-z]+://##; s#[/?#].*$##')"
  if [[ -n "$atlassian_service" ]]; then
    status=0
    timed security find-generic-password -s "$atlassian_service" >/dev/null 2>&1 || status=$?
    if [[ $status -eq 44 ]]; then atl_problem "keychain item \"$atlassian_service\" (atlassian)" "missing from the keychain: the analytics cannot sign in to Jira"
    elif [[ $status -eq 142 ]]; then atl_problem "keychain item \"$atlassian_service\" (atlassian)" "no answer within ${limit}s: is the login keychain locked?"
    elif [[ $status -ne 0 ]]; then atl_problem "keychain item \"$atlassian_service\" (atlassian)" "unreadable (security exited $status)"
    fi
  elif [[ $declared_ok -eq 1 ]] && ! jq -e '(."api-email" | strings | length > 0) and (."api-token" | strings | length > 0)' <<< "$jira_source" >/dev/null; then
    atl_problem "the Atlassian API token" "none: no atlassian entry for $project in ~/.harness/vm-credentials.json, nor an api-email and api-token in project.json's jira work source"
  fi
  if [[ "${ACLI_DISABLED:-}" != 1 ]]; then
    if ! command -v acli >/dev/null; then
      atl_problem "the acli login${site:+ ($site)}" "acli is not installed (brew install acli first)"
    else
      status=0
      said="$(timed acli jira auth status 2>&1)" || status=$?
      if [[ $status -eq 142 ]]; then :   # no answer in time: unknown
      elif grep -Eqi "$NETWORK" <<< "$said" && ! grep -Eqi "$LOST" <<< "$said"; then :   # ASS-429: unreachable, unknown
      elif [[ $status -ne 0 ]] || grep -Eqi "$LOST|unauthenticated" <<< "$said"; then
        atl_problem "the acli login${site:+ ($site)}" "acli is not logged in to Jira"
      elif [[ -n "$site" ]]; then
        on="$(sed -nE 's/^[[:space:]]*Site:[[:space:]]*([^[:space:]]+).*/\1/p' <<< "$said" | head -n 1 | sed -E 's#^[a-z]+://##; s#/.*$##')"
        [[ -z "$on" ]] || [[ "$(tr 'A-Z' 'a-z' <<< "$on")" == "$(tr 'A-Z' 'a-z' <<< "$site")" ]] \
          || atl_problem "the acli login ($site)" "acli is logged in to $on, not $site"
      fi
    fi
  fi
fi
atl_record="$dir/atlassian-needs.json"
atl_list="$(printf '%s\n' "${atl_problems[@]+"${atl_problems[@]}"}" | jq -sc '[.[] | select(. != null)]')"
if [[ "$atl_list" == '[]' ]]; then
  rm -f "$atl_record"
elif ! jq -e --argjson l "$atl_list" '.problems == $l' "$atl_record" >/dev/null 2>&1; then
  update_json --create "$atl_record" --argjson l "$atl_list" '{ since: (.since // (now | floor | todate)), problems: $l }'
fi

record="$dir/credentials-hold.json"
list="$(printf '%s\n' "${problems[@]}" | jq -sc '.')"
if [[ "$list" == '[]' ]]; then
  rm -f "$record"
elif ! jq -e --argjson l "$list" '.problems == $l' "$record" >/dev/null 2>&1; then
  update_json --create "$record" --argjson l "$list" '{ since: (.since // (now | floor | todate)), problems: $l }'
fi
exec "$here/credentials-status.sh" "$project"
