#!/usr/bin/env bash
# Description: Install a project preset bundle from export-project — install-project <bundle> --project-root <folder> [--lima-home <folder>] [--force]; prints the setup steps left.
set -euo pipefail

# The other half of export-project (ASS-274; its header documents the bundle
# and manifest format 1). Non-interactive, so it runs the same with or
# without Claude; the /install skill (.claude/skills/install/SKILL.md) talks a
# person through it and the steps it leaves (ASS-275). For the bundle's
# project <project> it:
#   - writes data/projects/<project>/project.json from the bundle's, every
#     "{project-root}" (local-pc's folder) the --project-root folder,
#     registry.storage-path "projects/<project>/registry" and
#     golden-image.folder "projects/<project>/golden-image", as the harness
#     keeps them relative to data/;
#   - copies golden-image/, engines/ (the project's own state engines,
#     ASS-276) and the merge-request notes into data/projects/<project>/,
#     a folder the bundle has replacing the installed one;
#   - sets lima-home (ASS-273) in the untracked harness.local.json (ASS-281:
#     a machine's own settings, so the tracked harness.json never changes) to
#     --lima-home, made absolute (its ~ is never expanded); without it an
#     absolute lima-home already set there, else in harness.json, is kept,
#     else it is ~/.lima;
#   - writes the bundle's credentials template, its placeholders as they are,
#     to ~/.harness/vm-credentials.json at .["<project>"], other projects'
#     entries kept and the file backed up first to
#     vm-credentials.json.backup-<UTC time>. A project the file already
#     declares keeps its entry, said so, unless --force. The keychain is never
#     touched;
#   - prints the manifest's setup steps left, in its order, and the
#     placeholders still to fill.
#
# Fails, changing nothing, for a missing file or one that is not a bundle (not
# a gzipped tarball, an entry outside it or a link, no manifest.json, a file
# the manifest lists missing, a project name that is not a folder name), a
# manifest format other than 1, a state engine neither in the bundle's
# engines/ (its project-engines) nor this harness's engines/, a project root
# that is missing or not a git checkout's top folder, or a project already
# installed (its project.json) without --force. Every check runs before the
# first write.
#
# PROJECTS_DIR, ENGINES_DIR, HARNESS_FILE and HARNESS_LOCAL_FILE override
# data/projects, engines/, data/harness.json and the harness.local.json beside
# it, HOME the folder of .harness/vm-credentials.json (tests).
root="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd -P)"
source "$root/src/agent-cli/engine.bash"      # engines_dir
source "$root/src/agent-cli/json-file.bash"   # update_json, replace_file
projects_dir="${PROJECTS_DIR:-$root/data/projects}"
harness_file="${HARNESS_FILE:-$root/data/harness.json}"
local_file="${HARNESS_LOCAL_FILE:-$(dirname "$harness_file")/harness.local.json}"
credentials_file="$HOME/.harness/vm-credentials.json"

usage() { echo "usage: install-project <bundle> --project-root <folder> [--lima-home <folder>] [--force]" >&2; exit 1; }
fail() { echo "install-project: $*; nothing changed" >&2; exit 1; }

bundle="" project_root="" lima_home="" force=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root) [[ $# -ge 2 ]] || usage; project_root="$2"; shift 2 ;;
    --lima-home) [[ $# -ge 2 && -n "$2" ]] || usage; lima_home="$2"; shift 2 ;;
    --force) force=true; shift ;;
    -*) usage ;;
    *) [[ -z "$bundle" ]] || usage; bundle="$1"; shift ;;
  esac
done
[[ -n "$bundle" && -n "$project_root" ]] || usage

# absolute <path> — the path, a leading ~ expanded, made absolute from here;
# an existing folder (or one whose parent exists) with its links resolved.
absolute() {
  local path="$1"
  [[ "$path" == "~" ]] && path="$HOME"
  [[ "$path" == "~/"* ]] && path="$HOME/${path#\~/}"
  [[ "$path" == /* ]] || path="$PWD/$path"
  [[ "$path" == / ]] || path="${path%/}"
  if [[ -d "$path" ]]; then (cd "$path" && pwd -P)
  elif [[ -d "$(dirname "$path")" ]]; then echo "$(cd "$(dirname "$path")" && pwd -P)/$(basename "$path")"
  else echo "$path"
  fi
}

# 1. The bundle: a gzipped tarball, every entry inside it and none a link.
[[ -f "$bundle" ]] || fail "no bundle $bundle"
stage="$(mktemp -d "${TMPDIR:-/tmp}/install-project.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
b="$stage/bundle"; mkdir "$b"
entries="$(tar -tzf "$bundle" 2>/dev/null)" || fail "$bundle is not a preset bundle (a .tar.gz from export-project)"
while IFS= read -r entry; do
  [[ "$entry" != /* && "/$entry/" != */../* ]] || fail "$bundle's entry $entry lies outside the bundle"
done <<<"$entries"
tar -xzf "$bundle" -C "$b" 2>/dev/null || fail "$bundle is not a preset bundle (a .tar.gz from export-project)"
link="$(cd "$b" && find . -type l | sed 's#^\./##' | head -1)"
[[ -z "$link" ]] || fail "$bundle holds a link, $link"

# 2. The manifest, format 1, and the files it lists.
[[ -f "$b/manifest.json" ]] || fail "$bundle has no manifest.json: not a preset bundle"
jq -e 'type == "object"' "$b/manifest.json" >/dev/null 2>&1 || fail "$bundle's manifest.json is not a JSON object"
jq -e '.format == 1' "$b/manifest.json" >/dev/null \
  || fail "$bundle's manifest is format $(jq -c '.format' "$b/manifest.json"); this harness installs format 1"
project="$(jq -r '.project | strings' "$b/manifest.json")"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || fail "$bundle's manifest names no project a folder can be named after"
jq -e '(.files | type == "array" and all(type == "string")) and ((.["state-engines"] // []) | type == "array" and all(type == "string"))
       and ((.["project-engines"] // []) | type == "array" and all(type == "string")) and ((.setup // []) | type == "array")' "$b/manifest.json" >/dev/null \
  || fail "$bundle's manifest has no files list, or a bad state-engines, project-engines or setup"
while IFS= read -r file; do
  [[ -f "$b/$file" && "/$file/" != */../* ]] || fail "$bundle lacks $file, which its manifest lists"
done < <(jq -r '.files[]' "$b/manifest.json")
for file in project.json vm-credentials.template.json; do
  [[ -f "$b/$file" ]] || fail "$bundle lacks $file"
  jq -e 'type == "object"' "$b/$file" >/dev/null 2>&1 || fail "$bundle's $file is not a JSON object"
done

# 3. The state engines: each the project's own (in the bundle) or this harness's.
own=" $(jq -r '(.["project-engines"] // [])[]' "$b/manifest.json" | tr '\n' ' ')"
for engine in $own; do
  [[ "$engine" =~ ^[A-Za-z0-9_-]+$ && -f "$b/engines/$engine/state-engine.json" ]] || fail "$bundle lacks engines/$engine/state-engine.json, which its manifest lists"
done
while IFS= read -r engine; do
  [[ "$engine" =~ ^[A-Za-z0-9_-]+$ ]] || fail "$bundle's manifest names a bad state engine"
  [[ "$own" == *" $engine "* || -f "$engines_dir/$engine/state-engine.json" ]] \
    || fail "$project uses state engine $engine, which is neither in the bundle's engines/ nor this harness's engines/"
done < <(jq -r '(.["state-engines"] // [])[]' "$b/manifest.json")

# 4. The project root: an existing folder, the top of a git checkout.
[[ -d "$project_root" ]] || fail "no folder $project_root for the project root"
project_root="$(cd "$project_root" && pwd -P)"
top="$(git -C "$project_root" rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$top" && "$(cd "$top" && pwd -P)" == "$project_root" ]] || fail "$project_root is not a git checkout (the top folder of one)"

# 5. An installed project only with --force.
target="$projects_dir/$project"
[[ "$force" == true || ! -f "$target/project.json" ]] || fail "$project is already installed at $target; give --force to reinstall over it"

# 6. harness.local.json and lima-home (harness.json only read).
for settings in "$local_file" "$harness_file"; do
  [[ ! -f "$settings" ]] || jq -e 'type == "object"' "$settings" >/dev/null 2>&1 || fail "$settings is not a JSON object"
done
if [[ -n "$lima_home" ]]; then lima_home="$(absolute "$lima_home")"
else
  for settings in "$local_file" "$harness_file"; do
    lima_home="$(jq -r '.["lima-home"] // empty | strings' "$settings" 2>/dev/null || true)"
    [[ "$lima_home" != /* ]] || break
  done
  [[ "$lima_home" == /* ]] || lima_home="$HOME/.lima"
fi

# 7. The credentials: the template at .["<project>"], an entry there kept without --force.
credentials='{}' declared=false backup=""
if [[ -f "$credentials_file" ]]; then
  jq -e 'type == "object"' "$credentials_file" >/dev/null 2>&1 || fail "$credentials_file is not a JSON object"
  credentials="$(cat "$credentials_file")"
  jq -e --arg p "$project" 'has($p)' <<<"$credentials" >/dev/null && declared=true
fi
write_credentials=true
[[ "$declared" == true && "$force" != true ]] && write_credentials=false
jq --arg p "$project" --slurpfile t "$b/vm-credentials.template.json" '.[$p] = $t[0]' <<<"$credentials" > "$stage/vm-credentials.json"

# 8. project.json, its machine-specific fields filled in.
jq --arg p "$project" --arg folder "$project_root" '
  walk(if . == "{project-root}" then $folder else . end)
  | if (.registry | type) == "object" then .registry["storage-path"] = "projects/\($p)/registry" else . end
  | if (.["golden-image"] | type) == "object" then .["golden-image"].folder = "projects/\($p)/golden-image" else . end
' "$b/project.json" > "$stage/project.json"

# --- Every check has passed: the writes. ---
mkdir -p "$target"
for folder in golden-image engines; do
  [[ -d "$b/$folder" ]] || continue
  rm -rf "$target/$folder"
  cp -R "$b/$folder" "$target/$folder"
done
for note in merge-request-area-of-interest.md merge-request-considerations.md; do
  [[ -f "$b/$note" ]] && cp "$b/$note" "$target/$note"
done
# project.json is live data control writes too: replaced and edited under its
# lock (json-file.bash), as harness.local.json is.
update_json --create "$target/project.json" -n --slurpfile new "$stage/project.json" '$new[0]'
mkdir -p "$(dirname "$local_file")"
update_json --create "$local_file" --arg home "$lima_home" '.["lima-home"] = $home'

if [[ "$write_credentials" == true ]]; then
  mkdir -p "$(dirname "$credentials_file")" && chmod 700 "$(dirname "$credentials_file")"
  if [[ -f "$credentials_file" ]]; then
    backup="$credentials_file.backup-$(date -u +%Y%m%dT%H%M%SZ)"
    [[ ! -e "$backup" ]] || backup="$backup.$$"
    cp -p "$credentials_file" "$backup"
  fi
  (umask 077; replace_file "$credentials_file" < "$stage/vm-credentials.json")   # mode 600
fi

# --- What is left: the manifest's setup steps and the placeholders still to fill. ---
entry="$(jq -c --arg p "$project" '.[$p] // {}' "$credentials_file" 2>/dev/null || echo '{}')"
echo "Installed $project into $target (project root $project_root, Lima folder $lima_home)."
if [[ "$write_credentials" == true && "$declared" == true ]]; then
  echo "Replaced $project's entry in $credentials_file with the bundle's template (--force); the old file is $backup."
elif [[ "$write_credentials" == true ]]; then
  echo "Wrote $project's credentials template into $credentials_file${backup:+ (the old file is $backup)}."
else
  echo "$credentials_file already declares credentials for $project: kept as they are (give --force to replace them with the bundle's template)."
fi
jq -r --argjson entry "$entry" --slurpfile pj "$target/project.json" --arg file "$credentials_file" --arg pjfile "$target/project.json" --arg p "$project" '
  def clean: tostring | gsub("[[:cntrl:]]"; "");
  ([$entry, $pj[0]] | [.. | strings]) as $left
  | (.placeholders // {}) as $ph
  | [(.setup // [])[] | select(type == "object")
      | select(.step != "keychain-item" or .in != "vm-credentials.template.json" or (.placeholder as $x | $left | index($x)))] as $steps
  | [$ph | to_entries[] | select(.key as $k | $left | index($k))] as $todo
  | (if ($steps | length) > 0 then "\nRemaining setup steps:" else "\nNo setup steps left." end),
    ($steps | to_entries[] | .key as $i | .value
      | "  \($i + 1). \(.description // .step | clean)",
        (if .step == "keychain-item" and .in == "vm-credentials.template.json" then "     then put its service name in place of \(.placeholder | clean) in \($file) (.[\"\($p)\"].\(.for | clean))"
         elif .step == "keychain-item" then "     then set \(.sets | clean) in \($pjfile)"
         else empty end),
        (if .command then "     run: \(.command | clean)" else empty end)),
    (if ($todo | length) > 0 then "\nPlaceholders still to fill:" else empty end),
    ($todo[] | "  \(.key | clean)  \(.value | clean)")
' "$b/manifest.json"
