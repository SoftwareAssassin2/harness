# A project's Substrate clusters (ASS-533), for the substrate:* commands and
# workstation:setup: the pinned release, the kit the machines run it with,
# and how a command reaches a cluster's machine — the Mac itself, or a
# workstation or cloud VM over its one SSH connection (workstation.bash).
# What runs there is on-machine/substrate.sh, which says what each action
# does and what it keeps where.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../substrate.bash"
#   substrate_entry <command> <project> <machine>   # its dev-environments.substrate.clusters entry, one JSON line (substrate.js);
#                                                   # fails, naming <command>, without one or when the list is wrong
#   substrate_platform_of <project> <machine> <entry>   # darwin-arm64, linux-amd64, …: the machine's (uname over its connection)
#   substrate_kit <command> <platform>      # the kit for <platform> built when missing; prints "<sha256> <tarball>"
#   substrate_ensure_kit <command> <project> <machine> <entry>   # the machine has the kit (sent over its connection when not)
#   substrate_on <project> <machine> <entry> <action> [<arg>…]   # on-machine/substrate.sh <action> run on the machine, stdin
#                                                   # passed through; its JSON line on stdout, its exit code
#   substrate_connected <project> <machine> <entry> # the Mac, or a remote machine whose connection is open
#   substrate_lock <command> <project> <machine> <entry>   # the cluster's lock (descriptor 7) until exit: every up, down
#                                                   # and load; the Mac's is one for every project (its cluster is shared)
#   substrate_record <project> <machine> [jq options…] <filter>   # its entry in data/projects/<p>/substrate.json, rewritten
#
# The pinned release (AC2, ASS-532: "pin a release and install from published
# images, not a source build"): Substrate SUBSTRATE_RELEASE's images from
# SUBSTRATE_IMAGE_REPO, its gVisor worker image by digest, kind KIND_VERSION
# with its node image by digest, kubectl KUBECTL_VERSION (the node's). Raising
# SUBSTRATE_RELEASE makes the next substrate:up upgrade each cluster.
#
# The kit: what a machine needs to run the release, the same on the Mac and
# on a remote machine — bin/ate-setup (Substrate's installer, built once from
# the release's tag with Go: releases ship no binary of it), bin/kubectl-ate
# (the release's own binary, its sha256 checked), bin/kind and bin/kubectl
# (their releases', checked likewise) and src/ (the tag's go.mod, manifests,
# .ko.yaml and hack/release: ate-setup reads its manifests from a checkout).
# Built on the Mac under ~/.harness/substrate/build/<release>/ (a shallow
# clone of the tag, then <platform>.tar.gz and its .sha256), and installed on
# each machine from that tarball — on a remote machine sent over its SSH
# connection, so the machine needs no Go and fetches nothing from GitHub —
# under ~/.harness/substrate/kit/<sha>/ (on-machine/substrate.sh
# install-kit). Building needs go, git and curl on the Mac (substrate:kit
# builds it ahead). HARNESS_SUBSTRATE_DIR overrides ~/.harness/substrate on
# the Mac (tests).
#
# Live data: data/projects/<project>/substrate.json (PROJECTS_DIR overrides
# the projects folder) — { "<machine>": { state, problems, checked-at, node,
# docker, usage, release, kubeconfig, up: { ok, at, did, failed, release } } }
# — written by substrate:health and substrate:up through update_json, read by
# control (src/control/substrate.js) and the dashboard
# (src/control/substrate-config.js loadSubstrate).
here_substrate="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here_substrate/workstation.bash"
substrate_projects="${PROJECTS_DIR:-$here_substrate/../../data/projects}"
substrate_dir="${HARNESS_SUBSTRATE_DIR:-$HOME/.harness/substrate}"
substrate_script="$here_substrate/substrate/on-machine/substrate.sh"

SUBSTRATE_RELEASE=v1.0.1
SUBSTRATE_REPO=https://github.com/agent-substrate/substrate
SUBSTRATE_IMAGE_REPO=ghcr.io/agent-substrate/substrate
SUBSTRATE_WORKER_IMAGE=ghcr.io/agent-substrate/substrate/ateworker-gvisor:v1.0.1@sha256:fd0c6a46d6c69d485856171e632906e774594bea9d00011a4d7038be3e084a2a
KIND_VERSION=v0.33.0
KIND_NODE_IMAGE=kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5
KUBECTL_VERSION=v1.37.0
# ASS-535: each cluster's image registry (on-machine/substrate.sh registry-up): registry:3 by digest, on the machine's
# 127.0.0.1:SUBSTRATE_REGISTRY_PORT (HARNESS_SUBSTRATE_REGISTRY_PORT overrides it, for tests).
SUBSTRATE_REGISTRY_IMAGE=docker.io/library/registry:3@sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c
SUBSTRATE_REGISTRY_PORT="${HARNESS_SUBSTRATE_REGISTRY_PORT:-5011}"
# ASS-536: a workstation's or cloud VM's relay to the Mac's services (on-machine/substrate.sh mac-relay): socat by digest.
SUBSTRATE_RELAY_IMAGE=docker.io/alpine/socat:1.8.0.3@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e

substrate_entry() {
  local out
  [[ "$2" =~ ^[A-Za-z0-9_-]+$ && -f "$substrate_projects/$2/project.json" ]] || { echo "$1: no project '$2'" >&2; return 1; }
  [[ "$3" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$1: invalid machine '$3'" >&2; return 1; }
  out="$(node "$here_substrate/substrate.js" "$substrate_projects" "$2" "$3" 2>&1)" || { echo "$1: project $2: $out" >&2; return 1; }
  echo "$out"
}

substrate_host() { jq -r '.host' <<< "$1"; }

# substrate_platform <uname -s> <uname -m> — the kit's platform name.
substrate_platform() {
  local os arch
  case "$1" in Darwin) os=darwin ;; Linux) os=linux ;; *) return 1 ;; esac
  case "$2" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) return 1 ;; esac
  echo "$os-$arch"
}

substrate_platform_of() {
  local un
  if [[ "$(substrate_host "$3")" == mac ]]; then un="$(uname -sm)"; else un="$(workstation_ssh "$1" "$2" uname -sm)" || return 1; fi
  substrate_platform ${un% *} ${un#* } || { echo "no Substrate kit for $un" >&2; return 1; }
}

substrate_sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# substrate_fetch <url> <file> <sha256 url> — <url> downloaded to <file> and checked against the first word of what
# <sha256 url> holds (a release's checksum file).
substrate_fetch() {
  local want
  curl -fsSL --retry 3 -o "$2" "$1" || { echo "could not download $1" >&2; return 1; }
  want="$(curl -fsSL --retry 3 "$3" | awk '{ print $1; exit }')" || { echo "could not download $3" >&2; return 1; }
  [[ "$(substrate_sha "$2")" == "$want" ]] || { echo "$1 does not match its checksum ($3)" >&2; return 1; }
  chmod 755 "$2"
}

substrate_kit() {
  local command="$1" platform="$2" b="$substrate_dir/build/$SUBSTRATE_RELEASE" os arch stage t
  [[ "$platform" =~ ^(darwin|linux)-(amd64|arm64)$ ]] || { echo "$command: no Substrate kit for platform '$platform'" >&2; return 1; }
  mkdir -p "$b" && chmod 700 "$substrate_dir"
  lock_on 6 "$b/build.lock" "$command" "${SUBSTRATE_KIT_LOCK_TIMEOUT:-1800}" || return 1
  if [[ -f "$b/$platform.tar.gz" && -f "$b/$platform.sha256" ]]; then echo "$(cat "$b/$platform.sha256") $b/$platform.tar.gz"; exec 6>&-; return 0; fi
  for t in go git curl tar; do command -v "$t" >/dev/null || { echo "$command: building the Substrate kit needs $t on the Mac (brew install $t)" >&2; exec 6>&-; return 1; }; done
  os="${platform%-*}" arch="${platform#*-}" stage="$b/stage-$platform"
  echo "$command: building the Substrate $SUBSTRATE_RELEASE kit for $platform in $b (once)" >&2
  if [[ ! -f "$b/checkout/go.mod" ]]; then
    rm -rf "$b/checkout"
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$SUBSTRATE_RELEASE" "$SUBSTRATE_REPO" "$b/checkout" >&2 || { echo "$command: could not clone $SUBSTRATE_REPO at $SUBSTRATE_RELEASE" >&2; exec 6>&-; return 1; }
  fi
  rm -rf "$stage" && mkdir -p "$stage/bin" "$stage/src" || { exec 6>&-; return 1; }
  if ! { git -C "$b/checkout" archive HEAD go.mod manifests .ko.yaml hack/release | tar -x -C "$stage/src"; } \
    || ! (cd "$b/checkout" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -mod=vendor -trimpath -ldflags '-s -w' -o "$stage/bin/ate-setup" ./cmd/ate-setup) >&2 \
    || ! substrate_fetch "$SUBSTRATE_REPO/releases/download/$SUBSTRATE_RELEASE/kubectl-ate-$platform" "$stage/bin/kubectl-ate" "$SUBSTRATE_REPO/releases/download/$SUBSTRATE_RELEASE/kubectl-ate-$platform.sha256" \
    || ! substrate_fetch "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-$platform" "$stage/bin/kind" "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-$platform.sha256sum" \
    || ! substrate_fetch "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/$os/$arch/kubectl" "$stage/bin/kubectl" "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/$os/$arch/kubectl.sha256"; then
    echo "$command: the Substrate kit for $platform could not be built" >&2; rm -rf "$stage"; exec 6>&-; return 1
  fi
  # COPYFILE_DISABLE, --no-mac-metadata: no AppleDouble ._ files or xattrs, which a Linux machine would unpack as
  # files (ate-setup then reads ._<manifest>.yaml as a manifest).
  COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$b/$platform.tar.gz.part" -C "$stage" bin src && mv -f "$b/$platform.tar.gz.part" "$b/$platform.tar.gz" && substrate_sha "$b/$platform.tar.gz" > "$b/$platform.sha256" || { exec 6>&-; return 1; }
  rm -rf "$stage"
  echo "$(cat "$b/$platform.sha256") $b/$platform.tar.gz"
  exec 6>&-
}

# substrate_env <project> <machine> <entry> — the on-machine script's settings, one NAME=value per line.
substrate_env() {
  jq -r --arg p "$1" --arg rel "$SUBSTRATE_RELEASE" --arg reg "$SUBSTRATE_REGISTRY_IMAGE" --arg rport "$SUBSTRATE_REGISTRY_PORT" --arg relay "$SUBSTRATE_RELAY_IMAGE" --arg repo "$SUBSTRATE_IMAGE_REPO" --arg worker "$SUBSTRATE_WORKER_IMAGE" --arg node "$KIND_NODE_IMAGE" '
    "HARNESS_SUBSTRATE_HOST=\(.host)", "HARNESS_SUBSTRATE_PROJECT=\($p)", "HARNESS_SUBSTRATE_MACHINE=\(.machine)",
    "HARNESS_SUBSTRATE_NAMESPACE=\(.namespace)", "HARNESS_SUBSTRATE_CLUSTER=\(.cluster)",
    "HARNESS_SUBSTRATE_RELEASE=\($rel)", "HARNESS_SUBSTRATE_IMAGE_REPO=\($repo)", "HARNESS_SUBSTRATE_WORKER_IMAGE=\($worker)",
    "HARNESS_SUBSTRATE_NODE_IMAGE=\($node)", "HARNESS_SUBSTRATE_WARM_WORKERS=\(.["warm-workers"])",
    "HARNESS_SUBSTRATE_WORKER_MEMORY_MI=\(.["worker-memory-gib"] * 1024 | floor)", "HARNESS_SUBSTRATE_WORKER_CPUS=\(.["worker-cpus"])",
    "HARNESS_SUBSTRATE_NEED_MEMORY=\((.["memory-gib"] + 1) * 1073741824 | floor)",
    "HARNESS_SUBSTRATE_REGISTRY_IMAGE=\($reg)", "HARNESS_SUBSTRATE_REGISTRY_PORT=\($rport)", "HARNESS_SUBSTRATE_RELAY_IMAGE=\($relay)"' <<< "$3"
  local v
  for v in HARNESS_SUBSTRATE_TEMPLATE_WAIT HARNESS_SUBSTRATE_RESUME_WAIT; do [[ -z "${!v:-}" ]] || echo "$v=${!v}"; done
  [[ -z "${HARNESS_SUBSTRATE_REPAIR:-}" ]] || echo "HARNESS_SUBSTRATE_REPAIR=$HARNESS_SUBSTRATE_REPAIR"
}

substrate_on() {
  local project="$1" machine="$2" entry="$3" action="$4" vars=() v; shift 4
  while IFS= read -r v; do vars+=("$v"); done < <(substrate_env "$project" "$machine" "$entry")
  if [[ "$(substrate_host "$entry")" == mac ]]; then
    env ${HARNESS_SUBSTRATE_DIR:+HARNESS_SUBSTRATE_DIR="$HARNESS_SUBSTRATE_DIR"} "${vars[@]}" bash -c "$(cat "$substrate_script")" substrate "$action" "$@"
  else
    workstation_ssh "$project" "$machine" env "${vars[@]}" bash -c "$(cat "$substrate_script")" substrate "$action" "$@"
  fi
}

substrate_connected() { [[ "$(substrate_host "$3")" == mac ]] || workstation_alive "$1" "$2"; }

substrate_ensure_kit() {
  local command="$1" project="$2" machine="$3" entry="$4" platform kit sha file
  platform="$(substrate_platform_of "$project" "$machine" "$entry")" || { echo "$command: could not tell $machine's platform" >&2; return 1; }
  kit="$(substrate_kit "$command" "$platform")" || return 1
  sha="${kit%% *}" file="${kit#* }"
  substrate_on "$project" "$machine" "$entry" has-kit "$sha" </dev/null && return 0
  echo "$command: sending the Substrate kit ${sha:0:12} ($platform, $(( $(wc -c < "$file") / 1048576 )) MiB) to $machine" >&2
  substrate_on "$project" "$machine" "$entry" install-kit "$sha" < "$file" >/dev/null || { echo "$command: the Substrate kit could not be installed on $machine" >&2; return 1; }
}

substrate_lock() {
  local name="$3"
  [[ "$(substrate_host "$4")" != mac ]] || name=mac
  mkdir -p "$substrate_dir/locks" && chmod 700 "$substrate_dir"
  lock_on 7 "$substrate_dir/locks/$([[ $name == mac ]] && echo mac || echo "$2-$name").lock" "$1" "${SUBSTRATE_LOCK_TIMEOUT:-1800}"
}

substrate_record() {
  local project="$1" machine="$2"; shift 2
  local filter="${*: -1}"
  update_json --create "$substrate_projects/$project/substrate.json" --arg m "$machine" --arg at "$(ws_now)" "${@:1:$#-1}" ".[\$m] = ((.[\$m] // {}) | $filter)"
}
