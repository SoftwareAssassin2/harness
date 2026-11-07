#!/usr/bin/env bash
# Description: Run the dashboard (and with it control and the downloader) — tui.
set -uo pipefail

dir="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
root="$(cd "$dir/../.." && pwd -P)"

# First start (ASS-290): with no project installed (no
# data/projects/*/project.json) and an interactive terminal, /install runs
# first: `claude "/install"` in the repo root, in the foreground, sharing the
# terminal. After it, the dashboard starts if a project is now installed;
# otherwise it asks whether to start it anyway. HARNESS_SKIP_INSTALL=1 or a
# non-interactive terminal skips this and goes straight to the dashboard.
#
# PROJECTS_DIR overrides data/projects, CLAUDE_BIN the claude binary,
# HARNESS_TUI_MAIN the dashboard (a command run in place of `node main.js`),
# and HARNESS_FORCE_INTERACTIVE=1 makes the terminal count as interactive
# (tests).
projects_dir="${PROJECTS_DIR:-$root/data/projects}"
claude_bin="${CLAUDE_BIN:-claude}"

# installed — some project has a project.json.
installed() {
  local f
  for f in "$projects_dir"/*/project.json; do [[ -f "$f" ]] && return 0; done
  return 1
}

# interactive — stdin and stdout are terminals (or a test says they are).
interactive() {
  [[ "${HARNESS_FORCE_INTERACTIVE:-}" == 1 ]] || [[ -t 0 && -t 1 ]]
}

if [[ "${HARNESS_SKIP_INSTALL:-}" != 1 ]] && ! installed && interactive; then
  if ! command -v "$claude_bin" >/dev/null 2>&1; then
    echo "No project is installed, and Claude Code ($claude_bin) isn't installed to run /install." >&2
    echo "Install Claude Code (https://claude.com/claude-code), then run ./harness.sh tui again," >&2
    echo "or open Claude Code in $root and run /install." >&2
    exit 1
  fi
  echo "No project is installed: running /install first (the dashboard starts when it ends)."
  # HARNESS_INSTALL_FROM_TUI tells /install's last step the dashboard starts when the session ends.
  (cd "$root" && HARNESS_INSTALL_FROM_TUI=1 "$claude_bin" "/install")
  if ! installed; then
    printf 'Still no project installed. Start the dashboard anyway? [y/N] '
    answer=""
    read -r answer || true
    if [[ ! "$answer" =~ ^[Yy] ]]; then
      echo "Run ./harness.sh tui again to rerun /install (HARNESS_SKIP_INSTALL=1 starts the dashboard without it)."
      exit 1
    fi
  fi
fi

# The dashboard exits with code 75 when control asked for a restart (a
# self-healing fix went in, harness:request-restart): it is started again, on
# the new code. Any other exit ends it, with that code. The check above runs
# once, never on a restart.
while :; do
  if [[ -n "${HARNESS_TUI_MAIN:-}" ]]; then
    "$HARNESS_TUI_MAIN" "$@"
  else
    node "$dir/../tui/main.js" "$@"
  fi
  status=$?
  [[ $status -eq 75 ]] || exit "$status"
done
