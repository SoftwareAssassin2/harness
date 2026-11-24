#!/usr/bin/env bash
# Description: Sync a project's credentials from the Mac's keychain into its Substrate cluster's egress gateway — a Kubernetes Secret per declared claude, anthropic, gitlab and github item, the credential provider's namespace policy, each sandbox's egress policy (its host allowlist) — so sandboxes hold no token — substrate:credentials <project> [<machine>]; prints JSON, never a token.
set -euo pipefail

# ASS-538 AC1, AC2 (src/substrate/egress.js says the design). For the project's cluster on <machine> (mac by
# default; a remote one only while its connection is open: exit 3 otherwise, as substrate:health):
#  1. The keychain items ~/.harness/vm-credentials.json declares for the kinds that go through the gateway (claude,
#     anthropic, gitlab, github — the same items vm:credentials gives a VM; atlassian never, git is no secret), their
#     modification times first (vm-credentials.bash read_stamps: attributes only, never a value; read before the
#     tokens, so an item saved between the two reads costs one sync more, never one missed), then their values
#     (read_tokens: a missing, empty or unreadable item fails here, naming it, before anything is sent).
#  2. A Secret per kind, harness-credential-<kind> in the project's namespace (harness-<project>), labelled
#     harness.dev/credential: claude's `token`, anthropic's `key`, gitlab's and github's `token` and `basic` — the
#     Basic value git sends, base64("<user>:<token>") pre-encoded (oauth2 for GitLab, x-access-token for GitHub), as
#     the gateway prefixes and never encodes (ASS-532). Built in memory and sent to the cluster's machine on stdin
#     (over its SSH connection for a remote one), never on a command line or into a file, and applied there
#     (on-machine/substrate.sh credentials-apply), which also deletes the Secret of a kind no longer declared, grants
#     the project's atespace its own namespace in the credential provider's namespace policy (restarting the
#     provider when that changes: it reads the policy only at start), and brings each of the project's sandboxes'
#     egress policy up to date (its allowlist: egress.js allowlist).
#  3. Recorded as the machine's entry's `credentials` in data/projects/<project>/substrate.json — { ok, at, stamps,
#     kinds, secrets, policy-hash, sandboxes } or { ok: false, at, why } — which control compares with the keychain
#     (src/control/substrate.js: a re-saved item, a changed allowlist or declaration syncs again, within the 5
#     minutes a VM gets a rotated key in) and project:credentials-status reports.
# The provider caches a Secret for at most 10 s, so a rotated token reaches the next request within that, with no
# sandbox restarted (ASS-532). Prints { ok, did, failed, secrets, sandboxes, kinds, policy-hash }.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../substrate.bash"
source "$here/egress.bash"

command=substrate:credentials
[[ $# -eq 1 || $# -eq 2 ]] || { echo "usage: $command <project> [<machine>]" >&2; exit 1; }
project="$1" machine="${2:-mac}"
entry="$(substrate_entry "$command" "$project" "$machine")"
[[ "$(substrate_host "$entry")" != gke ]] || { echo "$command: $project's $machine entry is GKE, which the harness never sets up" >&2; exit 2; }
substrate_connected "$project" "$machine" "$entry" || { echo "$command: $project's $machine has no open connection" >&2; exit 3; }

failed() {
  substrate_record "$project" "$machine" --arg why "$1" '.credentials = { ok: false, at: $at, why: $why }'
  echo "$command: $1" >&2; exit 1
}

decl="$(egress_decl "$command" "$project")" || failed "$project's ~/.harness/vm-credentials.json entry cannot be read"
info="$(egress_info "$command" "$project" "$decl")" || failed "$project's sandbox egress could not be worked out"
kinds=() ; while IFS= read -r k; do [[ -n "$k" ]] && kinds+=("$k"); done < <(jq -r '.kinds[]' <<< "$info")
injected='{}'
[[ "$decl" == null ]] || injected="$(jq -c --args 'with_entries(select(.key as $k | $ARGS.positional | index($k)))' "${kinds[@]+"${kinds[@]}"}" <<< "$decl")"
stamps="$(read_stamps "$injected")"
read_tokens "$command" "$project" "$injected" || failed "$project's credentials could not be read from the keychain (the item each names, above)"

# secret <kind> — the kind's Secret manifest, one JSON line; its token reaches jq on stdin only.
secret() {
  local kind="$1" name user basic
  name="$(jq -r --arg k "$kind" '.secrets[$k].name' <<< "$info")" user="$(jq -r --arg k "$kind" '.secrets[$k].user // empty' <<< "$info")"
  if [[ -n "$user" ]]; then
    basic="$(printf '%s:%s' "$user" "${TOKENS[$kind]}" | base64 | tr -d '\n')"
    printf '%s\n%s' "${TOKENS[$kind]}" "$basic" | jq -Rsc --arg n "$name" --arg k "$kind" \
      'split("\n") as [$t, $b] | { apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: { name: $n, labels: { "harness.dev/credential": $k } }, stringData: { token: $t, basic: $b } }'
  else
    local key; key="$(jq -r --arg k "$kind" '.secrets[$k].keys[0]' <<< "$info")"
    printf '%s' "${TOKENS[$kind]}" | jq -Rsc --arg n "$name" --arg k "$kind" --arg key "$key" \
      '{ apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: { name: $n, labels: { "harness.dev/credential": $k } }, stringData: { ($key): . } }'
  fi
}
manifests=()
for kind in "${kinds[@]+"${kinds[@]}"}"; do manifests+=("$(secret "$kind")"); done
unset TOKENS basic

substrate_lock "$command" "$project" "$machine" "$entry"
rc=0
out="$({ printf '{"secrets":['; (IFS=,; printf '%s' "${manifests[*]+"${manifests[*]}"}"); printf '],"policy":%s}' "$(jq -c .policy <<< "$info")"; } \
  | substrate_on "$project" "$machine" "$entry" credentials-apply 7>&-)" || rc=$?
unset manifests
exec 7>&-
result="$(tail -n 1 <<< "$out")"
jq -e 'type == "object" and has("ok")' <<< "$result" >/dev/null 2>&1 || result="$(jq -cn --arg why "credentials-apply exited $rc and printed nothing" '{ ok: false, did: [], failed: [{ what: "credentials", why: $why }] }')"
if [[ "$(jq -r .ok <<< "$result")" == true ]]; then
  substrate_record "$project" "$machine" --argjson s "$stamps" --argjson r "$result" --argjson i "$info" \
    '.credentials = { ok: true, at: $at, stamps: $s, kinds: $i.kinds, secrets: $r.secrets, "policy-hash": $i.hash, sandboxes: $r.sandboxes }'
else
  substrate_record "$project" "$machine" --argjson r "$result" '.credentials = { ok: false, at: $at, why: ($r.failed | map("\(.what): \(.why)") | join("; ")) }'
fi
jq -c --argjson i "$info" '. + { kinds: $i.kinds, "policy-hash": $i.hash }' <<< "$result"
[[ "$(jq -r .ok <<< "$result")" == true ]]
