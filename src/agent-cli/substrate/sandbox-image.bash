# A project's Substrate sandbox image (ASS-534): its definition, inputs, status
# and where it is kept — shared by substrate:build-image, substrate:image-status,
# substrate:deliver-image and the golden image's commands (vm:golden-stale,
# vm:golden-status, vm:build-golden, vm:build-golden-start), which treat a
# project's sandbox images as part of its golden environment: rebuilt as the
# golden VM is, when their inputs change (vm:raise-golden-rebuilds).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate/sandbox-image.bash"
#   sandbox_definition <command> <project>   # golden.bash's golden_definition, then the sandbox's: sets
#                                            # $sandbox_folder, $declaration (services.yaml normalized, JSON;
#                                            # "null" without one), $declared (true when the project has a
#                                            # services.yaml), $architectures (what it declares; empty when not
#                                            # declared) and $provision_file; fails, naming every bad entry
#   sandbox_inputs <arch>                    # the image's input lines for <arch> (below)
#   sandbox_hash <arch>                      # their sha256: the image's hash
#   sandbox_label <project> <arch>           # data/projects/<project>/sandbox-image-<arch>.json: the built image's label
#   sandbox_status <project> <arch>          # after sandbox_definition: where its image stands, as JSON (below)
#   sandbox_statuses <project>               # every declared architecture's: { <arch>: <status>, … } ({} when not declared)
#   sandbox_stale <project> <arch>           # golden.bash's inputs_stale for it
#   sandbox_building <project>               # a build of the project's sandbox images holds its lock now
#   sandbox_repository <project>             # where its images go in the project's zot: 0local/sandbox/<project>
#
# Where it lives. The declaration is data/projects/<project>/sandbox/
# (services.yaml and the files it names; src/substrate/services.js says what
# it holds): gitignored, as every project folder is. What the harness writes
# sits beside it, never in it (the folder is an input):
#   sandbox-image-<arch>.json        the label of the last image built: { project, image, arch, hash,
#                                    inputs, digest, repository, tag, ref, built-at, build-seconds, size-bytes }
#   sandbox-image-<arch>-build.json  the last build's run: { hash, started-at, ended-at, exit-code }
#   sandbox-image-build-<arch>.log   its output
#   sandbox-image-build.lock         one build of the project's images at a time
#   sandbox-deliveries.json          which image each remote machine's cluster has (substrate:deliver-image)
# The images themselves are in the project's zot on the Mac (registry:up), as
# 0local/sandbox/<project>:<arch>-<hash's first 12>, pinned by digest: the
# label's ref is <registry>/0local/sandbox/<project>@<digest>. 0local is never
# synced with the upstream (registry.bash), so nothing goes to a cloud
# registry; registry:sweep keeps every image a label pins.
#
# The inputs: "<sha256>  <tag>/<path>" for each file the build uses —
# definition/provision.sh (the golden definition's; or the sandbox folder's
# own, services.yaml provision, under sandbox/), shared/git.sh and
# shared/repositories.sh (the golden image's shared steps), builder/<path>
# (src/substrate's dockerfile.js, services.js and image/: the Dockerfile's
# writer, the command server and the launcher), sandbox/<path> (every file of
# the sandbox folder) — then "repository <url>" for every repository, then
# "arch <arch>". Not images.txt, template.yaml or warm.sh, which a sandbox
# image does not use. Their sha256 is the image's hash; a changed input (a
# provision.sh edit, a service's new digest in services.yaml) makes it stale.
#
# sandbox_status prints
#   { image: "sandbox-<project>", arch, status, hash, built-hash, built-at, digest, ref, exit-code, log }
# status "building" while a build holds the lock; else "current" when the
# label has the inputs' hash now; else "failed" when the last build was of
# these inputs and did not succeed (exit-code its exit code; null when it was
# cut short); else "stale" (never built, or built from other inputs).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm/golden.bash"
substrate_src="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../substrate"

sandbox_definition() {
  local command="$1" project="$2" out
  golden_definition "$command" "$project" || return 1
  sandbox_folder="$projects/$project/sandbox"
  out="$(node "$substrate_src/services-cli.js" read "$sandbox_folder" 2>&1)" \
    || { echo "$command: $project's sandbox declaration is wrong: $out" >&2; return 1; }
  declaration="$out" declared=false architectures=""
  if [[ "$declaration" != null ]]; then
    declared=true
    architectures="$(jq -r '.architectures | join(" ")' <<<"$declaration")"
  fi
  provision_file="$folder/provision.sh"
  [[ "$declaration" == null ]] || [[ "$(jq -r '.provision // empty' <<<"$declaration")" == "" ]] \
    || provision_file="$sandbox_folder/$(jq -r .provision <<<"$declaration")"
}

sandbox_inputs() {
  local f
  if [[ "$provision_file" == "$folder/provision.sh" ]]; then
    printf '%s  definition/provision.sh\n' "$(shasum -a 256 "$provision_file" | cut -d' ' -f1)"
  fi
  for f in git.sh repositories.sh; do printf '%s  shared/%s\n' "$(shasum -a 256 "$shared/$f" | cut -d' ' -f1)" "$f"; done
  (cd "$substrate_src" && find dockerfile.js services.js image -type f ! -name '.*' -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | sed 's|  |  builder/|')
  [[ ! -d "$sandbox_folder" ]] || golden_files "$sandbox_folder" sandbox
  [[ ${#repos[@]} -eq 0 ]] || printf 'repository %s\n' "${repos[@]}"
  printf 'arch %s\n' "$1"
}

sandbox_hash() { sandbox_inputs "$1" | shasum -a 256 | cut -d' ' -f1; }

sandbox_label() { echo "$projects/$1/sandbox-image-$2.json"; }

sandbox_repository() { echo "${local_namespace:-0local}/sandbox/$1"; }

sandbox_building() {
  [[ -f "$projects/$1/sandbox-image-build.lock" ]] || return 1
  perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or exit 1; exit(flock($f, LOCK_EX | LOCK_NB) ? 1 : 0)' "$projects/$1/sandbox-image-build.lock"
}

sandbox_status() {
  local project="$1" arch="$2" h label run status=stale
  h="$(sandbox_hash "$arch")" label="$(sandbox_label "$project" "$arch")" run="$projects/$project/sandbox-image-$arch-build.json"
  [[ -f "$label" ]] || label=/dev/null
  [[ -f "$run" ]] || run=/dev/null
  if sandbox_building "$project"; then status=building
  elif [[ "$(jq -r '.hash // empty' "$label")" == "$h" ]]; then status=current
  elif [[ "$(jq -r '.hash // empty' "$run")" == "$h" && "$(jq -r '.["exit-code"] // "cut"' "$run")" != 0 ]]; then status=failed
  fi
  jq -nc --arg p "$project" --arg a "$arch" --arg s "$status" --arg h "$h" --arg log "$projects/$project/sandbox-image-build-$arch.log" \
    --slurpfile l "$label" --slurpfile r "$run" '($l[0] // {}) as $l | ($r[0] // {}) as $r
    | { image: "sandbox-\($p)", arch: $a, status: $s, hash: $h, "built-hash": ($l.hash // null), "built-at": ($l["built-at"] // null),
        digest: ($l.digest // null), ref: ($l.ref // null), "exit-code": (if $r.hash == $h then $r["exit-code"] // null else null end), log: $log }'
}

sandbox_statuses() {
  local arch lines=""
  for arch in $architectures; do lines+="$(sandbox_status "$1" "$arch")"$'\n'; done
  printf '%s' "$lines" | jq -sc 'map({ (.arch): . }) | add // {}'
}

sandbox_stale() {
  local label; label="$(sandbox_label "$1" "$2")"
  [[ -f "$label" ]] || label=/dev/null
  inputs_stale "$label" "$(sandbox_inputs "$2")" "$(sandbox_hash "$2")" "sandbox-$1"
}
