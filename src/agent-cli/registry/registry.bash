# The registry commands' shared setup (ASS-70). Each project runs its own zot
# (project-zot) on the Mac: a cache of its upstream that VMs pull through,
# which also holds images built locally. registry_config <command> <project>
# reads the project's "registry" object from data/projects/<project>/project.json —
#   { "storage-path": "projects/<project>/registry", "max-size-gb": <n>, "port": <n>,
#     "upstream": { "host": "<host>", "credentials": "gcloud" } }
# storage-path relative to the data folder (data/), upstream optional (registry_upstream)
# — and sets:
#   $storage   the project's registry folder: images/ (zot's storage), config.json,
#              credentials.json, zot.log, zot.out, last-pulls.json
#   $port      the port zot listens on, at 127.0.0.1 (VMs: host.lima.internal)
#   $max_gb    the soft cap registry:sweep holds the images to
#   $zot_pid_file  where registry:up keeps the pid of the project's zot
# PROJECTS_DIR overrides the projects folder (its parent, $root, is the data folder),
# ZOT_DIR where zot is installed, ZOT_URL and ZOT_SHA256 the download,
# ZOT_UPSTREAM_URL the registry zot's sync fetches from; all for tests.
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"
root="$(cd "$projects/.." && pwd -P)"
agent="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../agent.sh"

# zot's release, pinned: the darwin binary from GitHub (not Homebrew's unrelated
# "zot" formula), checked against the sha256 the release published.
zot_version=v2.1.22
zot_url="${ZOT_URL:-https://github.com/project-zot/zot/releases/download/$zot_version/zot-darwin-arm64}"
zot_sha256="${ZOT_SHA256:-24abc467dcd02247eae1ed66022f8e712cafadae26edbad1e9463b8aa0791bbf}"
# Outside the checkout, so every worktree of the harness shares the one binary.
zot_bin="${ZOT_DIR:-$HOME/Library/Application Support/harness/zot}/zot-$zot_version"

# The namespace locally built images are pushed under in zot. It starts with a
# digit, which no GCP project id can, so the sync's content rule ("[a-z]*/**")
# never sends it upstream and a pushed image is never replaced by Artifact
# Registry's image of the same name.
local_namespace=0local

# registry_upstream <command> <project> — the registry zot's sync fetches from,
# from the project's registry.upstream (ASS-134): e.g. Artifact
# Registry, us-central1-docker.pkg.dev (its images and the dev container live
# there), logged in with the Mac's gcloud, the only credential source. Sets:
#   $upstream      its host; empty when the project has none (the harness): its
#                  zot then has no sync, and nothing calls gcloud for it
#   $upstream_url  what zot's sync fetches from
#   $pushable      an upstream image by tag, no digest: what registry:push takes,
#                  and what vm:start pulls again once pushed. BASH_REMATCH[1]
#                  its path, [2] its tag. Matches nothing with no upstream.
registry_upstream() {
  local command="$1" project="$2" config
  config="$(jq -c '.registry.upstream // empty' "$projects/$project/project.json")"
  upstream="" upstream_url="" pushable='^$.'
  [[ -n "$config" ]] || return 0
  jq -e '(.host | type == "string" and test("^[A-Za-z0-9.-]+(:[0-9]+)?$")) and .credentials == "gcloud"' <<<"$config" >/dev/null 2>&1 \
    || { echo "$command: $project's registry upstream in project.json must be { \"host\": \"<host>\", \"credentials\": \"gcloud\" }, or absent for none" >&2; return 1; }
  upstream="$(jq -r .host <<<"$config")"
  upstream_url="${ZOT_UPSTREAM_URL:-https://$upstream}"
  pushable="^${upstream//./\\.}/([a-z0-9][a-z0-9._/-]*):([A-Za-z0-9_][A-Za-z0-9._-]*)\$"
}

registry_config() {
  local command="$1" project="$2" config
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  [[ -f "$projects/$project/project.json" ]] || { echo "$command: no project $project" >&2; return 1; }
  config="$(jq -c '.registry // empty' "$projects/$project/project.json")"
  jq -e '(.["storage-path"] | type == "string" and length > 0) and (.["max-size-gb"] | type == "number" and . > 0) and (.port | type == "number")' <<<"${config:-null}" >/dev/null 2>&1 \
    || { echo "$command: $project has no registry in project.json — add { \"storage-path\": \"projects/$project/registry\", \"max-size-gb\": <n>, \"port\": <n> }" >&2; return 1; }
  storage="$(jq -r '.["storage-path"]' <<<"$config")"
  [[ "$storage" == /* ]] || storage="$root/$storage"
  port="$(jq -r .port <<<"$config")"
  max_gb="$(jq -r '.["max-size-gb"]' <<<"$config")"
  zot_pid_file="${zot_bin%/*}/$project.pid"
  registry_upstream "$command" "$project"
}
