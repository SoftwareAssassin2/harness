#!/usr/bin/env bash
# Description: Export a project's setup as a private preset bundle — export-project <project> [<out-file>] [--as <key>] [--name <display name>] [--engine-prefix <from>=<to>] (default ./<key>-preset.tar.gz); prints its path.
set -euo pipefail

# The bundle (ASS-274) is how a project's setup goes to a coworker privately,
# never through the public repo; harness:install-project (ASS-275) reads it. A
# gzipped tarball, every entry at its root, owned by uid/gid 0:
#
#   manifest.json                     what the bundle is (below)
#   project.json                      the setup fields of data/projects/<project>/project.json
#   vm-credentials.template.json      the project's ~/.harness/vm-credentials.json entry, as placeholders
#   golden-image/…                    data/projects/<project>/golden-image/, when it has one
#   engines/…                         data/projects/<project>/engines/, the project's own state engines (ASS-276), when it has them
#   merge-request-area-of-interest.md   when it has one
#   merge-request-considerations.md     when it has one
#
# project.json keeps name, execution-state-engine, dev-container, uses-points,
# merge-request-area-of-interest, work-sources, worktree-setup, every max-*
# and check-for-expired-*, dev-container-env, story-point-scale,
# raised-bug-priority, merge-request-title, numbered-files (ASS-385) and vm-full-checks as they are, and
#   repositories        each with url, description and work-space.branch only
#   local-environments  each with name and type; local-pc's folder is {project-root}
#   registry            without storage-path (install rebuilds it)
#   hindsight           port only: no llm-api-key, no keychain service name
#   golden-image        without folder (install rebuilds it)
# Every other field — highlighted-tickets, expected-account, background-work,
# the ai-feedback-*/status/needs-rebuilt/server-name/base-image/active-branch/
# return-to runtime fields — is left out.
#
# vm-credentials.template.json is the object for .["<project>"] of
# ~/.harness/vm-credentials.json (see src/agent-cli/vm-credentials.bash), each
# kind's shape kept (gitlab host and npm-registries, atlassian site) and its
# keychain-service, user-name, user-email and email replaced by the
# placeholder "{<kind>-<field>}", e.g. "{gitlab-keychain-service}"; {} when
# the file declares nothing for the project.
#
# manifest.json, format 1:
#   { "format": 1,
#     "project": "<project>",                    the data/projects/ folder name (--as's key when given, ASS-280)
#     "exported-at": "<UTC ISO-8601>",
#     "harness-commit": "<sha>" | null,          HEAD of the harness checkout exporting it
#     "execution-state-engine": "<engine>",
#     "state-engines": ["<engine>", …],          it and every engine its steps reach, sorted; each the project's own or in engines/
#     "project-engines": ["<engine>", …],        the engines in the bundle's engines/ (the project's own folder), sorted; [] without
#     "files": ["project.json", …],              every file in the bundle but manifest.json, sorted
#     "placeholders": { "{project-root}": "<what to fill in>", … },
#     "setup": [ { "step": "<kind>", "description": "…", … }, … ] }   in the order install runs them
# The setup steps, each only when the project needs it:
#   keychain-item  "for": a credential kind, "placeholder", "in": "vm-credentials.template.json"
#                  — or "for": "hindsight", "sets": "hindsight.llm-api-key-keychain-service", "in": "project.json"
#   gcloud-login   "command": "gcloud auth login"   (check-for-expired-gcloud-auth, or a gcloud registry upstream)
#   glab-login     "command": "glab auth login"     (check-for-expired-glab-auth, or a gitlab credential)
#   registry-up    "command": "./agent.sh registry:up <project>"
#   golden-build   "command": "./agent.sh vm:build-golden <project>"
#   memory-up      "command": "./agent.sh memory:up <project>"
#
# The project's own engines (ASS-276) keep format 1: they only add entries — an
# engines/ folder and "project-engines" — that a reader of the format ASS-274
# wrote ignores, and no reader of it exists yet (install-project, ASS-275, is
# to unpack engines/ into data/projects/<project>/engines/). A state engine
# listed in "state-engines" and not in "project-engines" is one the
# installing harness's engines/ must have.
#
# No secret value is read or written: the keychain is never touched, and a
# literal hindsight llm-api-key is dropped unread. Before anything is
# written the bundle is scanned, and the export fails, naming the file, when
# any file holds a token-shaped string (glpat-, ghp_, github_pat_, sk-ant-,
# AIza, a private key) or one of the project's keychain service names, user
# names or emails, or a JSON or Markdown file holds an email address or a
# machine path (/Users/, /Volumes/, /home/). It fails too, writing nothing,
# for a missing project or a state engine in neither the project's own engines
# folder nor engines/ (engine.bash's engine_path, ASS-276).
#
# Exporting under another name (ASS-280), in the bundle only — the operator's
# data/projects/<project> and engines are never changed:
#   --as <key>            the project's key in the bundle (a data/projects folder
#                         name: letters, digits, _ and -). It is manifest.json's
#                         "project", the setup commands' project argument and the
#                         default out-file's name, and it replaces every
#                         whole-word occurrence of <project> in the bundle's text
#                         files (golden-image comments, paths such as
#                         data/projects/<project>/, the notes, project.json,
#                         engines/). A word is a run of a key's own characters
#                         (letters, digits, _ and -), so for acme-shop
#                         "acme-shop's" and "/acme-shop/" change while "acmeshop",
#                         "acmeshop-group" and "acme-shop-x" — other identifiers
#                         that only contain the key — are kept.
#   --name <display name> project.json's name; the current name when left out.
#   --engine-prefix <from>=<to>
#                         renames each engine in the bundle's engines/ (the
#                         project's own) whose name starts with <from>- to
#                         <to>-…, its folder too, and every reference to it:
#                         "execution-state-engine", "state-engines" and
#                         "project-engines" in the manifest, project.json's
#                         "execution-state-engine", and each bundled engine's
#                         "engine": "<name>" (its action.engine in steps and
#                         *-steps lists), the rest of each engine's text as it
#                         was. It fails, writing nothing, when a shared engine
#                         the project uses (one only in engines/) starts with
#                         <from>- or names an engine being renamed, or when a new
#                         name is already an engine's in engines/ or the bundle.
# An invalid key, prefix or option fails too, writing nothing.
#
# PROJECTS_DIR and ENGINES_DIR override the data/projects and engines folders,
# HOME the folder of .harness/vm-credentials.json (tests).
root="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd -P)"
source "$root/src/agent-cli/engine.bash"
projects_dir="${PROJECTS_DIR:-$root/data/projects}"
credentials_file="$HOME/.harness/vm-credentials.json"

fail() { echo "export-project: $*; nothing written" >&2; exit 1; }

usage() { echo "usage: export-project <project> [<out-file>] [--as <key>] [--name <display name>] [--engine-prefix <from>=<to>]" >&2; exit 1; }
positional=() as='' display_name='' name_set='' prefix=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --as) [[ $# -ge 2 ]] || usage; as="$2"; [[ "$as" =~ ^[A-Za-z0-9_-]+$ ]] || fail "invalid --as key '$as'"; shift 2 ;;
    --name) [[ $# -ge 2 ]] || usage; display_name="$2" name_set=1; [[ -n "$display_name" ]] || fail "--name is empty"; shift 2 ;;
    --engine-prefix) [[ $# -ge 2 ]] || usage; prefix="$2"
      [[ "$prefix" =~ ^[A-Za-z0-9_-]+=[A-Za-z0-9_-]+$ ]] || fail "invalid --engine-prefix '$prefix' (want <from>=<to>)"; shift 2 ;;
    -*) usage ;;
    *) positional+=("$1"); shift ;;
  esac
done
[[ ${#positional[@]} -ge 1 && ${#positional[@]} -le 2 ]] || usage
set -- "${positional[@]}"
project="$1"
as="${as:-$project}"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ && -f "$projects_dir/$project/project.json" ]] || fail "no project $project"
source_dir="$projects_dir/$project"
json="$source_dir/project.json"
jq -e 'type == "object"' "$json" >/dev/null 2>&1 || fail "$project's project.json is not a JSON object"
out="${2:-$as-preset.tar.gz}"
out_dir="$(cd "$(dirname "$out")" 2>/dev/null && pwd -P)" || fail "no folder $(dirname "$out") for $out"
out="$out_dir/$(basename "$out")"

stage="$(mktemp -d "${TMPDIR:-/tmp}/export-project.XXXXXX")"
trap 'rm -rf "$stage" "$out.partial.$$"' EXIT

# 1. The state engines: the execution engine and every engine its steps and
#    *-steps lists reach (as engine.bash's connected_engines walks them), each
#    of which must be the project's own or in engines/ (engine_path).
engine="$(jq -r '.["execution-state-engine"] // empty' "$json")"
[[ -n "$engine" ]] || fail "$project has no execution-state-engine"
engines=() queue=("$engine") seen=" $engine "
while [[ ${#queue[@]} -gt 0 ]]; do
  name="${queue[0]}"; queue=("${queue[@]:1}")
  file="$(engine_path "$name" "$project")" || fail "$project uses state engine $name, which is not in engines/ or data/projects/$project/engines/"
  engines+=("$name")
  while IFS= read -r next; do
    [[ -n "$next" && "$seen" != *" $next "* ]] || continue
    seen+="$next "; queue+=("$next")
  done < <(jq -r '[(.steps // []), (to_entries[] | select(.key | endswith("-steps")) | .value)] | flatten | .[] | select(.action.type? == "state-engine") | .action.engine' "$file")
done

# 2. project.json's setup fields.
jq '
  def only($keys): with_entries(select(.key as $k | $keys | index($k)));
  with_entries(select(.key | test("^(name|execution-state-engine|dev-container|uses-points|merge-request-area-of-interest|work-sources|repositories|local-environments|worktree-setup|dev-container-env|registry|hindsight|golden-image|story-point-scale|raised-bug-priority|merge-request-title|numbered-files|vm-full-checks)$|^max-|^check-for-expired-")))
  | if has("repositories") then .repositories |= map(only(["url", "description"])
      + (if .["work-space"].branch? != null then {"work-space": {branch: .["work-space"].branch}} else {} end)) else . end
  | if has("local-environments") then .["local-environments"] |= map(only(["name", "type"])
      + (if .type == "local-pc" then {folder: "{project-root}"} else {} end)) else . end
  | if (.registry | type) == "object" then .registry |= del(.["storage-path"]) else . end
  | if (.hindsight | type) == "object" then .hindsight |= only(["port"]) else . end
  | if (.["golden-image"] | type) == "object" then .["golden-image"] |= del(.folder) else . end
' "$json" > "$stage/project.json"

# 3. The credentials template.
declared='{}'
if [[ -f "$credentials_file" ]]; then
  declared="$(jq -c --arg p "$project" '.[$p] // {} | objects' "$credentials_file" 2>/dev/null)" || fail "$credentials_file is not JSON"
  [[ -n "$declared" ]] || declared='{}'
fi
[[ "$declared" != '{}' ]] || echo "export-project: $credentials_file declares no VM credentials for $project; the template is {}" >&2
jq 'with_entries(.key as $kind | .value |= (objects | with_entries(
      if (.key | IN("keychain-service", "user-name", "user-email", "email")) then .value = "{\($kind)-\(.key)}" else . end)))' \
  <<<"$declared" > "$stage/vm-credentials.template.json"

# 4. The files kept as they are.
[[ -d "$source_dir/golden-image" ]] && cp -R "$source_dir/golden-image" "$stage/golden-image"
[[ -d "$source_dir/engines" ]] && cp -R "$source_dir/engines" "$stage/engines"
for note in merge-request-area-of-interest.md merge-request-considerations.md; do
  [[ -f "$source_dir/$note" ]] && cp "$source_dir/$note" "$stage/$note"
done

# 4b. The new name (ASS-280): the key's whole words in every text file, then
#     project.json's name.
if [[ "$as" != "$project" ]]; then
  while IFS= read -r -d '' f; do
    grep -Iq . "$f" || continue
    FROM="$project" TO="$as" perl -pi -e 's/(?<![A-Za-z0-9_-])\Q$ENV{FROM}\E(?![A-Za-z0-9_-])/$ENV{TO}/g' "$f"
  done < <(find "$stage" -type f -print0)
fi
if [[ -n "$name_set" ]]; then
  renamed="$(jq --arg name "$display_name" '.name = $name' "$stage/project.json")"
  printf '%s\n' "$renamed" > "$stage/project.json"
fi

# 4c. The engines' new names (ASS-280): <from>-… -> <to>-… for the bundle's
#     own engines, checked against the shared engines and every existing name.
if [[ -n "$prefix" ]]; then
  from="${prefix%%=*}-" to="${prefix#*=}-"
  own_names=" " renames=()
  for f in "$stage"/engines/*/state-engine.json; do
    [[ -f "$f" ]] || continue
    own="$(basename "$(dirname "$f")")"; own_names+="$own "
    [[ "$own" == "$from"* ]] && renames+=("$own")
  done
  for used in "${engines[@]}"; do
    [[ "$own_names" != *" $used "* ]] || continue
    [[ "$used" != "$from"* ]] || fail "the shared engine $used starts with $from; only the project's own engines are renamed"
    for old in ${renames[@]+"${renames[@]}"}; do
      jq -e --arg old "$old" '[(.steps // []), (to_entries[] | select(.key | endswith("-steps")) | .value)] | flatten | any(.action.engine? == $old)' \
        "$(engine_path "$used" "$project")" >/dev/null && fail "the shared engine $used names $old, which would be renamed"
    done
  done
  for old in ${renames[@]+"${renames[@]}"}; do
    new="$to${old#"$from"}"
    if [[ "$own_names" == *" $new "* || -f "$engines_dir/$new/state-engine.json" ]]; then fail "engine $old's new name $new is already an engine's"; fi
  done
  for old in ${renames[@]+"${renames[@]}"}; do
    new="$to${old#"$from"}"
    mv "$stage/engines/$old" "$stage/engines/$new"
    for f in "$stage"/engines/*/state-engine.json; do
      OLD="$old" NEW="$new" perl -pi -e 's/("engine"\s*:\s*")\Q$ENV{OLD}\E(")/$1$ENV{NEW}$2/g' "$f"
    done
    [[ "$engine" != "$old" ]] || engine="$new"
    for i in "${!engines[@]}"; do [[ "${engines[$i]}" != "$old" ]] || engines[$i]="$new"; done
  done
  renamed="$(jq --arg engine "$engine" '.["execution-state-engine"] = $engine' "$stage/project.json")"
  printf '%s\n' "$renamed" > "$stage/project.json"
fi

# 5. The manifest.
commit="$(git -C "$root" rev-parse HEAD 2>/dev/null || true)"
files="$(cd "$stage" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | jq -R . | jq -sc .)"
jq -n --arg project "$as" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg commit "$commit" --arg engine "$engine" \
  --argjson engines "$(printf '%s\n' "${engines[@]}" | LC_ALL=C sort | jq -R . | jq -sc .)" --argjson files "$files" \
  --argjson own "$(for f in "$stage"/engines/*/state-engine.json; do [[ ! -f "$f" ]] || basename "$(dirname "$f")"; done | LC_ALL=C sort | jq -R . | jq -sc .)" \
  --slurpfile setup "$stage/project.json" --slurpfile source "$json" --slurpfile template "$stage/vm-credentials.template.json" '
  $setup[0] as $p | $template[0] as $t | $source[0] as $s |
  def run($step; $description; $command): {step: $step, description: $description, command: $command};
  { format: 1,
    project: $project,
    "exported-at": $at,
    "harness-commit": (if $commit == "" then null else $commit end),
    "execution-state-engine": $engine,
    "state-engines": $engines,
    "project-engines": $own,
    files: $files,
    placeholders: (
      (if any($p["local-environments"][]?; .folder == "{project-root}") then {"{project-root}": "the folder of the project'"'"'s workspace checkout on this Mac"} else {} end)
      + ([$t | to_entries[] | .key as $kind | .value | to_entries[] | select(.value == "{\($kind)-\(.key)}") | {key: .value, value: (
          {"keychain-service": "the name of the keychain item holding your \($kind) token",
           "user-name": "your \($kind) user name", "user-email": "your \($kind) email", "email": "your \($kind) email"}[.key])}] | from_entries)),
    setup: (
      [$t | to_entries[] | select(.value["keychain-service"]? == "{\(.key)-keychain-service}") |
        {step: "keychain-item", for: .key, placeholder: .value["keychain-service"], in: "vm-credentials.template.json",
         description: "Save your \(.key) token in the keychain (security add-generic-password -s <service> -a $USER -T /usr/bin/security -w) and put the service name in place of the placeholder"}]
      + (if ($s.hindsight | type) == "object" and (($s.hindsight["llm-api-key-keychain-service"] // $s.hindsight["llm-api-key"]) | type) == "string"
           then [{step: "keychain-item", for: "hindsight", sets: "hindsight.llm-api-key-keychain-service", in: "project.json",
                  description: "Save an Anthropic API key for the project'"'"'s Hindsight memory in the keychain and name its service in hindsight.llm-api-key-keychain-service (without one Hindsight runs with provider none)"}]
           else [] end)
      + (if $p["check-for-expired-gcloud-auth"] == true or $p.registry.upstream.credentials? == "gcloud" then [run("gcloud-login"; "Log gcloud in to the project'"'"'s Google Cloud account"; "gcloud auth login")] else [] end)
      + (if $p["check-for-expired-glab-auth"] == true or ($t | has("gitlab")) then [run("glab-login"; "Log glab in to the project'"'"'s GitLab"; "glab auth login")] else [] end)
      + (if ($p.registry | type) == "object" then [run("registry-up"; "Start the project'"'"'s local image registry"; "./agent.sh registry:up \($project)")] else [] end)
      + (if ($p["golden-image"] | type) == "object" then [run("golden-build"; "Build the project'"'"'s golden VM image"; "./agent.sh vm:build-golden \($project)")] else [] end)
      + (if ($p.hindsight | type) == "object" then [run("memory-up"; "Bring the project'"'"'s Hindsight memory up"; "./agent.sh memory:up \($project)")] else [] end)) }
' > "$stage/manifest.json"

# 6. The scan, before anything is written. Each failure names the bundle file.
tokens='glpat-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----'
emails='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
paths='(^|[^A-Za-z0-9_.~-])/(Users|Volumes|home)/'
# found <what> <grep -E args…> — fail naming the first bundle file that matches.
found() {
  local what="$1" hit; shift
  hit="$(cd "$stage" && grep -rlE "$@" . 2>/dev/null | sed 's#^\./##' | LC_ALL=C sort | head -1 || true)"
  [[ -z "$hit" ]] || fail "$hit holds $what"
}
found "a token-shaped string" -e "$tokens"
found "an email address" --include='*.json' --include='*.md' -e "$emails"
found "a machine path" --include='*.json' --include='*.md' -e "$paths"
# The project's own private values, matched as fixed strings (never printed).
while IFS=$'\t' read -r what value; do
  [[ -n "$value" ]] || continue
  hit="$(cd "$stage" && grep -rlF -e "$value" . 2>/dev/null | sed 's#^\./##' | LC_ALL=C sort | head -1 || true)"
  [[ -z "$hit" ]] || fail "$hit holds $what"
done < <(jq -r --slurpfile s "$json" '
  ([to_entries[] | .value | objects | to_entries[]
    | select(.key | IN("keychain-service", "user-name", "user-email", "email"))
    | [{"keychain-service": "a keychain service name", "user-name": "a user name", "user-email": "an email address", "email": "an email address"}[.key], .value]]
   + [[ "a keychain service name", ($s[0].hindsight["llm-api-key-keychain-service"]? // empty) ]]
   + [[ "an email address", ($s[0]["expected-account"]? // empty) ]])[]
  | select((.[1] | type) == "string") | @tsv' <<<"$declared")

# 7. The tarball: written beside the out-file, then moved into place. No owner
#    names, extended attributes or AppleDouble files of the exporting Mac.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then owner=(--owner=0 --group=0 --numeric-owner)
else owner=(--uid 0 --gid 0 --uname root --gname root --no-xattrs --no-mac-metadata)
fi
entries=(manifest.json project.json vm-credentials.template.json)
for name in golden-image engines merge-request-area-of-interest.md merge-request-considerations.md; do
  [[ -e "$stage/$name" ]] && entries+=("$name")
done
COPYFILE_DISABLE=1 tar "${owner[@]}" -czf "$out.partial.$$" -C "$stage" "${entries[@]}" || fail "tar could not write $out"
mv "$out.partial.$$" "$out"
echo "$out"
