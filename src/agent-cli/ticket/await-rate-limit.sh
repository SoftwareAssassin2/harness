#!/usr/bin/env bash
# Description: Resume a ticket blocked by a Claude rate limit on the API key fallback at once, or once the limit resets — ticket:await-rate-limit <project> <ticket-key> <variation>.
set -euo pipefail

# ASS-391, grouped-blocked's Await Rate Limit (a timer step, waiting exit 2).
# Classify said the block was a Claude usage or rate limit (issue
# "rate-limit"), not the ticket's. Control records such a limit per
# credential kind in data/projects/<project>/rate-limit.json ({ <kind>: {
# since, type, resets-at } }, project:set-rate-limit; claude a subscription,
# anthropic a Console API key, ASS-215) and dispatches none of that kind's
# agents until it resets (dispatch.js rateHeld, paymentFor). A kind holds
# while its resets-at is after now.
#
# The API key fallback (dispatch.js paymentFor, ASS-217) is available when
# the project has its .claude-api folder, no API cap holds it (project.json
# api-cap-hold, project:set-api-cap-hold) and the limited runs were not on
# the API already (the anthropic kind holds no limit). So:
#   - the claude kind held and the fallback available: exit 0 at once,
#     printing { rate-limit, api-fallback: true }: the run ends, the ticket
#     resumes where it was blocked, and control's next dispatch pays with the
#     API key;
#   - the claude kind held without the fallback, or the anthropic kind held
#     on a project with no .claude-api (its one credential an API key): exit
#     2, waiting — no failure counted (steps.js scriptExited) — until it
#     resets. The variation's Health (ai-feedback-short) reads "Waiting for
#     the rate limit to reset at <time> (no API fallback)", ai-feedback-long
#     saying why there is none; written, logged and said on stderr only when
#     it changes, the wait kept on the variation as rate-limit-wait { kind,
#     type, resets-at, feedback }. The ticket stays at Blocked, which is no
#     blocked state: not Operator Needed, no notification (ASS-383);
#   - nothing holds the project's agents (reset since, or it was never
#     recorded): exit 0, the kept wait dropped. After a wait it prints {
#     rate-limit-reset: true, rate-limit }; with no wait kept, { rate-limit-held:
#     false }: Classify's call was not borne out by a recorded limit, and
#     ticket:fix-attempts counts such resumes, so one misread keeps no ticket
#     going round for ever.
# Exits 0 print ai-feedback-short and -long null: the waiting Health cleared.
# Each end, and the wait's start, is logged in the change log (work.bash
# blocked_log, ASS-390 AC3). Fails (1) on bad arguments or a bad variation.
# PROJECTS_DIR overrides the projects folder.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../vm.bash"   # variation_exists
source "$here/../code.bash"   # variation_field
source "$here/../work.bash"   # blocked_log
set -E
trap 'exit 1' ERR

command=ticket:await-rate-limit step="Await Rate Limit"
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <variation>" >&2; exit 1; }
project="$1" key="$(upper "$2")" name="$3"
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; exit 1; }
variation_exists "$command" "$project" "$key" "$name"
dir="$projects/$project"

limits='{}'
[[ -f "$dir/rate-limit.json" ]] && jq -e 'type == "object"' "$dir/rate-limit.json" >/dev/null 2>&1 && limits="$(jq -c . "$dir/rate-limit.json")"
api=false
[[ -d "$dir/.claude-api" ]] && api=true
cap="$(jq -c '.["api-cap-hold"] // null' "$dir/project.json")"

# What holds the ticket: { act: fallback|wait|none, limit: { kind, type, resets-at }, why }.
decision="$(jq -nc --argjson l "$limits" --argjson api "$api" --argjson cap "$cap" '
  def at($k): $l[$k]["resets-at"] // null;
  def held($k): at($k) as $t | ($t | type) == "string" and (($t | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch 0) > now);
  def limit($k): { kind: $k, type: ($l[$k].type // "unknown"), "resets-at": at($k) };
  def when($t): $t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | strftime("%Y-%m-%d %H:%M UTC");
  if held("claude") then
    if $api and $cap == null and (held("anthropic") | not) then { act: "fallback", limit: limit("claude") }
    else { act: "wait", limit: limit("claude"),
      why: (if ($api | not) then "the project has no API key fallback (no .claude-api folder)"
            elif $cap != null then "the API \($cap.cap // "spend") cap holds it ($\($cap["spend-usd"] // "?") spent of $\($cap["limit-usd"] // "?"))"
            else "the API key is rate limited too, until \(when(at("anthropic")))" end) } end
  elif held("anthropic") and ($api | not) then { act: "wait", limit: limit("anthropic"), why: "the limited runs were on the API key already" }
  else { act: "none" } end')"
act="$(jq -r .act <<< "$decision")"
kept="$(variation_field '.["rate-limit-wait"] // null' "$command" "$project" "$key" "$name")"

# The wait dropped from the variation, its Health cleared when still the one written here.
drop_wait() {
  [[ "$kept" != null ]] || return 0
  update_whole_ticket "$command" "$project" "$key" --arg name "$name" '
    .variations |= map(if .name != $name or .["is-deleted"] then . else
      (if .["ai-feedback-long"] == .["rate-limit-wait"].feedback then .["ai-feedback-short"] = null | .["ai-feedback-long"] = null else . end)
      | del(.["rate-limit-wait"]) end)'
}

case "$act" in
  fallback)
    drop_wait
    at="$(jq -r '.limit["resets-at"]' <<< "$decision")"
    blocked_log "$project" "$key" "$name" "$step" "Rate limited on the subscription (claude) until $at; the API key fallback is available (.claude-api, no API cap holding it, the API key not rate limited): $key resumes at once, its next agents paid by the API key."
    jq -c '{ "rate-limit": .limit, "api-fallback": true, "ai-feedback-short": null, "ai-feedback-long": null }' <<< "$decision"
    exit 0 ;;
  none)
    drop_wait
    if [[ "$kept" != null ]]; then
      blocked_log "$project" "$key" "$name" "$step" "The $(jq -r .kind <<< "$kept") rate limit has reset ($(jq -r '.["resets-at"]' <<< "$kept")): $key resumes where it was blocked."
      jq -c '{ "rate-limit-reset": true, "rate-limit": del(.feedback), "ai-feedback-short": null, "ai-feedback-long": null }' <<< "$kept"
    else
      blocked_log "$project" "$key" "$name" "$step" "Classify said the block was a Claude rate limit, but none is recorded as holding $project's agents now (rate-limit.json): $key resumes where it was blocked."
      jq -nc '{ "rate-limit-held": false, "ai-feedback-short": null, "ai-feedback-long": null }'
    fi
    exit 0 ;;
esac

# Waiting: the Health written, and logged, only when it changes.
feedback="$(jq -c --arg key "$key" '
  (.limit["resets-at"] | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | strftime("%Y-%m-%d %H:%M UTC")) as $when
  | { short: "Waiting for the rate limit to reset at \($when) (no API fallback)",
      long: "\($key) was blocked by a Claude rate limit (\(.limit.type)) on the \(if .limit.kind == "claude" then "subscription" else "API key" end), which resets at \($when). No API fallback: \(.why). It waits at Blocked and resumes where it was blocked once the limit resets; nothing for you to do." }' <<< "$decision")"
long="$(jq -r .long <<< "$feedback")"
was="$(variation_field '.["ai-feedback-long"] // ""' "$command" "$project" "$key" "$name" | jq -r .)"
if [[ "$was" != "$long" || "$(jq -r '.feedback // ""' <<< "$kept")" != "$long" ]]; then
  update_whole_ticket "$command" "$project" "$key" --arg name "$name" --argjson limit "$(jq -c .limit <<< "$decision")" --arg s "$(jq -r .short <<< "$feedback")" --arg l "$long" '
    .variations |= map(if .name != $name or .["is-deleted"] then . else
      .["ai-feedback-short"] = $s | .["ai-feedback-long"] = $l | .["rate-limit-wait"] = ($limit + { feedback: $l }) end)'
  blocked_log "$project" "$key" "$name" "$step" "$long"
  echo "$command: $key $name: $long" >&2
fi
jq -c '{ "rate-limit": .limit, "api-fallback": false, why }' <<< "$decision"
exit 2
