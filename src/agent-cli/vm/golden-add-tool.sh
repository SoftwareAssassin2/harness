#!/usr/bin/env bash
# Description: Add a tool to the build tools a project's golden image must have, so a build without it fails — vm:golden-add-tool <project> <tool>; prints JSON.
set -euo pipefail

# ASS-427 AC2: when Blocked's Repair the VM adds a missing tool to the golden
# image's definition (provision.sh, through vm:golden-write), it names the
# tool here too: project.json's golden-image.tools, which vm:build-golden
# checks are on the built image's PATH (its tools step), so a build that does
# not install it fails instead of making an image every later VM lacks it in
# (ABC-1770: bats). A tool listed already is left as it is. The tools are
# read as a build starts (golden.bash golden_definition), so a build running
# now is not changed: the next one checks it. project.json is control's live
# data too: edited under its lock (json-file.bash update_json). Prints
# { project, tool, tools, added }. Fails, writing nothing, on a project with
# no golden-image, or a tool name that is not one word of letters, digits,
# dot, plus, underscore or hyphen.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/golden.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

[[ $# -eq 2 ]] || { echo "usage: vm:golden-add-tool <project> <tool>" >&2; exit 1; }
project="$1" tool="$2"
[[ "$tool" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] || { echo "vm:golden-add-tool: '$tool' is not a tool name (a command on PATH)" >&2; exit 1; }
golden_definition vm:golden-add-tool "$project"
json="$projects/$project/project.json"
added=true
[[ " ${tools[*]} " != *" $tool "* ]] || added=false
[[ "$added" == false ]] || update_json "$json" --arg t "$tool" '.["golden-image"].tools = ((.["golden-image"].tools // []) | if any(.[]; . == $t) then . else . + [$t] end)'
jq -c --arg p "$project" --arg t "$tool" --argjson added "$added" '{ project: $p, tool: $t, tools: (.["golden-image"].tools // []), added: $added }' "$json"
