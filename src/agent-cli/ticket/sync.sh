#!/usr/bin/env bash
# Description: Merge tickets fetched from the ticket system into the sprint or backlog — ticket:sync <project> <sprint|backlog> <json-file>.
set -euo pipefail

# The downloader's one write of ticket data. <json-file> holds what it
# fetched: { "fetched-at": <ISO time>, "tickets": [ <ticket>… ], "merge-requests": [ { key,
# "build-status", url, status, branch, ticket }… ] }, each <ticket> in the sprint's ticket shape
# minus the harness's fields (key, title, description, url,
# ticket-system-status, -priority, -assignment, points, issue-type,
# dependencies, overlaps, sprint-tag — points left out when unread, ASS-152; and fast-track: true on a fast-tracked off-board
# ticket, ASS-83, carried onto the sprint or backlog ticket, never taken off).
# It is merged, in one locked write, into the
# project's active sprint file (data/projects/<project>/sprints/sprint-<n>/
# sprint.json; features, bugs or spikes by issue-type, a ticket moving to the
# array of its new type) or into backlog.json's tickets. PROJECTS_DIR
# overrides the projects folder, used by tests.
#
# A ticket already there (its key matching in any case) gets only those
# ticket-system fields overwritten (but for a
# sprint ticket's ticket-system-status set no earlier than the list was read —
# its ticket-system-status-at, ticket:set-ticket-system-status's, at or after
# the file's fetched-at, to the second — which stays: that list is stale,
# ASS-128; a file without fetched-at replaces it), and its variations' merge requests
# brought up to date from the file's (the downloader's scan, ASS-92/98: every
# merge request it fetched, each with the ticket it belongs to or null): a
# recorded one is never removed or moved, only refreshed from the fetched one
# with its url; one fetched for the ticket that it does not record yet is added
# (scanned, below); an empty or absent list changes nothing;
# its priority, manual-priority (manual-backlog-priority in the backlog,
# ASS-100), qa, and everything else of its variations
# are the harness's and stay; a changed title or description, in a sprint or
# the backlog, is first appended to its requirements history (below). A sprint
# ticket's changed description is not overwritten but held (ASS-77): as its
# pending-requirements-change { description, detected-at, paused-variations },
# the variations actively worked paused; or, its ticket-system-status Done
# (delivered), as its requirements-change-notified, with a comment on the
# ticket (ticket:post-comment) — see held, below. A new ticket gets the full shape: priority after
# the last (max + 1), manual-priority null (in the backlog
# manual-backlog-priority: a backlog rank never goes with a ticket into the
# sprint, ASS-100), qa { status: null }, one variation
# A — in the sprint, in the project's execution-state-engine at the step its
# ticket-system-status pairs with (paired-ticket-system-status): the earliest
# pipeline step (by sequence) paired with it, else a quarantine step paired
# with it, a human one first, else "backlog" (a status no step pairs with is
# then a gap, left to gap resolution); in the backlog, at the first step by
# sequence of the project's backlog refinement engine (the one its execution
# engine's backlog-refinement-steps runs, ASS-144; none without one: state
# and state-engine null). A backlog ticket whose title or description changes
# has its changed-at stamped and, at a resting step of that engine — a human
# step or the done step — goes back to the first step, the move appended to
# its state-changes as a move is; at a step mid-run it is left there, for
# control to groom again once it rests (Q7) — with
# the file's merge requests for its key or []. A ticket worked by hand
# (ASS-166, ticket:set-manual's worked-manually) takes a changed description
# as it is, nothing held or paused, and in the backlog is not sent back to its
# first step: control leaves it alone. Tickets in the file but not in
# the fetch are left as they are but for their recorded merge requests,
# refreshed from the scan by url (ASS-122): taking a ticket out of a sprint is
# control's call, not the downloader's. A ticket soft deleted (ASS-104,
# ticket:delete: is-deleted and its deleted-timestamp) stays so: an update
# keeps the mark as it keeps the harness's other fields, and a ticket new to
# this file that the other file (the backlog for the sprint, the sprint for
# the backlog) lists deleted arrives with its mark, so no download brings it
# back. A sprint sync (ASS-202) also stamps the ticket-system-status Done
# on each kept backlog.json entry (ASS-42) of a ticket now Done in the
# just-written sprint.json, nothing else touched; a backlog sync (ASS-202) of
# a ticket fetched Done takes the field updates and the requirements-history
# append, but no changed-at stamp and no move back to the refinement engine's
# first step. Then the backlog is renumbered (ticket:renumber-backlog --by control,
# ASS-84), after a sprint sync too: a ticket joining the sprint leaves the
# backlog's ranking. Prints "synced <n> tickets (<new> new)". Fails,
# writing nothing, on anything but sprint or backlog, a missing file, a
# ticket without a key, or a project without an active sprint.
# The engines are the project's own first, then engines/ (engine.bash, ASS-276).
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../engine.bash"
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/projects}"

[[ $# -eq 3 ]] || { echo "usage: ticket:sync <project> <sprint|backlog> <json-file>" >&2; exit 1; }
project="$1" target="$2" file="$3"
# The project becomes a path segment, so it may not climb out of the projects folder.
[[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ticket:sync: invalid project '$project'" >&2; exit 1; }
[[ "$target" == sprint || "$target" == backlog ]] || { echo "ticket:sync: the target must be sprint|backlog, not '$target'" >&2; exit 1; }
[[ -f "$file" ]] || { echo "ticket:sync: no file '$file'" >&2; exit 1; }

# The sprint (or backlog) is chosen, read and written inside the project's
# tickets.lock (ASS-174, as sprint.bash's edit_sprint): a sprint:advance lands
# wholly before or after, so no ticket is merged into a sprint just closed.
lock_on 3 "$projects/$project/tickets.lock" ticket:sync "${JSON_LOCK_TIMEOUT:-30}"
if [[ "$target" == sprint ]]; then
  number="$(jq -r 'first(.list[] | select(.["is-active"]) | .number) // empty' "$projects/$project/sprints.json")"
  [[ -n "$number" ]] || { echo "ticket:sync: project '$project' has no active sprint" >&2; exit 1; }
  json="$projects/$project/sprints/sprint-$number/sprint.json"
  state=backlog
  engine="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json")"
else
  json="$projects/$project/backlog.json"
  # The refinement engine's first step, and its resting steps (human or done) a change sends back there.
  state="" engine="" resting='[]'
  execution="$(jq -r '.["execution-state-engine"] // empty' "$projects/$project/project.json" 2>/dev/null || true)"
  [[ -n "$execution" ]] && execution_file="$(engine_path "$execution" "$project")" && engine="$(jq -r 'first(.["backlog-refinement-steps"] // [] | .[] | .action.engine // empty) // empty' "$execution_file")"
  if [[ -n "$engine" ]] && engine_file="$(engine_path "$engine" "$project")"; then
    state="$(jq -r '.steps // [] | sort_by(.sequence) | first | .id // empty' "$engine_file")"
    resting="$(jq -c '[.steps // [] | .[] | select(.action.type? == "human" or .["is-done"] == true) | .id]' "$engine_file")"
  else
    engine=""
  fi
fi
# Where a new sprint ticket starts, by its ticket-system status: { "<status>": "<step id>" }.
seeds='{}'
if [[ "$target" == sprint && -n "$engine" ]] && engine_file="$(engine_path "$engine" "$project")"; then
  seeds="$(jq -c '[.steps // [] | .[] | select(.["paired-ticket-system-status"] != null)]
    | group_by(.["paired-ticket-system-status"])
    | map({ key: .[0]["paired-ticket-system-status"],
            value: ((map(select(.area != "quarantine")) | sort_by(.sequence) | first)
                    // (sort_by(if .action.type == "human" then 0 else 1 end, .sequence) | first) | .id) })
    | from_entries' "$engine_file")"
fi

# The tickets the other file lists deleted: { "<lower-case key>": <deleted-timestamp> }.
if [[ "$target" == sprint ]]; then other="$projects/$project/backlog.json"; else other="$(jq -r 'first(.list[] | select(.["is-active"]) | "sprints/sprint-\(.number)/sprint.json") // empty' "$projects/$project/sprints.json" 2>/dev/null || true)"; other="${other:+$projects/$project/$other}"; fi
gone='{}'
[[ -z "$other" || ! -f "$other" ]] || gone="$(jq -c '[(.features, .bugs, .spikes, .tickets) // [] | .[] | select(.["is-deleted"] == true) | { key: (.key | ascii_downcase), value: .["deleted-timestamp"] }] | from_entries' "$other")"

# Counted before the write, for the report: the fetched keys not yet in the file.
total="$(jq -r '.tickets // [] | length' "$file")"
new="$(jq -r --slurpfile in "$file" '
  [(.features, .bugs, .spikes, .tickets) // [] | .[] | .key | ascii_downcase] as $have
  | [$in[0].tickets // [] | .[] | .key // "" | ascii_downcase | select(. != "" and IN($have[]) | not)] | length' "$json")"

# Requirements history (ASS-38), read as the count is: each changed title or
# description of a ticket already in this file, "<key>\t{ at, field, from,
# to }", the key as the file has it, appended to work/<key>/
# requirements-history.jsonl before the write — one line per append, as an
# agent's inbox is written (see inbox.bash). A ticket new to this file has
# nothing to compare (a first sight), even when it is in the other file. A
# sprint ticket holding a description (ASS-77, below) is compared by the last
# one seen — its pending, notified or dismissed one — so a held change is
# appended once. A description ticket:set-requirements or
# ticket:set-acceptance-criteria - rewrote (ASS-180) appended its own line and
# mirrored the harness's copy under the same lock, so this sees no change.
changes="$(jq -r --slurpfile in "$file" '
  if any($in[0].tickets // [] | .[]; (.key // "") == "") then error("ticket:sync: every ticket needs a key") else . end
  | [(.features, .bugs, .spikes, .tickets) // [] | .[]] as $have
  | (now | floor | todate) as $at
  | $in[0].tickets // [] | .[] as $t
  | first($have[] | select(.key | ascii_downcase == ($t.key | ascii_downcase))) // empty
  | select(.key | test("^[A-Za-z0-9_-]+$"))
  | (.description = (.["pending-requirements-change"].description // .["requirements-change-notified"] // .["dismissed-requirements-change"] // .description)) as $old
  | "title", "description" | select($old[.] != $t[.])
  | "\($old.key)\t\({ at: $at, field: ., from: $old[.], to: $t[.] } | tojson)"' "$json")"
while IFS=$'\t' read -r key entry; do
  [[ -n "$key" ]] || continue
  mkdir -p "$projects/$project/work/$key"
  append_line "$projects/$project/work/$key/requirements-history.jsonl" "$entry"
done <<< "$changes"

# Each sprint ticket's requirements-change-notified before the write (ASS-77):
# one the write changes is a delivered ticket's new description, commented on below.
notified="$(jq -c '[(.features, .bugs, .spikes) // [] | .[] | { key, value: .["requirements-change-notified"] }] | from_entries' "$json")"

update_json "$json" --slurpfile in "$file" --arg target "$target" --arg state "$state" --arg engine "$engine" --argjson resting "${resting:-[]}" --argjson seeds "$seeds" --argjson gone "$gone" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  def lc: ascii_downcase;
  def arr_of: if $target != "sprint" then "tickets" elif .["issue-type"] == "Bug" then "bugs" elif .["issue-type"] == "Spike" then "spikes" else "features" end;
  def arrays: if $target == "sprint" then "features", "bugs", "spikes" else "tickets" end;
  # The ticket-system fields, from the fetched ticket $t.
  def system_fields($t): ($t | { title, description, url, "ticket-system-status", "ticket-system-priority", "ticket-system-assignment", points, "issue-type", "sprint-tag" }) + { dependencies: ($t.dependencies // []), overlaps: ($t.overlaps // []) }
    + (if $t["fast-track"] == true then { "fast-track": true } else {} end);
  # A sprint ticket whose status was set (ticket-system-status-at) no earlier
  # than the list was read (fetched-at), both to the second, keeps it (ASS-128).
  def epoch: sub("\\.[0-9]+"; "") | fromdateiso8601;
  ($in[0]["fetched-at"] // null | if . == null then null else epoch end) as $fetched
  | def status_kept($old): $target == "sprint" and $fetched != null and $old["ticket-system-status-at"] != null and ($old["ticket-system-status-at"] | epoch) >= $fetched;
  # Points (ASS-152 AC3): fetched without points (unread: acli could not
  # view them) the ticket keeps its own; fetched null, a local estimate still
  # pending (the points-set-at ticket:set-points stamps) stays, the ticket system not
  # showing it yet; fetched a number, it is taken and the estimate is no
  # longer pending.
  def points_merged($old; $t):
    if ($t | has("points") | not) or ($t.points == null and $old["points-set-at"] != null and $old.points != null) then .points = $old.points
    elif $t.points != null then del(.["points-set-at"])
    else . end;
  def new_ticket($t; $priority; $mr): { key: $t.key } + system_fields($t) + {
      priority: $priority, (if $target == "sprint" then "manual-priority" else "manual-backlog-priority" end): null, qa: { status: null },
      variations: [{
        name: "A", "ai-feedback-short": null, "ai-feedback-long": null,
        "harness-status": { state: ($seeds[$t["ticket-system-status"] // ""] // (if $state == "" then null else $state end)), "state-engine": (if $engine == "" then null else $engine end) },
        build: { branch: null, "branch-url": null, worktree: null, "worktree-folder": null },
        "local-testing": {}, "acceptance-criteria": [], "merge-request": $mr,
        "gate-when-leaving-state": [], "is-paused": false, "human-review": null, "ai-variation-feedback": null, "state-changes": []
      }] } + (if $gone | has($t.key | ascii_downcase) then { "is-deleted": true, "deleted-timestamp": $gone[$t.key | ascii_downcase] } else {} end);
  # The variations of a ticket after the scan (ASS-92/98): $scan every merge request
  # fetched, each with the ticket it belongs to or null. A recorded one is never
  # removed or moved; one fetched with the same url (its identity: repository and
  # number, in any case) refreshes its key, url, build-status and status, on
  # each variation not deleted (refreshed: on every sprint ticket, fetched or
  # not, ASS-122). Those fetched for this ticket ($key) that none of its
  # variations records are added (scanned: only on a fetched ticket).
  def ident: (. // "") | lc | rtrimstr("/");
  def refreshed($scan):
    (reduce ($scan[] | select((.url | ident) != "")) as $f ({}; .[$f.url | ident] = ($f | { key, url, "build-status", status }))) as $by
    | map(if .["is-deleted"] or (.["merge-request"] | type) != "array" then .
          else .["merge-request"] |= map($by[.url | ident] as $f | if $f == null then . else . + $f end) end);
  def scanned($key; $scan):
    refreshed($scan)
    | [.[] | .["merge-request"][]? | .url | ident | select(. != "")] as $have
    | [range(length) as $i | select(.[$i]["is-deleted"] | not) | $i] as $live
    | if $live == [] then . else
        reduce ([$scan[] | select((.ticket // "" | lc) == $key and ((.url | ident) as $u | $u != "" and ($have | index([$u]) | not)))] | unique_by(.url | ident) | .[] | del(.ticket)) as $m (.;
          ($m.branch // "" | lc) as $b
          | def planned: .id != null and .url == null and (.branch // "" | lc) == $b;
          (first($live[] as $i | select(any(.[$i]["merge-request"][]?; planned)) | $i) // null) as $p
          | if $p != null then
              # A planned merge request (ASS-80) on its branch is filled from it.
              .[$p]["merge-request"] |= (first(to_entries[] | select(.value | planned) | .key) as $j | .[$j] += ($m | { key, url, "build-status", status }))
            else
              # Else it goes to the variation on its branch (its build branch, else change/<key>[.<name>]), else the first.
              (first($live[] as $i | select((.[$i].build.branch // ("change/" + $key + (if .[$i].name == "A" then "" else "." + .[$i].name end)) | lc) == $b) | $i) // $live[0]) as $v
              | .[$v]["merge-request"] = ((.[$v]["merge-request"] // []) + [$m])
            end)
      end;
  # A sprint ticket whose description changed (ASS-77): the ticket, merged
  # with its description kept, holds it. Delivered (its status Done), it
  # records the new one as requirements-change-notified, a comment due;
  # else as its pending-requirements-change, pausing each variation actively
  # worked (not deleted, not paused, not at backlog, committed or done) and
  # listing those in its paused-variations. One already held or notified is
  # left as it is, as is one the operator dismissed (ASS-78 Keep current: its
  # dismissed-requirements-change), which is forgotten once the fetched
  # description is another.
  def active: (.["is-deleted"] | not) and (.["is-paused"] | not) and (.["harness-status"].state | IN("backlog", "committed", "done") | not);
  def held($t):
    if .["ticket-system-status"] == "Done" then .["requirements-change-notified"] = $t.description
    elif .["pending-requirements-change"].description == $t.description or .["dismissed-requirements-change"] == $t.description then .
    else [.variations // [] | .[] | select(active) | .name] as $paused
      | .variations |= (if . == null then . else map(if active then .["is-paused"] = true else . end) end)
      | .["pending-requirements-change"] = { description: $t.description, "detected-at": (now | floor | todate),
          "paused-variations": ((.["pending-requirements-change"]["paused-variations"] // []) + $paused | unique) }
    end;
  # A changed backlog variation at a resting step of its refinement engine back at its first step (ASS-144 Q7), the move recorded
  # with cause "requirements-changed" (ASS-42: no exit of a step made it; see sprint.bash).
  def restarted:
    if (.["is-deleted"] | not) and $state != "" and (.["harness-status"].state | IN($resting[])) and .["harness-status"].state != $state then
      .["harness-status"].state as $from
      | .["harness-status"] = { state: $state, "state-engine": $engine }
      | .["state-changes"] = (.["state-changes"] // []) + [{ "state-engine": $engine, "from-state": $from, "to-state": $state, timestamp: $at, "agent-dispatch-log": [], "work-is-done": false, cause: "requirements-changed" }]
    else . end;
  ($in[0].tickets // []) as $tickets
  | ($in[0]["merge-requests"] // []) as $scan
  | if any($tickets[]; (.key // "") == "") then error("ticket:sync: every ticket needs a key") else . end
  | [arrays as $a | (.[$a] // [])[] | { arr: $a, t: . }] as $all
  | ([$all[].t.priority | numbers] | max // 0) as $max
  | (reduce $tickets[] as $t ({ updated: {}, new: [] };
      ($t.key | lc) as $key
      | (first($all[] | select(.t.key | lc == $key)) // null) as $old
      | [$scan[] | select(.ticket // "" | lc == $key) | del(.ticket)] as $mine
      | if $old != null then
          # A backlog ticket whose requirements (title, description) changed is groomed again.
          # A Done fetched ticket (ASS-202) is exempt: field updates and the
          # requirements-history append still apply, but no changed-at stamp
          # and no move back to the refinement engines first step. Keys on
          # the fetched status so a reopen (fetched Backlog, entry Done) is
          # not swallowed.
          (($target != "sprint") and ($t["ticket-system-status"] != "Done") and (($old.t.title != $t.title) or ($old.t.description != $t.description))) as $changed
          # A ticket worked by hand (ASS-166, worked-manually) takes the new data as it is: nothing held, paused or moved.
          | ($old.t["worked-manually"] != null) as $manual
          | .updated[$key] = ($old.t + system_fields($t)
            | if status_kept($old.t) then .["ticket-system-status"] = $old.t["ticket-system-status"] else . end
            | points_merged($old.t; $t)
            | if $target == "sprint" and $old.t.description != $t.description and ($manual | not) then .description = $old.t.description | held($t) else . end
            | if (.["dismissed-requirements-change"] // $t.description) != $t.description then del(.["dismissed-requirements-change"]) else . end
            | if $scan == [] then . else .variations |= (if . == null then . else scanned($key; $scan) end) end
            | if $changed then .["changed-at"] = $at
                | if $manual then . else .variations |= (if . == null then . else map(restarted) end) end
              else . end)
        else .new += [new_ticket($t; $max + (.new | length) + 1; $mine | unique_by(.url | ident))] end
    )) as $r
  | def current: $r.updated[.key | lc] // null;
  # A ticket not in the fetch keeps all but its recorded merge requests, refreshed.
  def kept: if $scan == [] or (.variations | type) != "array" then . else .variations |= refreshed($scan) end;
  . as $doc
  | reduce arrays as $a (.;
      .[$a] = [($doc[$a] // [])[] | (current // kept) | select(arr_of == $a)]
            + [$all[] | select(.arr != $a) | .t | current | select(. != null and arr_of == $a)]
            + [$r.new[] | select(arr_of == $a)])'

# ASS-202 AC2: in the sprint branch, copy Done onto the ticket's kept
# backlog.json entry (ASS-42) — ticket-system-status set to "Done", nothing
# else touched. Done keys are read from the just-written sprint.json, not the
# fetch, so an ASS-128 status_kept entry (fetch Done, sprint.json non-Done)
# does not wrongly stamp its backlog entry Done; still under the same
# tickets.lock. Nothing when the project has no backlog.json or no Done ticket.
if [[ "$target" == sprint && -f "$projects/$project/backlog.json" ]]; then
  done="$(jq -c '[(.features, .bugs, .spikes) // [] | .[] | select(.["ticket-system-status"] == "Done") | .key | ascii_downcase]' "$json")"
  if [[ "$done" != "[]" ]]; then
    update_json "$projects/$project/backlog.json" --argjson done "$done" '.tickets |= map(if ((.key // "") | ascii_downcase) as $k | $done | index($k) then .["ticket-system-status"] = "Done" else . end)'
  fi
fi
exec 3>&-
"$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/renumber-backlog.sh" "$project" --by control >/dev/null

# The delivered tickets' comment (ASS-77 AC4), posted after the write: a
# failure is reported on stderr and the merge stands.
keys="$(jq -r --argjson was "$notified" '(.features, .bugs, .spikes) // [] | .[]
  | select(.["requirements-change-notified"] != null and .["requirements-change-notified"] != $was[.key]) | .key' "$json")"
if [[ -n "$keys" ]]; then
  body="$(mktemp)"
  trap 'rm -f "$body"' EXIT
  echo "DETECTED CHANGING REQUIREMENTS AFTER TICKET IS ALREADY DELIVERED" > "$body"
  while read -r key; do
    "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/post-comment.sh" "$project" "$key" "$body" || echo "ticket:sync: could not comment on $key" >&2
  done <<< "$keys"
fi

echo "synced $total tickets ($new new)"
