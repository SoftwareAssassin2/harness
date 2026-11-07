# A project's golden image's inputs (ASS-72), one definition shared by
# vm:build-golden, which tags the image with their hash, and vm:golden-stale
# (ASS-149), which compares them with those the image was built from.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"
#   golden_definition <command> <project>   # reads the definition: sets $folder, $tools, $images, $repos, $hosts_toml (and registry.bash's $port…),
#                                            # $inputs, the input lines exactly as hashed, and $hash; fails, naming <command>, without one
#   golden_label <project>                   # <LIMA_HOME>/golden-<project>/golden-image.json, the built image's label
#   golden_status <project>                  # after golden_definition: where its build stands, as JSON (below)
#
# The inputs (see build-golden.sh): "<sha256>  definition/<path>" for every
# file of the definition, "<sha256>  shared/<path>" for every shared step,
# "repository <url>" for every repository, then the registry mirror's
# hosts.toml, its lines as they are (one empty line when none). Their sha256
# is the image's hash; the label records it and, from ASS-149 on, the lines
# (inputs: the text split at each newline, the last aside — joined with
# newlines plus one more, they hash to it), so a stale image can say what
# changed. GOLDEN_IMAGE_SHARED overrides the shared steps'
# folder, for tests. LIMA_HOME is exported as lima-home.bash resolves it
# (ASS-273).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../registry/registry.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../lima-home.bash"
LIMA_HOME="$(lima_home)"; export LIMA_HOME
shared="${GOLDEN_IMAGE_SHARED:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden-image}"

golden_definition() {
  local command="$1" json f
  [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$2'" >&2; return 1; }
  json="$projects/$2/project.json"
  [[ -f "$json" ]] || { echo "$command: no project $2" >&2; return 1; }
  folder="$(jq -r '.["golden-image"].folder // empty' "$json")"
  [[ -n "$folder" ]] || { echo "$command: $2 has no golden-image in project.json — add { \"folder\": \"projects/$2/golden-image\" }" >&2; return 1; }
  [[ "$folder" == /* ]] || folder="$root/$folder"
  for f in template.yaml provision.sh; do
    [[ -f "$folder/$f" ]] || { echo "$command: no $folder/$f" >&2; return 1; }
  done
  mapfile -t tools < <(jq -r '.["golden-image"].tools[]?' "$json")
  images="$(grep -vE '^[[:space:]]*(#|$)' "$folder/images.txt" 2>/dev/null || true)"
  mapfile -t repos < <(jq -r '.repositories[]?.url' "$json")
  hosts_toml=""
  if [[ -n "$images" ]] || jq -e '.registry' "$json" >/dev/null; then
    registry_config "$command" "$2" || return 1
    hosts_toml="$("$agent" registry:hosts-toml "$2")" || return 1
  fi
  inputs="$(golden_inputs; echo .)"   # the dot keeps the trailing newlines, which are hashed too
  inputs="${inputs%.}"
  hash="$(printf '%s' "$inputs" | shasum -a 256 | cut -d' ' -f1)"
}

# golden_files <dir> <tag> — "<sha256>  <tag>/<path>" for each file under dir, dotfiles (.DS_Store) and
# vm:test-repos' tests.json and run-test.sh, and ci-checks:verify's ci-checks.json, aside: they test the
# image or a ticket's work, and are not in it.
golden_files() { (cd "$1" && find . -type f ! -name '.*' ! -name tests.json ! -name run-test.sh ! -name ci-checks.json -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | sed "s|  \./|  $2/|"); }

golden_inputs() { golden_files "$folder" definition; golden_files "$shared" shared; printf 'repository %s\n' "${repos[@]}"; printf '%s\n' "$hosts_toml"; }

golden_label() { echo "$LIMA_HOME/golden-$1/golden-image.json"; }

# A build started detached (vm:build-golden-start, ASS-151) is recorded in
# data/projects/<project>/: golden-build-run.json { pid, started-at } as it
# starts, golden-build-run.log its own output, golden-build-run.exit its exit
# code once it ends (removed as the next starts); its steps' output is
# golden-image-build.log, vm:build-golden's. golden_status prints
#   { project, image, status, exit-code, log, run-log }
# status "building" while a build holds the build lock (one started by hand
# too) or the started one's process lives and has not ended; else "current"
# when the image has the hash of its inputs now; else "failed" — the build
# did not make it current — exit-code the last started build's, null when
# none ended (none started, or it was killed).
golden_status() {
  local dir="$projects/$1" status=failed code=null pid
  [[ ! -f "$dir/golden-build-run.exit" ]] || code="$(tr -dc 0-9 < "$dir/golden-build-run.exit")"
  pid="$(jq -r '.pid // empty' "$dir/golden-build-run.json" 2>/dev/null || true)"
  if golden_building "$1" || { [[ "$code" == null && -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; }; then status=building
  elif [[ -f "$(golden_label "$1")" && "$(jq -r .hash "$(golden_label "$1")")" == "$hash" ]]; then status=current
  fi
  jq -nc --arg p "$1" --arg s "$status" --argjson c "${code:-null}" --arg log "$(cd "$dir" && pwd -P)/golden-image-build.log" --arg run "$(cd "$dir" && pwd -P)/golden-build-run.log" \
    '{ project: $p, image: "golden-\($p)", status: $s, "exit-code": $c, log: $log, "run-log": $run }'
}

# golden_building <project> — a build of it holds its build lock (vm:build-golden's) now.
golden_building() {
  perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or exit 1; exit(flock($f, LOCK_EX | LOCK_NB) ? 1 : 0)' "$projects/$1/golden-build.lock"
}
