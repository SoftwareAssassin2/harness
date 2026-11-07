#!/usr/bin/env bash
# Description: List the available CLI commands and their descriptions.
set -euo pipefail

# Commands are *.sh files in the CLI directory (override with AGENT_CLI_DIR,
# used by tests); a subfolder groups a "family" of commands invoked as
# `family:command`. This script lives among the commands, so it discovers them
# from its own location.
CLI_DIR="${AGENT_CLI_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")}"

# describe <file> — print the `# Description:` comment text, or a fallback.
describe() {
  # `|| true`: grep exits non-zero when a file has no Description line; under
  # `set -o pipefail` that would abort the script instead of falling back.
  local desc
  desc="$(grep -m1 -E '^#[[:space:]]*Description:' "$1" | sed -E 's/^#[[:space:]]*Description:[[:space:]]*//' || true)"
  echo "${desc:-(no description)}"
}

# print_command <token> <file> — one aligned "  token  description" row.
print_command() { printf '  %-34s %s\n' "$1" "$(describe "$2")"; }

main() {
  echo "Available commands:"

  # Top-level commands. The `-e` guard skips the literal glob when none match.
  local file
  for file in "$CLI_DIR"/*.sh; do
    [[ -e "$file" ]] || continue
    print_command "$(basename "$file" .sh)" "$file"
  done

  # Families: one subfolder per family, its commands invoked as `family:command`.
  local dir family header
  for dir in "$CLI_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    family="$(basename "$dir")"
    header=0
    for file in "$dir"*.sh; do
      [[ -e "$file" ]] || continue
      if [[ $header -eq 0 ]]; then
        printf '\n%s:\n' "$family"
        header=1
      fi
      print_command "$family:$(basename "$file" .sh)" "$file"
    done
  done
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
