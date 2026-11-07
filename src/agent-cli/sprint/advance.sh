#!/usr/bin/env bash
# Description: End an off-board project's sprint after its last day, or a Jira project's when the board has moved on, and begin the next, carrying its unfinished tickets — sprint:advance <project> [<YYYY-MM-DD> [--jira-sprint <id> <name> [<start> <end>]]].
set -euo pipefail

# Off-board projects only (ASS-142): a Jira-backed one's sprint comes from
# Jira, so a project with a jira work source is refused. <YYYY-MM-DD> is today
# (default: the machine's local date, as the downloader passes it). Nothing
# happens until today is past the active sprint's end; then sprint n+1 begins
# the day after it, as long as sprint n (end - start), named as n is with the
# number advanced ("Harness Sprint 1" → "Harness Sprint 2"), and becomes the
# only active entry of sprints.json. After several missed ends it advances to
# the sprint that holds today, each one skipped created empty and inactive.
#
# Every ticket but a finished one moves into the new sprint exactly as it
# stands, every field kept but its priority, so control and its agents work
# on unaware. The carried tickets' priorities are renumbered from 1 in their
# old order (one without a priority last), a manual priority following its
# ticket's, so the new sprint does not count on from the old one's;
# finished — every live variation (not is-deleted) at an is-done step of its
# state-engine (the project's execution-state-engine when it names none) —
# stays in the old sprint, with the old sprint's other fields
# (connected-flows: the new sprint starts its own counts).
#
# The whole advance holds the old sprint file's lock (json-file.bash, the one
# its other writes take), so no write to it lands between the read and the
# move: one that waited for it finds a carried ticket gone and fails, naming
# it, rather than writing to a sprint no longer active. The new sprint files
# are written first, then sprints.json (under its own lock), then the old
# sprint loses the carried tickets. Stopped before sprints.json, a rerun does
# the advance again; stopped after it, a rerun takes the carried tickets out
# of the old sprint, printing "<project> sprint <n>: <c> tickets taken out,
# carried into sprint <m>" (ASS-178). Running it again changes nothing: the
# new sprint holds today. Prints "<project> sprint <n> → <m>: <c> tickets
# carried, <d> left" when it advances, nothing otherwise. PROJECTS_DIR and
# ENGINES_DIR override the projects and engines folders, used by tests.
#
# --jira-sprint <id> <name> [<start> <end>] (ASS-165): a Jira project's
# sprint follows its board's active sprint, which the downloader passes (its
# dates, YYYY-MM-DD, when Jira gives them). Then the project must have a jira
# work source (an off-board one is not needed). When the active entry's
# jira-sprint-id is another, the advance is one sprint, whatever the dates:
# n+1 named <name>, from <start> to <end> (without them: starting today, as
# long as sprint n when n has a start and an end, else with no end), its
# sprints.json entry carrying "jira-sprint-id": <id>; the carrying is as
# above. When it is that id, the active sprint's start and end become
# <start> and <end> if they differ (edited in Jira), printing "<project>
# sprint <n>: <start> to <end>, as in Jira"; else nothing happens. Neither
# reads a pause: the sprint follows Jira while the project is paused.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../engine.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

jira_id="" jira_name=""
jira_start="" jira_end=""
if [[ ( $# -eq 5 || $# -eq 7 ) && "$3" == "--jira-sprint" ]]; then
  jira_id="$4" jira_name="$5" jira_start="${6:-}" jira_end="${7:-}"
  [[ $# -eq 5 || ( "$jira_start" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$jira_end" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ) ]] \
    || { echo "sprint:advance: the Jira sprint's dates must be YYYY-MM-DD, not '$jira_start' '$jira_end'" >&2; exit 1; }
  [[ "$jira_id" =~ ^[0-9]+$ ]] || { echo "sprint:advance: the Jira sprint id must be a number, not '$jira_id'" >&2; exit 1; }
  [[ -n "$jira_name" ]] || { echo "sprint:advance: the Jira sprint needs a name" >&2; exit 1; }
  set -- "$1" "$2"
fi
[[ $# -eq 1 || $# -eq 2 ]] || { echo "usage: sprint:advance <project> [<YYYY-MM-DD> [--jira-sprint <id> <name> [<start> <end>]]]" >&2; exit 1; }
project="$1" today="${2:-$(date +%F)}"
# The project becomes a path segment, so it may not climb out of the projects folder.
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "sprint:advance: invalid project '$project'" >&2; exit 1; }
[[ "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "sprint:advance: the date must be YYYY-MM-DD, not '$today'" >&2; exit 1; }
config="$projects/$project/project.json"
[[ -f "$config" ]] || { echo "sprint:advance: no project '$project'" >&2; exit 1; }
if [[ -n "$jira_id" ]]; then
  jq -e 'any(.["work-sources"][]?; .type == "jira")' "$config" > /dev/null \
    || { echo "sprint:advance: project '$project' has no jira work source" >&2; exit 1; }
else
  ! jq -e 'any(.["work-sources"][]?; .type == "jira")' "$config" > /dev/null \
    || { echo "sprint:advance: project '$project' is Jira-backed; its sprint comes from Jira" >&2; exit 1; }
  jq -e 'any(.["work-sources"][]?; .type == "off-board")' "$config" > /dev/null \
    || { echo "sprint:advance: project '$project' has no off-board work source" >&2; exit 1; }
fi

list="$projects/$project/sprints.json"
# The project's tickets.lock (ASS-174), before the sprint is read: every
# writer choosing between the active sprint and the backlog chooses inside it.
lock_on 3 "$projects/$project/tickets.lock" sprint:advance "${JSON_LOCK_TIMEOUT:-30}"
active() { jq -r 'first(.list[] | select(.["is-active"]) | .number) // empty' "$list"; }
number="$(active)"
[[ -n "$number" ]] || { echo "sprint:advance: project '$project' has no active sprint" >&2; exit 1; }
old="$projects/$project/sprints/sprint-$number/sprint.json"
[[ -f "$old" ]] || { echo "sprint:advance: no file '$old'" >&2; exit 1; }

lock_on 8 "$(readlink -f "$old").lock" sprint:advance "${JSON_LOCK_TIMEOUT:-30}"
[[ "$(active)" == "$number" ]] || exit 0   # advanced while waiting for the lock

# { "<engine>": [<its is-done step ids>] }, for "finished": every engine the
# project sees, its own over engines/'s (engine_files, ASS-276).
mapfile -t engine_list < <(engine_files "$project")
done_steps="$(jq -n 'reduce inputs as $e ({}; .[input_filename | split("/") | .[-2]] = [$e.steps[]? | select(.["is-done"] == true) | .id])' /dev/null "${engine_list[@]}" 2>/dev/null || echo '{}')"
engine="$(jq -r '.["execution-state-engine"] // ""' "$config")"
finished='def finished: [.variations // [] | .[] | select(.["is-deleted"] | not)] as $live
  | ($live | length > 0) and all($live[]; .["harness-status"].state as $s | any($done[.["harness-status"]["state-engine"] // $engine][]?; . == $s));'

# A rerun repairs an advance stopped after sprints.json's switch (ASS-178):
# an inactive sprint still holding a ticket unfinished there that the active
# one holds was the old sprint, not yet trimmed; it loses those tickets now.
carried='($active[0] | [(.features, .bugs, .spikes) // [] | .[] | .key | ascii_downcase]) as $carried
  | def carried: (.key | ascii_downcase | IN($carried[])) and (finished | not);'
trim=(--argjson done "$done_steps" --arg engine "$engine" --slurpfile active "$old")
inactive=()
while IFS= read -r k; do
  if [[ -f "$projects/$project/sprints/sprint-$k/sprint.json" ]]; then inactive+=("$projects/$project/sprints/sprint-$k/sprint.json"); fi
done < <(jq -r '.list[] | select(.["is-active"] | not) | .number' "$list")
while IFS=$'\t' read -r stale n; do
  update_json "$stale" "${trim[@]}" "$finished$carried"'(.features, .bugs, .spikes) |= (if . == null then . else map(select(carried | not)) end)'
  echo "$project sprint $(jq -r .number "$stale"): $n tickets taken out, carried into sprint $number"
done < <([[ ${#inactive[@]} -eq 0 ]] || jq -r "${trim[@]}" "$finished$carried"'
  [(.features, .bugs, .spikes) // [] | .[] | select(carried)] | length | select(. > 0) | "\(input_filename)\t\(.)"' "${inactive[@]}")

if [[ -n "$jira_id" ]]; then
  # The one Jira sprint, [] when the active entry is it already.
  if [[ "$(jq -r 'first(.list[] | select(.["is-active"]) | .["jira-sprint-id"]) // empty' "$list")" == "$jira_id" ]]; then
    # The sprint it already is: only its dates, when Jira's differ.
    [[ -n "$jira_start" && "$(jq -r '"\(.start) \(.end)"' "$old")" != "$jira_start $jira_end" ]] || exit 0
    tmp="$(mktemp "$old.XXXXXX")"
    jq --indent 4 --arg s "$jira_start" --arg e "$jira_end" '.start = $s | .end = $e' "$old" > "$tmp" && [[ -s "$tmp" ]] && mv "$tmp" "$old" || { rm -f "$tmp"; exit 1; }
    echo "$project sprint $number: $jira_start to $jira_end, as in Jira"
    exit 0
  fi
  plan="$(jq -c --arg today "$today" --argjson n "$number" --argjson id "$jira_id" --arg name "$jira_name" --arg start "$jira_start" --arg end "$jira_end" '
    def day: strptime("%Y-%m-%d") | mktime; def date: test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$");
    [{ number: ($n + 1), name: $name }
      + (if $start != "" then { start: $start, end: $end }
         elif (.start // "" | date) and (.end // "" | date) then { start: $today, end: (($today | day) + (.end | day) - (.start | day) | strftime("%Y-%m-%d")) }
         else { start: $today } end)
      + { "jira-sprint-id": $id }]' "$old")"
else
# The sprints from n+1 to the one holding today, [] when n still does.
plan="$(jq -c --arg today "$today" --argjson n "$number" '
  def day: strptime("%Y-%m-%d") | mktime;
  if (.start // "" | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$") | not) or (.end // "" | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$") | not)
  then error("sprint:advance: sprint \($n) needs a start and an end as YYYY-MM-DD") else . end
  | (.end | day) as $end | ($end - (.start | day)) as $length | ($today | day) as $t | (.name // "Sprint \($n)") as $name
  | [{ number: $n, end: $end } | recurse(if .end < $t then { number: (.number + 1), start: (.end + 86400), end: (.end + 86400 + $length) } else empty end)]
  | .[1:] | map(.number as $k | { number,
      name: ($name | if test("[0-9]+$") then sub("[0-9]+$"; "\($k)") else "\(.) \($k)" end),
      start: (.start | strftime("%Y-%m-%d")), end: (.end | strftime("%Y-%m-%d")) })' "$old")"
fi
[[ "$plan" != "[]" ]] || exit 0

# write <file> [jq options…] <filter> — the old sprint file rewritten as
# update_json would, the lock already held; or a new file made from it.
write() {
  local file="$1" tmp
  shift
  mkdir -p "$(dirname "$file")"
  tmp="$(mktemp "$file.XXXXXX")"
  jq --indent 4 --argjson done "$done_steps" --arg engine "$engine" "$@" "$old" > "$tmp" && [[ -s "$tmp" ]] && mv "$tmp" "$file" || { rm -f "$tmp"; return 1; }
}
last="$(jq -r '.[-1].number' <<< "$plan")"
while IFS= read -r sprint; do
  write "$projects/$project/sprints/sprint-$(jq -r .number <<< "$sprint")/sprint.json" --argjson s "$sprint" --argjson last "$last" "$finished"'
    . as $old | reduce ("features", "bugs", "spikes") as $a ($s | del(.["jira-sprint-id"]);
      .[$a] = (if $s.number == $last then [$old[$a] // [] | .[] | select(finished | not)] else [] end))
    | ([("features", "bugs", "spikes") as $a | .[$a] | to_entries[] | { $a, i: .key, p: .value.priority }] | sort_by(.p == null, .p)) as $order
    | reduce range(0; $order | length) as $r (.; $order[$r] as $o
        | .[$o.a][$o.i] |= (.priority = $r + 1 | if .["manual-priority"] == null then . else .["manual-priority"] = $r + 1 end))'
done < <(jq -c '.[]' <<< "$plan")
update_json "$list" --argjson plan "$plan" '
  [$plan[].number] as $new
  | .list = [.list[] | select(.number | IN($new[]) | not) | .["is-active"] = false]
          + [$plan[] | { number, "is-active": (.number == $plan[-1].number) } + (if has("jira-sprint-id") then { "jira-sprint-id" } else {} end)]'
counts="$(jq -r --argjson done "$done_steps" --arg engine "$engine" "$finished"'
  [(.features, .bugs, .spikes) // [] | .[]] | "\(map(select(finished | not)) | length) tickets carried, \(map(select(finished)) | length) left"' "$old")"
write "$old" "$finished"'(.features, .bugs, .spikes) |= (if . == null then . else map(select(finished)) end)'
echo "$project sprint $number → $last: $counts"
