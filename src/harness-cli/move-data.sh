#!/usr/bin/env bash
# Description: Move the harness's live data from the repo root into data/ (ASS-55) — move-data; run once, with the harness stopped.
set -euo pipefail

# The one-off cutover of ASS-55, run in the live checkout once its code expects
# the data in data/ (src/data-folder.js). It moves, from the root into data/:
# agent-names.json, agent-names-last-used.json, assignments.json, chats.json,
# harness.json (each with its .lock), last-model-used and the projects, agents
# and chats folders. A tracked path still at the root is moved with git mv;
# everything else with mv. A folder already in data/ (a pull of the merged
# code put the tracked files there) has the rest moved into it, file by file
# where both hold the same folder.
#
# Refuses, moving nothing, while anything could write the data: control, the
# dashboard or the downloader of this checkout (node <root>/src/…/main.js),
# a project's Hindsight (hindsight.pid) or zot (<ZOT_DIR>/<project>.pid), or a
# ticket VM mounting a folder under the old projects/ (its Lima ha.pid); or
# when a file is at both the old place and the new.
#
# Every file's sha256 (a link's target) is taken before and after, and must
# match. Then the paths the data holds of itself follow it — under
# <root>/projects/ they become <root>/data/projects/:
#  - Hindsight's embedded PostgreSQL instance (hindsight/.pg0/instances/*/instance.json);
#  - each project's Claude plugins (.claude/plugins/*.json, install paths);
#  - each project's Claude sessions of its own folder (.claude/projects/<folder,
#    every other character a dash>), as Claude Code names the folder of the
#    working directory a chat runs in, so a chat resumes;
#  - each ticket VM's mount in $LIMA_HOME/<vm>/lima.yaml (golden-* never).
# Last it prints each project's Claude login keychain item, old and new
# (ASS-47: Claude Code-credentials-<first 8 hex of sha256 of the config
# dir>): the keychain is not touched — log in again, or copy the item.
#
# Idempotent: run again, nothing is left to move and every fix-up is done.
# HARNESS_ROOT overrides the checkout (tests); LIMA_HOME and ZOT_DIR as the
# vm and registry commands take them — the Lima folder as lima-home.bash
# resolves it (ASS-273), from the checkout's harness.json, moved or not.
root="$(cd "${HARNESS_ROOT:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../..}" && pwd -P)"
data="$root/data"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../agent-cli/lima-home.bash"
lima_folder="$(lima_home "$([[ -f "$root/harness.json" ]] && echo "$root/harness.json" || echo "$data/harness.json")")"
zot_dir="${ZOT_DIR:-$HOME/Library/Application Support/harness/zot}"
names=(agent-names.json agent-names.json.lock agent-names-last-used.json agent-names-last-used.json.lock
  assignments.json assignments.json.lock chats.json chats.json.lock harness.json harness.json.lock
  last-model-used projects agents chats)

alive() { [[ "$1" =~ ^[0-9]+$ ]] && kill -0 "$1" 2>/dev/null; }
pid_in() { { tr -dc 0-9 < "$1"; } 2>/dev/null || true; }
refuse() { echo "move-data: $*; nothing moved" >&2; exit 1; }

# 1. Nothing may be writing the data.
while read -r pid command; do
  [[ "$command" =~ "$root"/src/(harness-cli/\.\./)?(control|tui|downloader)/main\.js ]] && refuse "$command is running (pid $pid): stop the harness first"
done < <(ps -axo pid=,command=)
for dir in "$root"/projects/*/ "$data"/projects/*/; do
  [[ -d "$dir" ]] || continue
  project="$(basename "$dir")"
  pid="$(pid_in "$dir/hindsight/hindsight.pid")"
  ! alive "$pid" || refuse "$project's Hindsight is running (pid $pid): kill it first"
  pid="$(pid_in "$zot_dir/$project.pid")"
  ! alive "$pid" || refuse "$project's zot is running (pid $pid): kill it first"
done
for yaml in "$lima_folder"/*/lima.yaml; do
  [[ -f "$yaml" ]] && grep -qF "location: $root/projects/" "$yaml" || continue
  vm="$(basename "$(dirname "$yaml")")" pid="$(pid_in "$(dirname "$yaml")/ha.pid")"
  ! alive "$pid" || refuse "VM $vm, mounting $root/projects/, is running (pid $pid): limactl stop it first"
done

# 2. What is left to move, and no file at both places.
present=()
for name in "${names[@]}"; do [[ -e "$root/$name" || -L "$root/$name" ]] && present+=("$name"); done
# sums <dir> — "<sha256, or -> its target>  <path>" for each file and link of
# $work/paths (relative), as it is under dir, by path.
sums() {
  (cd "$1" && {
    while IFS= read -r path; do [[ -L "$path" ]] || printf '%s\0' "$path"; done < "$work/paths" | xargs -0 shasum -a 256
    while IFS= read -r path; do [[ ! -L "$path" ]] || printf -- '-> %s  %s\n' "$(readlink "$path")" "$path"; done < "$work/paths"
  } | LC_ALL=C sort -k2)
}
work="$(mktemp -d "${TMPDIR:-/tmp}/move-data.XXXXXX")"
if (( ${#present[@]} )); then
  (cd "$root" && find "${present[@]}" -type f -o -type l) > "$work/paths"
  while IFS= read -r path; do
    [[ ! -e "$data/$path" && ! -L "$data/$path" ]] || refuse "$path is at both $root and $data: settle which to keep"
  done < "$work/paths"
  sums "$root" > "$work/before.sha256"

  # 3. The move: a whole folder or file when data/ has none of it, else into the folder there.
  tracked() { [[ -n "$(git -C "$root" ls-files -- "$1" 2>/dev/null | head -n 1)" ]]; }
  merge() {
    local from="$root/$1" to="$data/$1" child
    if [[ ! -e "$to" && ! -L "$to" ]]; then
      mkdir -p "$(dirname "$to")"
      if tracked "$1"; then git -C "$root" mv "$1" "data/$1"; else mv "$from" "$to"; fi
      [[ ! -e "$from" ]] || merge "$1"   # what git mv left behind, should it leave any, goes in beside it
    else
      for child in "$from"/* "$from"/.[!.]* "$from"/..?*; do [[ -e "$child" || -L "$child" ]] && merge "$1/$(basename "$child")"; done
      rmdir "$from"
    fi
  }
  mkdir -p "$data"
  for name in "${present[@]}"; do merge "$name"; done
  sums "$data" > "$work/after.sha256"
  cmp -s "$work/before.sha256" "$work/after.sha256" \
    || { diff "$work/before.sha256" "$work/after.sha256" >&2 || true; echo "move-data: the checksums after the move differ from before ($work); the data is in $data — check it before starting the harness" >&2; exit 1; }
  echo "Moved ${present[*]} into $data: $(wc -l < "$work/before.sha256" | tr -d ' ') files, checksums match ($work/before.sha256)."
else
  echo "Nothing to move: no harness data at $root."
fi

# 4. The paths the data holds of itself.
old="$root/projects/" new="$data/projects/"
for file in "$data"/projects/*/hindsight/.pg0/instances/*/instance.json "$data"/projects/*/.claude/plugins/*.json; do
  [[ -f "$file" ]] && grep -qF "$old" "$file" || continue
  OLD="$old" NEW="$new" perl -pi -e 's/\Q$ENV{OLD}\E/$ENV{NEW}/g' "$file"
  echo "Pointed $file at $new."
done
encode() { sed 's/[^A-Za-z0-9]/-/g' <<< "$1"; }
for sessions in "$data"/projects/*/.claude/projects; do
  [[ -d "$sessions" ]] || continue
  for dir in "$sessions/$(encode "$root/projects/")"*; do
    [[ -d "$dir" ]] || continue
    to="$sessions/$(encode "$data/projects/")${dir#"$sessions/$(encode "$root/projects/")"}"
    if [[ -e "$to" ]]; then echo "move-data: $to exists; left $dir as it is" >&2; else mv "$dir" "$to"; echo "Renamed $dir to $(basename "$to")."; fi
  done
done
for yaml in "$lima_folder"/*/lima.yaml; do
  [[ -f "$yaml" && "$(basename "$(dirname "$yaml")")" != golden-* ]] && grep -qF "location: $old" "$yaml" || continue
  OLD="location: $old" NEW="location: $new" perl -pi -e 's/\Q$ENV{OLD}\E/$ENV{NEW}/g' "$yaml"
  echo "Pointed $yaml's mount at $new."
done

# 5. The Claude logins, keyed by their path.
item() { echo "Claude Code-credentials-$(printf '%s' "$1" | shasum -a 256 | cut -c1-8)"; }
for config in "$data"/projects/*/.claude; do
  [[ -d "$config" ]] || continue
  project="$(basename "$(dirname "$config")")"
  echo "$project's Claude login: keychain item \"$(item "$root/projects/$project/.claude")\" is now looked up as \"$(item "$config")\" — log in again (CLAUDE_CONFIG_DIR=$config claude /login), or copy the item to its new name."
done
