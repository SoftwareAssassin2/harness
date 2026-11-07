#!/usr/bin/env bash
# Description: Bill a project's costed dispatches that say no billing to their payment-method, else the project's login, a subscription's cost zeroed — project:backfill-billing <project>.
set -euo pipefail

# ASS-272 AC1. process.js billed counts a dispatch of unknown billing as
# paid, so every agent dispatch with a cost-usd and no billing (missing or
# null) — in the project's sprints/ (each sprint.json and end-of-day snapshot)
# and backlog.json — is billed what its payment-method (ASS-217) says, else
# the project's login kind: its claude-usage.json's auth-method
# (project:set-claude-usage), api_key its API key, any other its subscription
# (account.js kindOfAccount), as assignments:remove falls back for a new one.
# A subscription's cost becomes 0, an api one's is kept; one neither says is
# left as it is. Prints a line per file changed, what was billed and zeroed or
# kept; "<project>: nothing to backfill" when nothing is, so a second run
# changes nothing; and the count of any left, "<project>: <n> dispatches with
# a cost left without billing: …". Unlike project:mark-billing (ASS-216's
# once-only, by timestamp), it can be run again whenever. PROJECTS_DIR
# overrides the projects folder, used by tests. Fails, writing nothing, on an
# unknown project.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

command=project:backfill-billing
[[ $# -eq 1 ]] || { echo "usage: $command <project>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ && -d "$projects/$1" ]] || { echo "$command: invalid project '$1'" >&2; exit 1; }
dir="$projects/$1"
changed=0 left=0

# The project's login kind: "subscription", "api" or null, unknown.
login="$(jq -c '.["auth-method"] // null | if . == null then null elif . == "api_key" then "api" else "subscription" end' "$dir/claude-usage.json" 2>/dev/null || echo null)"

# The costed dispatches with no billing, and what each is billed: its payment-method, else the login's.
defs='def unbilled: .. | objects | select(has("agent-dispatch-log")) | .["agent-dispatch-log"][]? | select(.billing == null and .["cost-usd"] != null);
  def billing: .["payment-method"] // $login;
  def money: "$\(. * 100 | round / 100 | tostring | if test("\\.") then . else . + ".00" end | if test("\\.[0-9]$") then . + "0" else . end)";'
while IFS= read -r file; do
  IFS=$'\t' read -r n summary < <(jq -r --argjson login "$login" "$defs"'
    [unbilled | { b: billing, c: .["cost-usd"] }] | (map(select(.b == "subscription"))) as $s | (map(select(.b == "api"))) as $a
    | "\(map(select(.b == null)) | length)\t" + ([ (if $s != [] then "\($s | length) dispatches billed subscription, \($s | map(.c) | add | money) zeroed" else empty end),
        (if $a != [] then "\($a | length)\(if $s != [] then "" else " dispatches" end) billed api, \($a | map(.c) | add | money) kept" else empty end) ] | join("; "))' "$file")
  left=$((left + n))
  [[ -n "$summary" ]] || continue
  update_json "$file" --argjson login "$login" "$defs"'
    (unbilled | select(billing != null)) |= (.billing = billing | if .billing == "subscription" then .["cost-usd"] = 0 else . end)'
  echo "${file#"$dir/"}: $summary"
  changed=1
done < <(find "$dir/sprints" "$dir/backlog.json" -name '*.json' -type f 2>/dev/null | sort)

[[ $changed -eq 1 ]] || echo "$1: nothing to backfill"
[[ $left -eq 0 ]] || echo "$1: $left dispatches with a cost left without billing: no payment-method and no known login"
