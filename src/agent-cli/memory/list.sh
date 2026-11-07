#!/usr/bin/env bash
# Description: The memories saved working one ticket — memory:list <project> <ticket-key>: its project's Hindsight memories whose metadata.ticket is the key, then the observations drawn from them, marked derived.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/memory.bash"

# ASS-146: what a deleted or reverted ticket's memory review checks (prompts/
# clean-memory, run scoped to the ticket). Every memory unit of the project's
# bank, read page by page from Hindsight's HTTP API (memories/list, as the
# TUI's memory screen reads it: src/agents/memory.js), those whose metadata
# names the ticket (any case; agents retain with the source the -grouped
# wrappers give) printed as a JSON array, Hindsight's own fields — id, text,
# document_id, metadata (ticket, step, model, date), mentioned_at, … — as they
# are. After them (ASS-156), every observation drawn from one of them — Hindsight's
# consolidation writes those with no document_id and no metadata, naming the
# facts they came from in source_memory_ids — marked "derived": true. Hindsight
# 1.1.0 deletes an observation itself, in the same transaction, when any of its
# source facts is deleted, replaced by a retain under its document_id, edited
# or invalidated (hindsight_api engine/memories/pg/writes.py
# delete_stale_observations), so one listed is drawn from facts that still
# stand. Fails, naming the project, when it has no Hindsight in project.json or
# it does not answer.
[[ $# -eq 2 ]] || { echo "usage: memory:list <project> <ticket-key>" >&2; exit 1; }
memory_config memory:list "$1"
key="$2"
page=500 offset=0 all='[]'
while :; do
  body="$(curl -sf --max-time 10 "http://127.0.0.1:$port/v1/default/banks/$1/memories/list?limit=$page&offset=$offset")" \
    || { echo "memory:list: $1's Hindsight is not answering on 127.0.0.1:$port" >&2; exit 1; }
  count="$(jq '.items // [] | length' <<< "$body")"
  all="$(jq -c --argjson more "$(jq -c '.items // []' <<< "$body")" '. + $more' <<< "$all")"
  offset=$((offset + count))
  [[ "$count" -gt 0 && "$offset" -lt "$(jq '.total // 0' <<< "$body")" ]] || break
done
jq --arg k "$key" '
  [.[] | select((.metadata.ticket // "" | ascii_upcase) == ($k | ascii_upcase))] as $facts
  | ($facts | map(.id)) as $ids
  | $facts + [.[] | select(.fact_type == "observation" and any(.source_memory_ids[]?; . as $s | $ids | index($s))) | . + { derived: true }]' <<< "$all"
