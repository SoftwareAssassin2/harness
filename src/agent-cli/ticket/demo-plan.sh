#!/usr/bin/env bash
# Description: Print a ticket variation's demo plan, checked — ticket:demo-plan <project> <ticket-key> <variation>.
set -euo pipefail

# Write Test Plan records the demo plan (ASS-76) with ticket:set-demo-plan
# (ASS-180) into the ticket's folder,
# data/projects/<project>/work/<KEY>/demo-plan-<variation>.json: how the operator
# sees the change working in the variation's VM at human review. Either
#   { "demo": true,
#     "setup": ["<command>", …],        each run with bash in the VM's /repos/, in order (may be none)
#     "ready-check": "<command>",       exit 0 = ready; polled after setup
#     "view": { "with": "browser", "address": "<url in the VM's browser>" }
#           | { "with": "terminal", "commands": ["<command>", …] }
#           | { "with": "other", "how": "<what to open, in words>" },
#     "look-at": ["<what to look at>", …] }
# or { "demo": false, "why": "<why there is none>" }. Prints just those fields,
# as JSON — what Review Plan shows and the Demo action follows. The shape is
# checked by ../demo-plan.jq, the one validator ticket:set-demo-plan uses too.
# Fails when the file is missing or not of that shape.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../code.bash"

[[ $# -eq 3 ]] || { echo "usage: ticket:demo-plan <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" variation="$3"
for pair in "project:$project" "ticket:$key" "variation:$variation"; do
  [[ "${pair#*:}" =~ ^[A-Za-z0-9_.-]+$ && "${pair#*:}" != *..* ]] || { echo "ticket:demo-plan: invalid ${pair%%:*} '${pair#*:}'" >&2; exit 1; }
done
name="demo-plan-$variation.json"
file="$projects/$project/work/$key/$name"
[[ -f "$file" ]] || { echo "ticket:demo-plan: $key has no $name in its folder" >&2; exit 1; }

jq -e -f "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../demo-plan.jq" "$file" 2>/dev/null \
  || { echo "ticket:demo-plan: $name must hold { demo: true, setup, ready-check, view: { with: browser, address | terminal, commands | other, how }, look-at } or { demo: false, why }" >&2; exit 1; }
