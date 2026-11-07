#!/usr/bin/env bash
# Description: Record what a project's Hindsight memory has spent on Claude since last read — memory:record-spend <project>; control runs it every few minutes.
set -euo pipefail
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/memory.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

# ASS-269. Hindsight (memory.bash) calls Claude on the project's API key for
# retain's fact extraction, consolidation and reflect. What each call used it
# adds to its Prometheus counters at /metrics —
#   hindsight_llm_tokens_{input,output,cached_input}_tokens_total{model, scope, token_bucket, …}
# — totals since that Hindsight started: input every input token (Anthropic's
# cache reads and writes in it), cached_input the cache reads among them. The
# most reliable source it has: its log has tokens only for slow calls (and
# roughly, for consolidation batches), and its llm-requests traces keep a day
# and have no successful call in them on 1.1.0.
# The project's memory-spend.json keeps the counters as last read, under
# hindsight — { pid, cpu-seconds, counters } — and records: what the counters
# moved by since, per model, each
#   { timestamp, billing: "api", source: "memory", model, input-tokens (those
#     at the input rate: cache writes among them), cache-read-tokens,
#     output-tokens, cost-usd }
# priced from harness.json's model-prices (USD per million; cost-usd null for
# a model with none, named in unpriced); a model's spend within one local hour
# is one record, its timestamp the latest read's — so each read appends or
# grows one. Counted against the project's API caps and its spend tiles,
# never a ticket's (control/spend.js spendRecords).
# - The first read is the baseline: nothing is recorded for what Hindsight
#   spent before the harness counted it.
# - Read again with nothing new, nothing is recorded: the counters are what
#   was last read.
# - A Hindsight restarted since — another pid in hindsight.pid, or its
#   process's CPU seconds or any counter lower than last read — is counted
#   from zero; nothing recorded is touched. What it spent after the last read
#   and before it stopped is lost, unless memory:up's own restart (up.sh),
#   which reads first.
# - A project with no llm-api-key runs Hindsight with provider none: it
#   calls no Claude, and nothing is read or written.
# Prints { project, provider, collection: memory-spend.json's last-collection
# — { at, baseline, restarted, recorded, unpriced } — or null }. Fails,
# writing nothing, when Hindsight does not answer /metrics.
# HARNESS_FILE overrides harness.json (the projects folder's sibling); for tests.
[[ $# -eq 1 ]] || { echo "usage: memory:record-spend <project>" >&2; exit 1; }
memory_config memory:record-spend "$1"
if [[ "$provider" == none ]]; then
  jq -n --arg p "$1" '{ project: $p, provider: "none", collection: null }'
  exit 0
fi
metrics="$(curl -fs --max-time 10 "http://127.0.0.1:$port/metrics")" \
  || { echo "memory:record-spend: $1's Hindsight on 127.0.0.1:$port did not answer /metrics" >&2; exit 1; }
harness_file="${HARNESS_FILE:-$projects/../harness.json}"
prices="$(jq -c '.["model-prices"] // {}' "$harness_file" 2>/dev/null || echo '{}')"
pid="$(tr -d '[:space:]' 2>/dev/null < "$data/hindsight.pid" || true)"
file="$projects/$1/memory-spend.json"

update_json --create "$file" --arg metrics "$metrics" --arg pid "$pid" --argjson prices "$prices" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  def hour: fromdateiso8601 | strflocaltime("%Y-%m-%dT%H");
  [$metrics | splits("\n") | capture("^(?<key>hindsight_llm_tokens_(?<kind>input|output|cached_input)_tokens_total\\{(?<labels>[^}]*)\\}) (?<value>\\S+)$")
    | .value |= tonumber | .model = ((.labels | capture("(^|,)model=\"(?<m>[^\"]*)\"").m) // "unknown")] as $series
  | ($series | map({ (.key): .value }) | add // {}) as $counters
  | ([$metrics | splits("\n") | capture("^hindsight_process_cpu_seconds\\{[^}]*type=\"user\"[^}]*\\} (?<v>\\S+)$").v | tonumber] | first // null) as $cpu
  | .hindsight as $was
  | ($was == null) as $first
  | ($was != null and (($pid != "" and ($was.pid // "") != "" and $was.pid != $pid)
      or ($cpu != null and $was["cpu-seconds"] != null and $cpu < $was["cpu-seconds"])
      or ($counters | to_entries | any(.value < ($was.counters[.key] // 0))))) as $restarted
  | (if $first then $counters elif $restarted then {} else $was.counters end) as $base
  | [$series | map(.delta = ([.value - ($base[.key] // 0), 0] | max)) | group_by(.model)[]
      | { model: .[0].model, sum: (reduce .[] as $s ({}; .[$s.kind] += $s.delta)) }
      | (.sum.cached_input // 0) as $read | { model, input: ([(.sum.input // 0) - $read, 0] | max), read: $read, output: (.sum.output // 0) }
      | select(.input + .read + .output > 0)
      | $prices[.model] as $p
      | { timestamp: $at, billing: "api", source: "memory", model, "input-tokens": .input, "cache-read-tokens": .read, "output-tokens": .output,
          "cost-usd": (if $p then ((.input * $p.input + .read * ($p["cache-read"] // $p.input) + .output * $p.output) / 1e6 * 1e9 | round / 1e9) else null end) }] as $new
  | .records = reduce $new[] as $r (.records // [];
      (map(.model == $r.model) | rindex(true)) as $i
      | if $i != null and (.[$i].timestamp | hour) == ($at | hour)
        then .[$i] |= (.timestamp = $at | .["input-tokens"] += $r["input-tokens"] | .["cache-read-tokens"] += $r["cache-read-tokens"] | .["output-tokens"] += $r["output-tokens"]
          | .["cost-usd"] = (if .["cost-usd"] == null or $r["cost-usd"] == null then null else (.["cost-usd"] + $r["cost-usd"]) * 1e9 | round / 1e9 end))
        else . + [$r] end)
  | .hindsight = { pid: $pid, "cpu-seconds": $cpu, counters: $counters }
  | .["last-collection"] = { at: $at, baseline: $first, restarted: $restarted, recorded: $new, unpriced: [$new[] | select(.["cost-usd"] == null) | .model] }'
jq --arg p "$1" '{ project: $p, provider: "anthropic", collection: .["last-collection"] }' "$file"
