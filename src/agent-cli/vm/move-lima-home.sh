#!/usr/bin/env bash
# Description: Move a project's golden image(s) and ticket VMs to another Lima folder, while the harness is stopped, and set its project.json lima-home — vm:move-lima-home <project> <folder> [--dry-run]; prints what it moved (or, with --dry-run, would move).
set -euo pipefail

# ASS-578. A project may keep its Lima VMs and golden image in a folder of its
# own (project.json lima-home, lima-home.bash), say on a disk of its own. This
# moves them there from the folder they are in now (lima_home <project>: its
# lima-home, else the harness-wide one):
#   - its instances: golden-<project>, a leftover golden-<project>-build, its
#     vm:test-repos VMs (test-<project>-<n>), and its ticket VMs (its
#     inventory, vms.json, and those its active sprint's variations record);
#   - refused, moving nothing, while the harness runs (a live pid file under
#     HARNESS_HOME — run-tui.pid, run-<project>.pid, run.pid, run-downloader.pid
#     — or this checkout's control, dashboard or downloader in ps), while a
#     golden image build of the project runs, while any of those instances is
#     not Stopped, or when the target already has one of their names;
#   - the space first: on another volume each instance is copied whole (an APFS
#     clone of the golden disk becomes a full copy: clones can't cross volumes),
#     so it needs what each one allocates (du), and refuses unless the target's
#     volume keeps disk-free-hold-gb free after it; on the same volume each is
#     renamed into place (no space, the clones kept);
#   - copied sparse-aware: macOS cp (copyfile, which skips a disk's holes),
#     file by file into <folder>/_harness-move/<instance> (a name Lima never
#     lists), sockets and pid files left out (a stopped instance has none that
#     matter); then checked — every file there, with the same size, the small
#     ones byte for byte (cmp) — and renamed into place;
#   - each moved instance then checked with limactl list under the new folder
#     (it must say Stopped); only then is the project's lima-home set (removed
#     when the folder is the harness-wide one, so it follows that setting) and
#     the old copies deleted;
#   - Lima's own config: a new folder gets Lima's _config/user and user.pub
#     (the SSH key every instance in the old folder was given at its creation)
#     and networks.yaml copied from the old folder when it has none, so a moved
#     VM accepts SSH as before (Lima makes a new key in a folder without one,
#     which the instances already made would not know).
# --dry-run prints the plan and moves nothing; it exits 1 when the move would be
# refused. Under the project's VM lock throughout. Prints { project, from, to,
# same-volume, instances: [{ name, bytes }], need-bytes, free-bytes, hold-bytes,
# dry-run, lima-home } — lima-home what project.json says after it (null: unset).
# A failure part way leaves every old copy in place (a staged copy is removed),
# and the project's lima-home as it was. MOVE_LIMA_FORCE_COPY=1 copies although
# both folders are on one volume (tests).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm.bash"
command=vm:move-lima-home

usage() { echo "usage: $command <project> <folder> [--dry-run]" >&2; exit 1; }
[[ $# -eq 2 || ( $# -eq 3 && "$3" == --dry-run ) ]] || usage
project="$1" to="${2%/}" dry="${3:-}"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$projects/$project/project.json" ]] || { echo "$command: no project '$project'" >&2; exit 1; }
[[ "$to" == /* ]] || { echo "$command: the folder must be an absolute path: '$2'" >&2; exit 1; }
refuse() { echo "$command: $*; nothing moved" >&2; exit 1; }
from="$(lima_home "$project")" || refuse "its Lima folder can't be used"
from="${from%/}"
home="${HARNESS_HOME:-$HOME/.harness}"

# 1. The harness must be stopped.
alive_harness() {
  local file pid
  for file in "$home"/run.pid "$home"/run-*.pid; do
    [[ -f "$file" ]] || continue
    pid="$(tr -dc 0-9 < "$file")"
    [[ -n "$pid" ]] && ps -o command= -p "$pid" 2>/dev/null | grep -q 'main\.js' && { echo "$(basename "$file") names pid $pid"; return 0; }
  done
  local root; root="$(cd "$here_vm/../.." && pwd -P)"
  while read -r pid line; do
    [[ "$line" =~ "$root"/src/(control|tui|downloader)/main\.js ]] && { echo "$line (pid $pid)"; return 0; }
  done < <(ps -axo pid=,command=)
  return 1
}
if running="$(alive_harness)"; then refuse "the harness is running ($running): stop it first"; fi

# 2. The target.
mkdir -p "$to" 2>/dev/null || refuse "could not make $to"
[[ -w "$to" ]] || refuse "$to is not writable"
to="$(cd "$to" && pwd -P)"
[[ "$(cd "$from" 2>/dev/null && pwd -P)" != "$to" ]] || refuse "$project's VMs are in $to already"

lock_vms "$command" "$project"
! build_in_progress "$project" || refuse "a golden image build of $project is running"

# 3. The project's instances in the old folder.
names=("golden-$project" "golden-$project-build")
while IFS= read -r name; do names+=("$name"); done < <(
  { jq -r 'keys[]' "$projects/$project/vms.json" 2>/dev/null || true
    sprint="$(sprint_file "$command" "$project" 2>/dev/null)" && jq -r '(.features, .bugs, .spikes) // [] | .[] | .variations // [] | .[]
      | .vm // empty | select((.kind // "lima") == "lima") | .name // empty' "$sprint" 2>/dev/null || true
    for dir in "$from"/test-"$project"-*; do [[ ! -d "$dir" ]] || basename "$dir"; done
  } | awk 'NF && !seen[$0]++')
instances=()
for name in "${names[@]}"; do
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ && -d "$from/$name" ]] || continue
  [[ " ${instances[*]-} " == *" $name "* ]] || instances+=("$name")
done
[[ ${#instances[@]} -gt 0 ]] || echo "$command: $project has no instance in $from; only its lima-home is set" >&2
for name in ${instances[@]+"${instances[@]}"}; do
  status="$(LIMA_HOME="$from" lima_status "$name" 2>/dev/null || echo unknown)"
  [[ "$status" == Stopped ]] || refuse "$name is $status, not stopped: stop it first (vm:stop $project $name)"
  [[ ! -e "$to/$name" ]] || refuse "$to holds a $name already"
done

# 4. The space.
same=false
[[ "$(stat -f %d "$from")" != "$(stat -f %d "$to")" || -n "${MOVE_LIMA_FORCE_COPY:-}" ]] || same=true
need=0 sizes="[]"
for name in ${instances[@]+"${instances[@]}"}; do
  bytes=$(( $(du -sk "$from/$name" | cut -f1) * 1024 ))
  sizes="$(jq -c --arg n "$name" --argjson b "$bytes" '. + [{ name: $n, bytes: $b }]' <<<"$sizes")"
  need=$(( need + bytes ))
done
[[ "$same" == false ]] || need=0
read -r warn hold < <(disk_levels "$command") || exit 1
line="$(volume_of "$to" 2>&1)" || refuse "$line"
free="${line%%$'\t'*}"
setting="$to"
[[ "$to" != "$(cd "$(lima_home_default)" 2>/dev/null && pwd -P || lima_home_default)" ]] || setting=""
plan() {
  jq -n --arg p "$project" --arg from "$from" --arg to "$to" --argjson same "$same" --argjson i "$sizes" --argjson need "$need" \
    --argjson free "$free" --argjson hold "$hold" --argjson dry "$( [[ -n "$dry" ]] && echo true || echo false)" --arg set "$setting" \
    '{ project: $p, from: $from, to: $to, "same-volume": $same, instances: $i, "need-bytes": $need, "free-bytes": $free, "hold-bytes": $hold,
       "dry-run": $dry, "lima-home": (if $set == "" then null else $set end) }'
}
if (( free - need < hold )); then
  [[ -z "$dry" ]] || plan
  refuse "$to's volume has $(gib "$free") GiB free; the copies need $(gib "$need") GiB (each instance whole: clones become full copies on another volume) and $(gib "$hold") GiB must stay free (disk-free-hold-gb)"
fi
if [[ -n "$dry" ]]; then plan; exit 0; fi

# 5. Lima's own config, from the old folder when the new one has none.
mkdir -p "$to/_config"
for file in user user.pub networks.yaml; do
  [[ -e "$to/_config/$file" || ! -f "$from/_config/$file" ]] || cp -p "$from/_config/$file" "$to/_config/$file"
done

# 6. Each instance copied (or renamed), checked, put in place.
stage="$to/_harness-move"
moved=()
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
# undo — the copies made so far removed (the old ones untouched), on a failure before the switch.
undo() {
  local name
  for name in ${moved[@]+"${moved[@]}"}; do
    if [[ "$same" == true ]]; then mv "$to/$name" "$from/$name" 2>/dev/null || echo "$command: could not move $name back from $to to $from: do it by hand" >&2
    else rm -rf "${to:?}/$name"; fi
  done
}
fail() { undo; refuse "$*"; }
# copy_tree <from> <to> — every folder, regular file (sparse-aware: cp, i.e. copyfile) and link; sockets, fifos and pid files left out.
copy_tree() {
  local src="$1" dst="$2" path rel
  mkdir -p "$dst"
  while IFS= read -r -d '' path; do
    rel="${path#"$src"/}"
    if [[ -L "$path" ]]; then cp -pP "$path" "$dst/$rel" || return 1
    elif [[ -d "$path" ]]; then mkdir -p "$dst/$rel"
    elif [[ -f "$path" && "$path" != *.pid ]]; then cp -p "$path" "$dst/$rel" || return 1
    fi
  done < <(find "$src" -mindepth 1 -print0)
}
# same_tree <from> <to> — every regular file of <from> (pid files aside) is in <to> with its size; those under 64 MiB byte for byte.
same_tree() {
  local src="$1" dst="$2" path rel size
  while IFS= read -r -d '' path; do
    rel="${path#"$src"/}"
    [[ "$path" != *.pid ]] || continue
    [[ -f "$dst/$rel" && ! -L "$dst/$rel" ]] || { echo "$rel is missing"; return 1; }
    size="$(stat -f %z "$path")"
    [[ "$(stat -f %z "$dst/$rel")" == "$size" ]] || { echo "$rel differs in size"; return 1; }
    (( size >= 64 * 1048576 )) || cmp -s "$path" "$dst/$rel" || { echo "$rel differs"; return 1; }
  done < <(find "$src" -type f -print0)
}
for name in ${instances[@]+"${instances[@]}"}; do
  if [[ "$same" == true ]]; then
    mv "$from/$name" "$to/$name" || fail "could not move $name into $to"
    moved+=("$name")
    echo "$command: moved $name to $to (same volume: renamed)" >&2
    continue
  fi
  started=$SECONDS
  rm -rf "${stage:?}/$name"
  copy_tree "$from/$name" "$stage/$name" || fail "could not copy $name to $to"
  why="$(same_tree "$from/$name" "$stage/$name")" || fail "the copy of $name in $to is not whole: $why"
  mv "$stage/$name" "$to/$name" || fail "could not put $name in place in $to"
  moved+=("$name")
  echo "$command: copied $name to $to ($(gib "$(jq --arg n "$name" 'first(.[] | select(.name == $n)) | .bytes' <<<"$sizes")") GiB, $((SECONDS - started))s)" >&2
done
rm -rf "$stage"

# 7. Lima sees each one in the new folder, stopped.
for name in ${moved[@]+"${moved[@]}"}; do
  status="$(LIMA_HOME="$to" lima_list "$name" --format '{{.Status}}' 2>/dev/null || true)"
  [[ "$status" == Stopped ]] || fail "limactl list in $to says $name is '${status:-missing}', not Stopped"
done

# 8. The switch: lima-home set, then the old copies deleted.
if [[ -n "$setting" ]]; then update_json "$projects/$project/project.json" --arg h "$setting" '.["lima-home"] = $h' || fail "could not set $project's lima-home"
else update_json "$projects/$project/project.json" 'del(.["lima-home"])' || fail "could not unset $project's lima-home"; fi
if [[ "$same" == false ]]; then
  for name in ${moved[@]+"${moved[@]}"}; do
    rm -rf "${from:?}/$name" || echo "$command: could not delete the old $from/$name: delete it by hand" >&2
  done
fi
unlock_vms
plan
