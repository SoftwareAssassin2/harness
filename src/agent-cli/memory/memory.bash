# The memory commands' shared setup (ASS-62). Each project runs its own
# Hindsight (vectorize-io/hindsight, hindsight.vectorize.io) on the Mac: the
# memory bank its agents retain to and recall from over MCP (src/agents/memory.js).
# memory_config <command> <project> reads the project's "hindsight" object from
# data/projects/<project>/project.json —
#   { "port": <n>, "llm-api-key": "<Anthropic API key>" | null }
# — or, so no key is written in project.json, "llm-api-key-keychain-service":
# "<item>" in place of llm-api-key, the key read from the Mac's keychain
# (security find-generic-password -s <item> -w) — and sets:
#   $port       the port Hindsight listens on, at 127.0.0.1 (VMs: host.lima.internal)
#   $data       data/projects/<project>/hindsight: Hindsight's HOME, so its embedded
#               PostgreSQL (~/.pg0), its own ~/.hindsight and the models it
#               downloads (~/.cache) all live there; hindsight.pid, hindsight.out
#               and config.sha256 too. Gitignored with the rest of the project's data.
#   $provider, $model, $key   Hindsight's LLM: Anthropic's API on claude-haiku-5-5
#               with the key; with none, provider none — retain stores plain
#               chunks, recall works, reflect is unavailable (Hindsight's docs)
#   $hindsight_bin   the pinned hindsight-api, in a virtualenv shared by every
#               project and worktree
# PROJECTS_DIR overrides the projects folder, HINDSIGHT_DIR where Hindsight is
# installed and HINDSIGHT_PYTHON the python that installs it; for tests.
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

# hindsight-api's release, pinned (PyPI); it needs Python 3.11 or newer.
hindsight_version=1.1.0
hindsight_python="${HINDSIGHT_PYTHON:-python3}"
hindsight_venv="${HINDSIGHT_DIR:-$HOME/Library/Application Support/harness}/hindsight-$hindsight_version"
hindsight_bin="$hindsight_venv/bin/hindsight-api"
hindsight_model=claude-haiku-5-5

memory_config() {
  local command="$1" project="$2" config
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  [[ -f "$projects/$project/project.json" ]] || { echo "$command: no project $project" >&2; return 1; }
  config="$(jq -c '.hindsight // empty' "$projects/$project/project.json")"
  jq -e '(.port | type == "number") and ((.["llm-api-key"] // null) | . == null or type == "string")' <<<"${config:-null}" >/dev/null 2>&1 \
    || { echo "$command: $project has no hindsight in project.json — add { \"port\": <n>, \"llm-api-key\": null }" >&2; return 1; }
  port="$(jq -r .port <<<"$config")"
  key="$(jq -r '.["llm-api-key"] // empty' <<<"$config")"
  local item; item="$(jq -r '.["llm-api-key-keychain-service"] // empty' <<<"$config")"
  if [[ -n "$item" ]]; then
    key="$(security find-generic-password -s "$item" -w 2>/dev/null)" && [[ -n "$key" ]] \
      || { echo "$command: $project's hindsight keychain item '$item' can't be read" >&2; return 1; }
  fi
  data="$(cd "$projects/.." && pwd -P)/projects/$project/hindsight"
  if [[ -n "$key" ]]; then provider=anthropic model="$hindsight_model"; else provider=none model=""; fi
}
