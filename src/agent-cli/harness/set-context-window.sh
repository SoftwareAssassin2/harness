#!/usr/bin/env bash
# Description: Record a model's context window, learned from a finished turn — harness:set-context-window <model> <tokens>.
set -euo pipefail

# Merges { <model>: <tokens> } into data/context-windows.json
# (CONTEXT_WINDOWS_FILE overrides it, used by tests) — live data: the window a
# result event's modelUsage.<model>.contextWindow reported (ASS-190,
# src/control/dispatch.js), so the dashboard can show context % from a
# session's first event. harness.json's context-windows overrides it per
# model. Other models' entries are kept. Fails, writing nothing, unless the
# model is named and the tokens a whole number (0 or more).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
file="${CONTEXT_WINDOWS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/context-windows.json}"

[[ $# -eq 2 ]] || { echo "usage: harness:set-context-window <model> <tokens>" >&2; exit 1; }
[[ -n "$1" ]] || { echo "harness:set-context-window: the model must be named" >&2; exit 1; }
[[ "$2" =~ ^[0-9]+$ ]] || { echo "harness:set-context-window: the tokens must be a whole number, got '$2'" >&2; exit 1; }

update_json --create "$file" --arg model "$1" --argjson tokens "$2" '. + { ($model): $tokens }'
