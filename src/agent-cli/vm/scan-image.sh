#!/usr/bin/env bash
# Description: Prove no configured token is in a project's golden image — vm:scan-image <project> [<instance>].
set -euo pipefail

# The manual proof of ASS-71 AC3, run after a golden image is built: reads
# every token the project declares (~/.harness/vm-credentials.json) from the
# keychain and searches each file of the stopped image, <LIMA_HOME>/golden-<project>/
# (its raw disk included, so deleted files count too), for each one. Tokens
# reach grep through a pipe, never a file or a command line; output names the
# kind and service of a token found, never its value. Exits 1 when any is
# found. The raw disk is read whole: about 2 minutes per 30 GiB.
# vm:build-golden runs it on the image it just built (<instance>, default
# golden-<project>) before recording it, passing the gh and glab tokens the
# build cloned with in SCAN_GH_TOKEN and SCAN_GL_TOKEN: searched for too.
# LIMA_HOME as lima-home.bash resolves it (ASS-273): the env var, else
# harness.local.json's lima-home (ASS-281), else harness.json's, else ~/.lima.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm-credentials.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../lima-home.bash"
LIMA_HOME="$(lima_home)"

[[ $# -eq 1 || $# -eq 2 ]] || { echo "usage: vm:scan-image <project> [<instance>]" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "vm:scan-image: invalid project '$1'" >&2; exit 1; }
[[ "${2:-golden-$1}" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "vm:scan-image: invalid instance '$2'" >&2; exit 1; }
project="$1" image="$LIMA_HOME/${2:-golden-$1}"
[[ -d "$image" ]] || { echo "vm:scan-image: no image $image" >&2; exit 1; }

decl="$(declared_credentials vm:scan-image "$project")"
read_tokens vm:scan-image "$project" "$decl"
[[ -z "${SCAN_GH_TOKEN:-}" ]] || { TOKENS[gh]="$SCAN_GH_TOKEN"; SERVICES[gh]="gh auth token"; }
[[ -z "${SCAN_GL_TOKEN:-}" ]] || { TOKENS[glab]="$SCAN_GL_TOKEN"; SERVICES[glab]="glab config get token"; }
[[ ${#TOKENS[@]} -gt 0 ]] || { echo "vm:scan-image: $project declares no token to look for"; exit 0; }

# grep_image <grep options…> — every regular file of the image holding a pattern (-l); patterns come on stdin.
grep_image() { find "$image" -type f -exec env LC_ALL=C grep -a -l -F "$@" -f /dev/stdin {} + || true; }

# One pass for all the tokens; only when something matches, one per token to name it.
if [[ -z "$(printf '%s\n' "${TOKENS[@]}" | grep_image)" ]]; then
  echo "vm:scan-image: no token found in $image ($(printf '%s\n' "${!TOKENS[@]}" | sort | paste -sd, - | sed 's/,/, /g'))"
  exit 0
fi
for kind in "${!TOKENS[@]}"; do
  while read -r file; do
    [[ -n "$file" ]] && echo "vm:scan-image: $kind's token (\"${SERVICES[$kind]}\") is in $file" >&2
  done < <(printf '%s\n' "${TOKENS[$kind]}" | grep_image)
done
exit 1
