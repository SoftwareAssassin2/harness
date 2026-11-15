#!/usr/bin/env bash
# Description: Write one file of a project's golden image definition — vm:golden-write <project> <path in the golden-image folder> [<file>], the content stdin's or <file>'s.
set -euo pipefail

# ASS-392 AC2: how grouped-blocked's Repair Image, a confined host agent
# (src/agents/confinement.js: it writes only temp, the harness's data only
# through agent.sh), edits the project's image definition — and nothing else
# on the Mac. The content is stdin's or, given <file> (ASS-428: a confined
# host agent can't pipe or redirect into agent.sh without re-sandboxing it, so
# it stages the content in a temp file of its own and passes the path, the
# call a bare one), that file's. The folder is project.json's
# golden-image.folder (golden.bash golden_definition); the path is relative
# to it: provision.sh, template.yaml, images.txt, warm.sh, tests.json,
# run-test.sh, ci-checks.json or another file of the definition, in a
# subfolder too. Refused, writing
# nothing:
#   - an absolute path, one with a .. or a dot-file part, or one that
#     resolves (a symlink) outside the folder: never another project's
#     files, the shared checkout or the operator's settings;
#   - a <file> that is no file, or an empty content: a file is changed,
#     never emptied.
# The file is replaced through a temp file beside it, renamed over it, its
# mode kept (a new one is 0644). Prints { project, file, bytes, queued }.
# ASS-427 AC3: while a build of the project's golden image runs (golden_status
# building: golden-build.lock held, or golden-build-run.json's still going) the
# definition is not touched — the build reads it, and its hash would not be
# what it built — so the write is queued instead (queued true): the content
# goes to data/projects/<project>/golden-queue/<path>, replacing one queued
# there before, and vm:golden-followup, which control runs every tick while
# anything is queued, writes it into the folder and starts the rebuild once
# the build has ended. Nobody waits for it. A write while no build runs drops
# a queued copy of the same file: the writer started from it (a queued file is
# the one to read first), so it is in this write.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"

[[ $# -eq 2 || $# -eq 3 ]] || { echo "usage: vm:golden-write <project> <path in the golden-image folder> [<file>] (the content on stdin, or in <file>)" >&2; exit 1; }
project="$1" path="$2" from=stdin
if [[ $# -eq 3 ]]; then
  from="$3"
  [[ -f "$from" ]] || { echo "vm:golden-write: no file $from: nothing written" >&2; exit 1; }
  exec < "$from"
fi
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
queue="$projects/$project/golden-queue" queued=false
if [[ "$(jq -r .status <<< "$(golden_status "$project")")" == building ]]; then   # ASS-427 AC3: queued, written once the build ends
  queued=true live="$target" target="$queue/$path"
  [[ ! -d "$target" ]] || { echo "vm:golden-write: '$path' is a folder" >&2; exit 1; }
  echo "vm:golden-write: golden-$project is being built now and reads its definition: $path is queued, written and rebuilt once that build ends (vm:golden-followup)" >&2
fi
mkdir -p "$(dirname "$target")"

tmp="$(mktemp "$target.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
[[ -s "$tmp" ]] || { echo "vm:golden-write: nothing on $from: $path is not emptied" >&2; exit 1; }
mode_of="$target"; [[ "$queued" == false || -f "$target" ]] || mode_of="$live"
if [[ -f "$mode_of" ]]; then chmod "$(stat -f '%Lp' "$mode_of" 2>/dev/null || stat -c '%a' "$mode_of")" "$tmp"; else chmod 644 "$tmp"; fi
mv -f "$tmp" "$target"
[[ "$queued" == true ]] || rm -f "$queue/$path"   # superseded: this write started from it
jq -nc --arg p "$project" --arg f "$path" --argjson b "$(wc -c < "$target" | tr -d ' ')" --argjson q "$queued" '{ project: $p, file: $f, bytes: $b, queued: $q }'
