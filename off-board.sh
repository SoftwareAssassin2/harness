#!/usr/bin/env bash
# Entry point for the Off-Board CLI.
# Dispatch resolves from this script's own location, so it runs the same from
# any working directory.
#
# Usage:
#   off-board.sh                            # list available commands (same as `--help`)
#   off-board.sh <command> [args]           # run src/off-board-cli/<command>.sh with the args
#   off-board.sh <family>:<command> [args]  # run src/off-board-cli/<family>/<command>.sh with the args
#
# A command is a src/off-board-cli/*.sh script; a subfolder groups a "family" of
# commands, invoked as `family:command`. Add a file and it becomes a command.
# Shared library code is named *.bash so `--help` never lists it as a command.
#
# This dispatcher is a deliberate near-duplicate of its two siblings: three
# small files beat one shared library plus three thin wrappers (spec fn-124,
# Decision Context — "Duplicated dispatchers over a shared library").
set -euo pipefail

# Commands live in src/off-board-cli/ next to this script (override with
# OFF_BOARD_CLI_DIR, used by tests). Resolve from the script's own location so
# dispatch works from any working directory.
CLI_DIR="${OFF_BOARD_CLI_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/src/off-board-cli}"

# valid_segment <s> — a family/command name is a single path segment: letters,
# digits, underscore, hyphen. Rejects empty strings, slashes and dots, so a
# token can never traverse out of CLI_DIR (`..`, `a/b`, trailing/leading colon).
valid_segment() { [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]]; }

main() {
  # `--help` is the default only when NO argument was given. A present but empty
  # argument is a token whose only segment is empty, so it falls through to the
  # rejection below like any other malformed token.
  local command="--help"
  if [[ $# -gt 0 ]]; then
    command="$1"
    shift
  fi

  # Every segment is validated BEFORE a path is built, so an invalid token can
  # never name a file: `family:command` -> src/off-board-cli/family/command.sh; a
  # plain name -> src/off-board-cli/name.sh.
  local script
  if [[ "$command" == *:* ]]; then
    local family="${command%%:*}" name="${command#*:}"
    if ! valid_segment "$family" || ! valid_segment "$name"; then
      echo "off-board.sh: invalid command '$command'" >&2
      return 1
    fi
    script="$CLI_DIR/$family/$name.sh"
  else
    if ! valid_segment "$command"; then
      echo "off-board.sh: invalid command '$command'" >&2
      return 1
    fi
    script="$CLI_DIR/$command.sh"
  fi

  if [[ ! -f "$script" ]]; then
    echo "off-board.sh: unknown command '$command'" >&2
    echo "Run 'off-board.sh --help' to list available commands." >&2
    return 1
  fi

  exec "$script" "$@"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
