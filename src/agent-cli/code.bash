# A ticket's branch, worktree and merge request in the project's workspace,
# for the code:* and merge-request:* commands (the merge requests on their
# forges: merge-requests.bash).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"
#   workspace_of <command> <project>              # the project's local-pc folder (project.json local-environments), a git checkout
#   branch_name <ticket-key> <variation>          # change/<KEY> for variation A, change/<KEY>.<variation> for another
#   worktree_folder <workspace> <ticket-key> <variation>   # <workspace>/.worktrees/<KEY> (or <KEY>.<variation>)
#   default_branch <workspace>                    # origin's default branch (origin/HEAD), else master
#   find_branch <workspace> <name>                # the branch as named locally or on origin, matched in any case; nothing when none
#   repo_url <workspace>                          # origin's URL as https://host/group/project
#   repo_path <workspace>                         # group/project, for glab --repo
#   build_of <command> <project> <ticket-key> <variation>   # the variation's build object, as JSON
#   vm_of <command> <project> <ticket-key> <variation>      # the name of the variation's VM (ASS-74); nothing when it has none
#   set_build <command> <project> <ticket-key> <variation> '<json object>'   # merged into the variation's build
#   ticket_field <command> <project> <ticket-key> <field>   # a field of the ticket (title, url, …)
#   ticket_reference <command> <project> <ticket-key>       # [KEY](url) for a web url; else, an off-board ticket's file:// or none, KEY: title (ASS-86)
#   forge <workspace>                             # github when origin is on github.com (the harness's own repository), else gitlab
#   branch_url <workspace> <branch>               # the branch's page on origin's forge: GitHub's /tree/<branch>, GitLab's /-/tree/<branch>
#   glab_authenticated <command>                  # whether glab is logged in (below); fails, saying so, when not
#   glab_run <command> <glab args…>               # runs glab once it is authenticated, or says what it would run when GLAB_DISABLED=1 (tests)
#   gh_run <command> <gh args…>                   # runs gh, or says what it would run when GH_DISABLED=1
#   in_project <command> <project> <folder> <shell command> [<vm>]   # runs it in <folder> where the project's dependencies live (below)
#
# The ticket key is uppercased wherever it names a branch or folder (branch
# names are case-sensitive; the key is written in upper case verbatim).
# PROJECTS_DIR overrides the projects folder, used by tests. Each fails,
# naming <command>, when the project or its workspace is missing.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/sprint.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lima-home.bash"

workspace_of() {
  local command="$1" project="$2" folder
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  folder="$(jq -r 'first(.["local-environments"][]? | select(.type == "local-pc") | .folder) // empty' "$projects/$project/project.json" 2>/dev/null || true)"
  [[ -n "$folder" ]] || { echo "$command: project '$project' has no local-pc environment with a folder in project.json" >&2; return 1; }
  [[ -d "$folder" ]] && git -C "$folder" rev-parse --git-dir >/dev/null 2>&1 || { echo "$command: the workspace $folder is not a git checkout" >&2; return 1; }
  echo "$folder"
}

upper() { tr '[:lower:]' '[:upper:]' <<< "$1"; }
ticket_slug() { if [[ "$2" == A ]]; then upper "$1"; else echo "$(upper "$1").$2"; fi; }
branch_name() { echo "change/$(ticket_slug "$1" "$2")"; }
worktree_folder() { echo "$1/.worktrees/$(ticket_slug "$2" "$3")"; }

default_branch() {
  local ref
  ref="$(git -C "$1" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  echo "${ref#origin/}" | sed 's/^$/master/'
}

find_branch() {
  local workspace="$1" wanted="$2" name
  while read -r name; do
    [[ "$(upper "$name")" == "$(upper "$wanted")" ]] && { echo "$name"; return 0; }
  done < <(git -C "$workspace" for-each-ref --format='%(refname:short)' refs/heads/ refs/remotes/origin/ | sed 's#^origin/##' | grep -v '^HEAD$' | sort -u)
  return 0
}

repo_url() {
  local url
  url="$(git -C "$1" remote get-url origin)"
  url="${url%.git}"
  if [[ "$url" =~ ^[^@]+@([^:]+):(.+)$ ]]; then url="https://${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"; fi
  echo "$url"
}
repo_path() { local url; url="$(repo_url "$1")"; echo "${url#*://*/}"; }

# variation_field <filter> <command> <project> <ticket-key> <variation> — the filter run on the variation.
variation_field() {
  local filter="$1" command="$2" project="$3" ticket="$4" variation="$5" file
  file="$(sprint_file "$command" "$project")" || return 1
  jq -c --arg key "$ticket" --arg name "$variation" '
    (first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase))) // null) as $t
    | ($t.variations // [] | map(select(.name == $name and (.["is-deleted"] | not))) | first) as $v
    | if $t == null then error("no ticket") elif $v == null then error("no variation") else ($v | '"$filter"') end' "$file" 2>/dev/null \
    || { echo "$command: no $ticket variation $variation in $project's active sprint" >&2; return 1; }
}
build_of() { variation_field '.build // {}' "$@"; }
vm_of() { variation_field '.vm.name // ""' "$@" | jq -r .; }

set_build() {
  local command="$1" project="$2" ticket="$3" variation="$4" fields="$5"
  update_whole_ticket "$command" "$project" "$ticket" --arg name "$variation" --argjson fields "$fields" '
    if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
    | .variations |= map(if .name == $name then .build = ((.build // {}) + $fields) else . end)'
}

ticket_field() {
  local command="$1" project="$2" ticket="$3" field="$4" file
  file="$(sprint_file "$command" "$project")" || return 1
  jq -r --arg key "$ticket" --arg field "$field" '
    first((.features, .bugs, .spikes) // [] | .[] | select(.key | ascii_downcase == ($key | ascii_downcase)) | .[$field]) // empty' "$file"
}

# A merge request page cannot open a file:// link, so only a web url is linked.
ticket_reference() {
  local url
  url="$(ticket_field "$@" url)" || return 1
  [[ "$url" == http://* || "$url" == https://* ]] && echo "[$3]($url)" || echo "$3: $(ticket_field "$@" title)"
}

forge() { [[ "$(repo_url "$1")" == https://github.com/* ]] && echo github || echo gitlab; }
branch_url() { [[ "$(forge "$1")" == github ]] && echo "$(repo_url "$1")/tree/$2" || echo "$(repo_url "$1")/-/tree/$2"; }

gh_run() {
  local command="$1" arg shown="gh"
  shift
  if [[ "${GH_DISABLED:-}" == 1 ]]; then
    for arg in "$@"; do [[ "$arg" == *[[:space:]]* ]] && shown+=" \"$arg\"" || shown+=" $arg"; done
    echo "$command: GH_DISABLED, skipping: $shown" >&2
  else
    gh "$@"
  fi
}

# glab_authenticated asks glab auth status — whether glab is logged in, as
# control's check for the dashboard (ctx.glab, src/control/tick.js) does —
# so an expired or missing login fails a step at once, with an auth error,
# instead of as a glab failure on every visit (ASS-54). It is a network call,
# so it is asked once per shell: a pass is remembered, and a subshell (a
# glab_run in $(…)) inherits it, so a command that asks it before its first
# glab_run in $(…) asks it once. Always passes when GLAB_DISABLED=1.
glab_authenticated() {
  [[ "${GLAB_DISABLED:-}" == 1 || -n "${glab_authenticated_already:-}" ]] && return 0
  glab auth status >/dev/null 2>&1 || { echo "$1: glab is not authenticated" >&2; return 1; }
  glab_authenticated_already=1
}

glab_run() {
  local command="$1" arg shown="glab"
  shift
  if [[ "${GLAB_DISABLED:-}" == 1 ]]; then
    for arg in "$@"; do [[ "$arg" == *[[:space:]]* ]] && shown+=" \"$arg\"" || shown+=" $arg"; done
    echo "$command: GLAB_DISABLED, skipping: $shown" >&2
  else
    glab_authenticated "$command" || return 1
    glab "$@"
  fi
}

# in_project runs a project's shell command (worktree-setup, a test) in a
# host folder, where the project's dependencies live (ASS-96): on the host
# for a project without a dev-container in project.json; else in that
# container, at the folder as it mounts it (the rule of containerPath,
# src/control/dispatch.js), with project.json's dev-container-env as its
# environment ({folder} in a value is the host folder; values show in `ps`,
# so never secrets) and the operator's ~/.npmrc as its npm user config —
# copied in on stdin to a temp file the container removes on exit, never on
# the command line. stdin is never the caller's, so a `while read` loop
# around it keeps its input. Returns the command's status; 125 when the
# container is missing, stopped, unreachable or does not mount the folder.
# Given <vm> (a variation's, ASS-74), it runs in that VM instead, <folder> a
# folder there, through limactl shell (its LIMA_HOME lima-home.bash's,
# ASS-273): the VM holds the project's dependencies.
IN_PROJECT_SHIM='f="$(mktemp)"; trap '"'"'rm -f "$f"'"'"' EXIT; cat > "$f"; [ -s "$f" ] && export NPM_CONFIG_USERCONFIG="$f"; bash -c "$1"; s=$?; rm -f "$f"; exit $s'
in_project() {
  local command="$1" project="$2" folder="$3" run="$4" vm="${5:-}" container state inside input=/dev/null k v
  local envs=()
  if [[ -n "$vm" ]]; then LIMA_HOME="$(lima_home)" limactl shell --workdir "$folder" "$vm" -- bash -c "$run" < /dev/null; return; fi
  container="$(jq -r '."dev-container" // empty' "$projects/$project/project.json")"
  [[ -n "$container" ]] || { (cd "$folder" && bash -c "$run") < /dev/null; return; }
  state="$(docker inspect -f '{{.State.Running}} {{json .Mounts}}' "$container" 2>&1)" || { echo "$command: the dev container $container is unavailable: $state" >&2; return 125; }
  [[ "$state" == "true "* ]] || { echo "$command: the dev container $container is not running" >&2; return 125; }
  inside="$(jq -r --arg f "$folder" '
    [.[] | (.Source // "" | rtrimstr("/")) as $s | select($s != "" and ($f == $s or ($f | startswith($s + "/")))) | { d: .Destination, n: ($s | length) }]
    | max_by(.n) | if . then .d + $f[.n:] else empty end' <<< "${state#true }")"
  [[ -n "$inside" ]] || { echo "$command: the dev container $container does not mount $folder" >&2; return 125; }
  while IFS=$'\t' read -r k v; do envs+=(-e "$k=${v//"{folder}"/"$folder"}"); done < <(jq -r '."dev-container-env" // {} | to_entries[] | "\(.key)\t\(.value)"' "$projects/$project/project.json")
  [[ -f "$HOME/.npmrc" ]] && input="$HOME/.npmrc"
  docker exec -i -w "$inside" ${envs[@]+"${envs[@]}"} "$container" bash -c "$IN_PROJECT_SHIM" in_project "$run" < "$input"
}
