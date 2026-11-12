#!/usr/bin/env bash
# Description: Write one file of a project's golden image definition, the content on stdin — vm:golden-write <project> <path in the golden-image folder>.
set -euo pipefail

# ASS-392 AC2: how grouped-blocked's Repair Image, a confined host agent
# (src/agents/confinement.js: it writes only temp, the harness's data only
# through agent.sh), edits the project's image definition — and nothing else
# on the Mac. The folder is project.json's golden-image.folder (golden.bash
# golden_definition); the path is relative to it: provision.sh,
# template.yaml, images.txt, warm.sh, tests.json, run-test.sh, ci-checks.json
# or another file of the definition, in a subfolder too. Refused, writing
# nothing:
#   - an absolute path, one with a .. or a dot-file part, or one that
#     resolves (a symlink) outside the folder: never another project's
#     files, the shared checkout or the operator's settings;
#   - an empty stdin: a file is changed, never emptied;
#   - while a build of the project's golden image runs (golden_status
#     building: golden-build.lock held, or golden-build-run.json's still
#     going) — it reads the definition, and its hash would not be what it built.
# The file is replaced through a temp file beside it, renamed over it, its
# mode kept (a new one is 0644). Prints { project, file, bytes }.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"

[[ $# -eq 2 ]] || { echo "usage: vm:golden-write <project> <path in the golden-image folder> (the content on stdin)" >&2; exit 1; }
project="$1" path="$2"
golden_definition vm:golden-write "$project"
[[ -n "$path" && "$path" != /* ]] || { echo "vm:golden-write: '$path' is not a path relative to $folder" >&2; exit 1; }
IFS=/ read -ra parts <<< "$path"
for part in "${parts[@]}"; do
  [[ -n "$part" && "$part" != .* ]] || { echo "vm:golden-write: '$path' has a '..', '.', dot-file or empty part: only files of $folder" >&2; exit 1; }
done
base="$(cd "$folder" && pwd -P)" prefix=""
for part in "${parts[@]}"; do   # no part a symlink, so nothing below resolves outside the folder
  prefix="$prefix/$part"
  [[ ! -L "$base$prefix" ]] || { echo "vm:golden-write: '$path' goes through a symlink, which may lead outside $folder: not written" >&2; exit 1; }
done
target="$base/$path"
[[ ! -d "$target" ]] || { echo "vm:golden-write: '$path' is a folder" >&2; exit 1; }
mkdir -p "$(dirname "$target")"
[[ "$(jq -r .status <<< "$(golden_status "$project")")" != building ]] \
  || { echo "vm:golden-write: golden-$project is being built now and reads its definition: wait for it (vm:golden-wait $project), then write" >&2; exit 1; }

tmp="$(mktemp "$target.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
[[ -s "$tmp" ]] || { echo "vm:golden-write: nothing on stdin: $path is not emptied" >&2; exit 1; }
if [[ -f "$target" ]]; then chmod "$(stat -f '%Lp' "$target" 2>/dev/null || stat -c '%a' "$target")" "$tmp"; else chmod 644 "$tmp"; fi
mv -f "$tmp" "$target"
jq -nc --arg p "$project" --arg f "$path" --argjson b "$(wc -c < "$target" | tr -d ' ')" '{ project: $p, file: $f, bytes: $b }'
