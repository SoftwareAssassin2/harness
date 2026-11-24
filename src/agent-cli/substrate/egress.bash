# A project's sandbox egress and credentials (ASS-538), for substrate:credentials and substrate:sandbox-up. The
# design — the allowlist, which header each credential replaces where, the Secrets, the placeholders — is
# src/substrate/egress.js's; agent-cli/substrate-egress.js prints it for bash.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/egress.bash"
#   egress_decl <command> <project>          # its ~/.harness/vm-credentials.json entry as JSON (keychain service names
#                                            # and settings, never a token), `null` when it declares none; fails on a
#                                            # wrong one (vm-credentials.bash declared_credentials)
#   egress_info <command> <project> <decl>   # { policy, hash, namespace, kinds, secrets, allow } (substrate-egress.js)
#   egress_placeholders <command> <project> <decl>   # the script that writes the sandbox's placeholders, as root
#   egress_synced <project> <machine> <hash> # the cluster's credentials were synced, and with this policy (its
#                                            # substrate.json entry's credentials: ok, policy-hash)
here_egress="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here_egress/../vm-credentials.bash"   # declared_credentials, read_tokens, read_stamps
egress_node="$here_egress/../substrate-egress.js"
egress_projects="${PROJECTS_DIR:-$here_egress/../../../data/projects}"
EGRESS_KINDS=(claude anthropic gitlab github)

egress_decl() {
  local command="$1" project="$2" file="${VM_CREDENTIALS_FILE:-$HOME/.harness/vm-credentials.json}"
  if [[ -f "$file" ]] && jq -e --arg p "$project" 'has($p)' "$file" >/dev/null 2>&1; then
    declared_credentials "$command" "$project" | jq -c 'del(.atlassian)'
  elif [[ -f "$file" ]] && ! jq empty "$file" 2>/dev/null; then
    echo "$command: $file is not valid JSON" >&2; return 1
  else echo null; fi
}

egress_info() { printf '%s' "$3" | node "$egress_node" "$egress_projects" "$2" policy || { echo "$1: $2's sandbox egress could not be worked out (above)" >&2; return 1; }; }
egress_placeholders() { printf '%s' "$3" | node "$egress_node" "$egress_projects" "$2" placeholders || { echo "$1: $2's sandbox placeholders could not be worked out (above)" >&2; return 1; }; }

egress_synced() {
  jq -e --arg m "$2" --arg h "$3" '.[$m].credentials | (.ok == true and .["policy-hash"] == $h)' "$egress_projects/$1/substrate.json" >/dev/null 2>&1
}
