# The harness's npm dependencies (ASS-524: the `yaml` package, its first,
# which reads the engines' workflow.yaml), installed from package-lock.json.
# A fresh clone has no node_modules/: the dashboard (tui) and install-project
# run ensure_node_modules first, so `./harness.sh tui` works from a fresh
# clone; it runs `npm ci` only when the package cannot be loaded from <root>
# (a git worktree of the checkout finds the checkout's node_modules too).
#
#   source "$root/src/harness-cli/node-modules.bash"
#   ensure_node_modules <root>   # fails, saying why, when npm ci fails
ensure_node_modules() {
  local root="$1"
  (cd "$root" && node --input-type=module -e "await import('yaml')" >/dev/null 2>&1) && return 0
  echo "Installing the harness's npm dependencies (npm ci in $root)…" >&2
  (cd "$root" && npm ci --no-audit --no-fund >&2) || { echo "npm ci failed in $root: install Node.js and npm, then run npm ci there" >&2; return 1; }
}
