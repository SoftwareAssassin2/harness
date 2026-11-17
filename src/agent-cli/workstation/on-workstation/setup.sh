#!/bin/bash
# The workstation's side of workstation:setup (ASS-434), run on a GCP
# workstation over its one connection, as the workstation's user, in its home:
#
#   bash -c "<this script>" workstation-setup <version> <forwarder-url> [<tool>…] [-- <command> <needed-by>…]
#
# (ASS-471) after --, pairs: a command the project's CI checks need
# (ci-checks.json, src/agent-cli/ci-check-commands.js) and the checks that
# need it, e.g. `static-policy-gate (example-project, example-corpus and 24
# more)`.
# stdin three lines: in-vm/agent.sh in base64, then the project's
# golden-image/workstation-tools.sh in base64 (an empty line without one),
# then (ASS-477) on-workstation/docker-credential-harness in base64;
# then (ASS-462) one line per golden-image file shipped beside it,
# `<name> <base64>`.
# Prints one JSON line, { ok, version, home, runtime, boot-id, did: [what it
# changed], failed: [{ what, why }] }, each failure said on stderr too, with
# whatever an installer printed; exits 1 when anything failed.
#
# Only /home survives a Cloud Workstation's restart (the rest is its config's
# container image again), so everything is installed under $HOME/harness and
# nothing outside it and the runtime folder is written (AC1, AC4):
#   ~/harness/bin     the harness's commands, first on PATH in its sessions:
#                     agent.sh (below), and jq and claude when setup installed them
#   ~/harness/lib     agent.sh itself, in-vm/agent.sh as a VM gets it
#   ~/harness/tools   what setup and the project's workstation-tools.sh download
#   ~/harness/golden-image  the project's workstation-tools.sh and the
#                     golden-image files shipped beside it (ASS-462), so it
#                     sources a file shared with provision.sh as on the host
#   ~/harness/env     sourced by the harness's sessions alone (ASS-435): PATH
#                     with ~/harness/bin first, HARNESS_RUNTIME, and the
#                     runtime folder's env (the credentials) when it holds one,
#                     and (ASS-477) DOCKER_CONFIG ~/harness/docker once it holds
#                     a config.json. The owner's shell files are never edited:
#                     their own sessions never see the harness's bin folder.
#   ~/harness/docker  (ASS-477) the harness's Docker config, when the project's
#                     registry has an Artifact Registry upstream
#                     (HARNESS_WS_REGISTRY, its host): the owner's
#                     ~/.docker/config.json with that host's credential helper
#                     ~/harness/bin/docker-credential-harness (the workstation's
#                     service account's token from the metadata server), its
#                     other entries linked (docker-credential-harness
#                     configure); removed when the project has no upstream.
#   ~/harness/setup.json  the setup last completed: { version, boot-id, runtime }
# Each file is written only when its content differs, and each tool installed
# only when it is not on PATH already, so a rerun with nothing missing changes
# nothing (did is empty).
#
# The runtime folder, where a VM's /run/harness things go on a workstation
# (agent-token, agent-url, the credentials): <root>/harness-<uid>, 0700 and
# the user's own (a symlink or anyone else's fails setup), <root> /dev/shm
# (tmpfs, as /run/harness is) when it is writable, else /tmp; both are the
# container's, gone at a restart. Not $XDG_RUNTIME_DIR: logind removes it when
# the user's last session ends, which a disconnect is, taking a running
# variation's token with it. It is emptied (made anew) whenever the
# workstation has started since the last completed setup — its boot id
# (/proc/sys/kernel/random/boot_id) differs from setup.json's, or the folder
# has no `ready` marker — and never otherwise, so a rerun for a new version
# leaves a running agent's token alone. agent-url is the forwarder on the
# workstation's loopback, reverse-forwarded there by the connection (ASS-433).
#
# What an agent needs (AC1): git, curl and base64 are checked (the config's
# image must have them: they cannot go under $HOME without them); rsync
# (ASS-435: the ticket's read-only copy comes by it) installed with
# passwordless sudo from packages kept under ~/harness/tools/debs when missing; jq is
# installed when missing (its static release binary); the Claude Code CLI when
# missing (claude.ai's installer, with HOME pointed at ~/harness/tools/claude
# so it writes nothing of the owner's); agent.sh; Docker checked (`docker
# info` answering: whether it works is the workstation config's, so it is
# never installed); bats when the project's tools name it (ASS-474: its release
# tarball, under ~/harness/tools/bats); and each of the project's golden-image tools on PATH, the
# missing ones handed to the project's workstation-tools.sh (written to
# ~/harness/golden-image with its shipped files, run in ~/harness/tools with HARNESS_BIN and HARNESS_TOOLS set, the tools as its
# arguments; it installs them under $HOME), then checked again. Anything
# missing after that fails setup, named (AC3). ASS-471: so is each command the
# project's CI checks need, checked and handed to workstation-tools.sh with the
# tools; one still missing fails setup naming it and the checks that need it,
# so the gap shows here, not as a ticket's CI Checks step exiting 127.
#
# Tests stand a folder in for the workstation (test/support/fake-ssh.js):
# HARNESS_WS_BOOT_ID, HARNESS_WS_RUNTIME_ROOT, HARNESS_WS_JQ_URL and
# HARNESS_WS_CLAUDE_INSTALLER replace the boot id, the runtime folder's root
# and the two download URLs (HARNESS_WS_BATS_URL bats's, ASS-474). A real ssh session never carries them.
set -uo pipefail
umask 077
version="$1" url="$2"; shift 2
tools=() needs=() needed_by=()
while [[ $# -gt 0 && "$1" != -- ]]; do tools+=("$1"); shift; done
[[ $# -eq 0 ]] || shift
while [[ $# -ge 2 ]]; do needs+=("$1") needed_by+=("$2"); shift 2; done
H="$HOME/harness" B="$HOME/harness/bin" L="$HOME/harness/lib" T="$HOME/harness/tools"
export PATH="$B:$PATH"
did=() failed=()
done_() { did+=("$1"); }
bad() { failed+=("$1"$'\t'"$2"); echo "workstation setup: $1: $2" >&2; }
has() { command -v "$1" >/dev/null 2>&1; }

json_str() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/\\t}"; s="${s//$'\r'/}"
  printf '"%s"' "$s"
}
json_list() { local out="" x; for x in "$@"; do out+="${out:+,}$(json_str "$x")"; done; printf '[%s]' "$out"; }

finish() {
  local f out="" ok=true
  for f in "${failed[@]+"${failed[@]}"}"; do out+="${out:+,}{\"what\":$(json_str "${f%%$'\t'*}"),\"why\":$(json_str "${f#*$'\t'}")}"; done
  [[ ${#failed[@]} -eq 0 ]] || ok=false
  printf '{"ok":%s,"version":%s,"home":%s,"runtime":%s,"boot-id":%s,"did":%s,"failed":[%s]}\n' \
    "$ok" "$(json_str "$version")" "$(json_str "$HOME")" "$(json_str "${R-}")" "$(json_str "${boot-}")" "$(json_list "${did[@]+"${did[@]}"}")" "$out"
  [[ "$ok" == true ]]
  exit
}

# put <file> <mode> — stdin written to <file> when it differs from it (a temp
# file beside, renamed over); 0 when written, 1 when it was the same already.
put() {
  local tmp
  tmp="$(mktemp "$1.XXXXXX")" || return 2
  cat > "$tmp"
  if [[ -f "$1" ]] && cmp -s "$tmp" "$1"; then rm -f "$tmp"; return 1; fi
  chmod "$2" "$tmp" && mv -f "$tmp" "$1"
}

# first_line <text> — its first non-empty line, at most 200 characters.
first_line() { local l; l="$(printf '%s\n' "$1" | grep -m1 -v '^[[:space:]]*$')"; printf '%s' "${l:0:200}"; }

IFS= read -r agent_b64 || true
IFS= read -r tools_b64 || true
IFS= read -r helper_b64 || true
files=()
while IFS=' ' read -r name b64 || [[ -n "${name-}" ]]; do [[ -z "$name" ]] || files+=("$name" "$b64"); done
mkdir -p "$H" "$B" "$L" "$T" || { bad "$H" "could not be made"; finish; }
chmod 700 "$H"

# The runtime folder, emptied once after each start.
boot="${HARNESS_WS_BOOT_ID:-$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)}"
boot="${boot:-unknown}"
root="${HARNESS_WS_RUNTIME_ROOT:-}"
if [[ -z "$root" ]]; then if [[ -d /dev/shm && -w /dev/shm ]]; then root=/dev/shm; else root=/tmp; fi; fi
R="$root/harness-$(id -u)"
recorded="$(sed -n 's/.*"boot-id":"\([^"]*\)".*/\1/p' "$H/setup.json" 2>/dev/null)"
if [[ -L "$R" ]] || { [[ -e "$R" ]] && [[ ! -O "$R" || ! -d "$R" ]]; }; then
  bad "runtime folder" "$R is not a folder of the workstation user's own; remove it"
  finish
fi
if [[ "$recorded" != "$boot" || ! -f "$R/ready" ]]; then
  rm -rf "$R" && mkdir -m 700 "$R" || { bad "runtime folder" "$R could not be made"; finish; }
  done_ "made the runtime folder $R (the workstation started since its last setup)"
fi
chmod 700 "$R"
printf '%s\n' "$url" | put "$R/agent-url" 600 && done_ "wrote the forwarder's URL ($url) to $R/agent-url"

# rsync, when missing: the ticket's read-only copy is pushed with it (ASS-435),
# and an image may lack it (example-config's Ubuntu 24.04 does). Only
# /home survives a restart, so its packages (rsync and libpopt0, its one
# library the image lacks) are kept in ~/harness/tools/debs and installed from
# there with passwordless sudo at each start, in seconds; the first time, with
# no packages kept yet, `apt-get download` fetches them there (the package
# lists refreshed first when it cannot find them: about 100 s, once). Without
# passwordless sudo it fails as any missing tool does.
if ! has rsync; then
  debs="$T/debs"
  rsync_said=1
  if ! sudo -n true 2>/dev/null; then bad rsync "not installed, and there is no passwordless sudo to install it"
  elif out="$( { compgen -G "$debs/rsync_*.deb" >/dev/null || { mkdir -p "$debs" && cd "$debs" && { apt-get download rsync libpopt0 2>&1 || { sudo -n apt-get update -qq 2>&1 && apt-get download rsync libpopt0 2>&1; }; }; }; } \
      && sudo -n env DEBIAN_FRONTEND=noninteractive dpkg -i "$debs"/*.deb 2>&1 && hash -r && rsync --version 2>&1)"; then
    done_ "installed rsync (sudo dpkg -i, its packages kept in $debs)"
  else
    printf '%s\n' "$out" >&2
    bad rsync "could not be installed (apt-get download, sudo dpkg -i): $(first_line "$out")"
  fi
  has rsync && rsync_said=""
fi

# What the image must have.
for c in git curl base64 rsync; do
  [[ "$c" == rsync && -n "${rsync_said-}" ]] && continue   # its failure said above
  has "$c" || bad "$c" "not installed: the workstation config's container image must have it (setup installs nothing outside \$HOME but rsync, above)"
done

# jq: its static release binary, when missing.
if ! has jq; then
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) arch="" ;; esac
  jq_url="${HARNESS_WS_JQ_URL:-https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-$arch}"
  if [[ -z "$arch" && -z "${HARNESS_WS_JQ_URL-}" ]]; then bad jq "not installed, and there is no jq release for $(uname -m)"
  elif ! has curl; then bad jq "not installed, and cannot be without curl"
  elif out="$(mkdir -p "$T/jq" && curl -fsSL --retry 3 -o "$T/jq/jq.part" "$jq_url" 2>&1 && chmod 755 "$T/jq/jq.part" && mv -f "$T/jq/jq.part" "$T/jq/jq" && ln -sfn "$T/jq/jq" "$B/jq" && hash -r && jq --version 2>&1)"; then
    done_ "installed jq ($B/jq)"
  else
    bad jq "could not be installed from $jq_url: $(first_line "$out")"
  fi
fi

# bats (ASS-474), when the project's golden-image tools name it and it is missing: a project's static
# policy gate runs bats suites (as provision.sh's apt install gives its VMs), and the workstation's image
# has none. bats-core is bash alone, so its release tarball is unpacked under ~/harness/tools/bats and
# its bin/bats (which finds its libexec through the link) linked into ~/harness/bin — no root, no
# workstation-tools.sh of the project's needed for it. HARNESS_WS_BATS_URL replaces the URL in tests.
if [[ " ${tools[*]-} " == *" bats "* ]] && ! has bats; then
  bats_url="${HARNESS_WS_BATS_URL:-https://github.com/bats-core/bats-core/archive/refs/tags/v1.11.1.tar.gz}"
  if ! has curl || ! has tar; then bad bats "not installed, and cannot be without curl and tar"
  elif out="$(rm -rf "$T/bats.part" && mkdir -p "$T/bats.part" && curl -fsSL --retry 3 "$bats_url" 2>&1 | tar -xzf - -C "$T/bats.part" --strip-components=1 2>&1 \
      && [[ -x "$T/bats.part/bin/bats" ]] && rm -rf "$T/bats" && mv -f "$T/bats.part" "$T/bats" && ln -sfn "$T/bats/bin/bats" "$B/bats" && hash -r && bats --version 2>&1)"; then
    done_ "installed bats ($B/bats)"
  else
    rm -rf "$T/bats.part"
    bad bats "could not be installed from $bats_url: $(first_line "${out:-no bin/bats in it}")"
  fi
fi

# The Claude Code CLI, when missing: its installer run with HOME at ~/harness/tools/claude.
if ! has claude; then
  installer="${HARNESS_WS_CLAUDE_INSTALLER:-https://claude.ai/install.sh}"
  if ! has curl; then bad claude "not installed, and cannot be without curl"
  elif out="$(mkdir -p "$T/claude" && curl -fsSL --retry 3 -o "$T/claude/install.sh" "$installer" 2>&1 \
      && (cd "$T/claude" && HOME="$T/claude" bash "$T/claude/install.sh" </dev/null 2>&1) \
      && ln -sfn "$T/claude/.local/bin/claude" "$B/claude" && hash -r && claude --version 2>&1)"; then
    done_ "installed the Claude Code CLI ($B/claude)"
  else
    printf '%s\n' "$out" >&2
    bad claude "the Claude Code CLI could not be installed from $installer: $(first_line "$out")"
  fi
fi

# agent.sh: the VM's client, and a wrapper giving it the runtime folder's URL and token.
if [[ -z "$agent_b64" ]]; then bad agent.sh "workstation:setup sent no agent.sh"
else
  printf '%s' "$agent_b64" | base64 -d | put "$L/agent.sh" 755 && done_ "installed agent.sh ($L/agent.sh)"
  put "$B/agent.sh" 755 <<EOF && done_ "installed agent.sh's wrapper ($B/agent.sh)"
#!/bin/bash
# agent.sh on this workstation (ASS-434, written by the harness's
# workstation:setup): ~/harness/lib/agent.sh, the VM's, reaching the forwarder
# on this workstation's loopback with the token in the runtime folder.
export AGENT_FORWARDER_URL="\${AGENT_FORWARDER_URL:-\$(cat $(printf '%q' "$R/agent-url") 2>/dev/null)}"
export AGENT_TOKEN_FILE="\${AGENT_TOKEN_FILE:-$(printf '%q' "$R/agent-token")}"
exec "\$HOME/harness/lib/agent.sh" "\$@"
EOF
fi

# The harness's sessions' environment; never the owner's shell files.
put "$H/env" 644 <<EOF && done_ "wrote the harness's session environment ($H/env)"
# The harness's sessions on this workstation source this (ASS-434, written by
# workstation:setup); the owner's own shells never do.
export HARNESS_RUNTIME=$(printf '%q' "$R")
case ":\$PATH:" in *":\$HOME/harness/bin:"*) ;; *) export PATH="\$HOME/harness/bin:\$PATH" ;; esac
export DISABLE_AUTOUPDATER=1
if [ -r "\$HARNESS_RUNTIME/env" ]; then set -a; . "\$HARNESS_RUNTIME/env"; set +a; fi
if [ -r "\$HOME/harness/docker/config.json" ]; then export DOCKER_CONFIG="\$HOME/harness/docker"; fi
EOF

# ASS-477: the agents' own pulls from the project's Artifact Registry (docker pull, docker compose up, devcontainer
# builds) as the workstation's service account, not the owner's gcloud login, which lapses under Workspace session
# control: the credential helper installed, the harness's Docker config written from the owner's (configure, rerun
# at each step's claim to follow the owner's changes), and the helper checked to get a token from the metadata server
# — a failure fails setup naming it, as a missing tool does. The token itself never reaches the output.
if [[ -z "$helper_b64" ]]; then bad docker-credential-harness "workstation:setup sent no docker-credential-harness"
else
  printf '%s' "$helper_b64" | base64 -d | put "$B/docker-credential-harness" 755 && done_ "installed the harness's Docker credential helper ($B/docker-credential-harness)"
  registry="${HARNESS_WS_REGISTRY-}"
  if [[ -n "$registry" ]]; then
    was="$(cat "$H/docker/config.json" 2>/dev/null)"
    if ! out="$(docker-credential-harness configure "$registry" 2>&1)"; then bad "Docker config" "the harness's ($H/docker) could not be written: $(first_line "$out")"
    else
      [[ -z "$out" ]] || printf '%s\n' "$out" >&2
      [[ "$(cat "$H/docker/config.json" 2>/dev/null)" == "$was" ]] || done_ "wrote the harness's Docker config ($H/docker), $registry's credentials the workstation's service account's"
    fi
    out="$(printf '%s\n' "$registry" | docker-credential-harness get 2>&1)"
    grep -q '"Secret":"[^"]' <<< "$out" || bad docker-credential-harness "gets no token for $registry: $(first_line "$out")"
    out=""
  elif [[ -d "$H/docker" ]]; then
    rm -rf "$H/docker" && done_ "removed the harness's Docker config ($H/docker): the project's registry has no upstream"
  fi
fi

# Docker: the workstation config's to give; checked, never installed.
if ! has docker; then
  bad docker "not installed: the workstation config's container image has no Docker, which the project's dev containers and zot images need"
else
  if has timeout; then out="$(timeout 30 docker info --format '{{.ServerVersion}}' 2>&1)"; else out="$(docker info --format '{{.ServerVersion}}' 2>&1)"; fi
  [[ $? -eq 0 ]] || bad docker "not usable (docker info failed): $(first_line "$out")"
fi

# The project's golden-image tools and (ASS-471) the commands its CI checks need: the missing ones to its
# workstation-tools.sh, then checked. A command's failure says which checks need it.
missing=()
for t in "${tools[@]+"${tools[@]}"}" "${needs[@]+"${needs[@]}"}"; do
  [[ " ${missing[*]-} " == *" $t "* ]] || has "$t" || missing+=("$t")
done
needed() { local i; for ((i = 0; i < ${#needs[@]}; i++)); do [[ "${needs[i]}" != "$1" ]] || { printf "; ci-checks.json's %s needs it" "${needed_by[i]}"; return; }; done; }
if [[ ${#missing[@]} -gt 0 ]]; then
  if [[ -z "$tools_b64" ]]; then
    for t in "${missing[@]}"; do bad "$t" "not on the workstation, and the project has no golden-image/workstation-tools.sh to install it under \$HOME$(needed "$t")"; done
  else
    G="$H/golden-image" rc=0
    rm -f "$H/workstation-tools.sh"
    rm -rf "$G" && mkdir -m 700 "$G" || rc=$?
    for ((i = 0; rc == 0 && i < ${#files[@]}; i += 2)); do
      n="${files[i]}"
      [[ "$n" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ && "$n" != workstation-tools.sh ]] || { echo "workstation setup: '$n' is not a plain golden-image file name" >&2; rc=1; break; }
      printf '%s' "${files[i+1]}" | base64 -d | put "$G/$n" 600 || rc=$?
    done
    [[ $rc -ne 0 ]] || { printf '%s' "$tools_b64" | base64 -d | put "$G/workstation-tools.sh" 700; rc=$?; }
    if [[ $rc -eq 0 ]]; then
      (cd "$T" && HARNESS_BIN="$B" HARNESS_TOOLS="$T" bash "$G/workstation-tools.sh" "${missing[@]}" </dev/null >&2)
      rc=$?
    fi
    hash -r
    done_ "ran the project's workstation-tools.sh for ${missing[*]} (exit $rc)"
    for t in "${missing[@]}"; do has "$t" || bad "$t" "could not be installed: not on PATH after the project's golden-image/workstation-tools.sh (exit $rc)$(needed "$t")"; done
  fi
fi

# ASS-468 AC6: the folders ASS-435 gave each ticket variation, ~/harness/<KEY>-<variation>, are no longer made — the
# variations share ~/harness/repos, a step at a time — so any left over is removed, but the one a holder from
# before ASS-468 still records (HARNESS_KEEP_FOLDER: workstation:release pushes its committed work first).
for f in "$H"/*; do
  n="${f##*/}"
  [[ -d "$f" && ! -L "$f" && "$n" =~ ^[A-Z][A-Z0-9]*-[0-9]+-[A-Za-z0-9]+$ && "$f" != "${HARNESS_KEEP_FOLDER-}" ]] || continue
  chmod -R u+w "$f" 2>/dev/null; rm -rf "$f" && done_ "removed $f, a ticket variation's folder from before ASS-468"
done

[[ ${#failed[@]} -eq 0 ]] || finish
printf '{"version":%s,"boot-id":%s,"runtime":%s}\n' "$(json_str "$version")" "$(json_str "$boot")" "$(json_str "$R")" \
  | put "$H/setup.json" 600 && done_ "recorded setup ${version:0:12} in $H/setup.json"
[[ -f "$R/ready" ]] || : > "$R/ready"
finish
