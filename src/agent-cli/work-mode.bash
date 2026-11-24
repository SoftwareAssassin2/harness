# A ticket variation's work mode (ASS-556, src/control/work-mode.js): the writes of ticket:choose-work-mode,
# ticket:set-work-mode and ticket:escalate-work-mode, and the CI results merge-request:check records.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../work-mode.bash"   # after sprint.bash (or merge-requests.bash)
#   write_work_mode <command> <project> <ticket-key> <variation> '<change>'
#       <change>: { mode, by, reasons, ai?, forced?, files?, escalation? } — the variation's "work-mode" becomes that
#       mode, by and reasons, at now; ai, forced and files replace theirs when given; an escalation ({ trigger, why,
#       step, memory? }) is appended to its escalations; every write appends { mode, by, reasons, at, trigger? } to
#       its history (control logs the latest once: work-mode.js workModeNews).
#   record_ci_results <command> <project> <ticket-key> <variation> '<events>'
#       <events>: [{ mr, key, head, result }] — each not yet in the variation's "ci-results" (a failure by its merge
#       request and head, a pass by its merge request) appended, at now, with the variation's mode then ("unset" when
#       it has none). Nothing written when every one is there.
#   retain_memory <project> <document-id> <ticket-key> <content>
#       one fact retained in the project's Hindsight bank over its HTTP API (memories, as CLAUDE.md's retain), its
#       metadata the ticket; fails (1) when the project has no Hindsight port or it does not answer.
work_mode_projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/projects}"

write_work_mode() {
  local command="$1" project="$2" key="$3" variation="$4" change="$5"
  update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --argjson c "$change" '
    if any(.variations // [] | .[]; .name == $name and (.["is-deleted"] | not)) then . else error("\($command): no \($key) variation \($name)") end
    | .variations |= map(if .name != $name or .["is-deleted"] then . else
        (.["work-mode"] // {}) as $w
        | .["work-mode"] = ($w + { mode: $c.mode, by: $c.by, reasons: ($c.reasons // []), at: $at }
            + (if $c | has("ai") then { ai: $c.ai } else {} end)
            + (if $c | has("forced") then { forced: $c.forced } else {} end)
            + (if $c | has("files") then { files: $c.files } else {} end)
            + { escalations: (($w.escalations // []) + (if $c.escalation then [$c.escalation + { at: $at }] else [] end)),
                history: (($w.history // []) + [{ mode: $c.mode, by: $c.by, reasons: ($c.reasons // []), at: $at }
                  + (if $c.escalation then { trigger: $c.escalation.trigger } else {} end)]) })
      end)'
}

record_ci_results() {
  local command="$1" project="$2" key="$3" variation="$4" events="$5"
  [[ "$(jq 'length' <<< "$events")" -gt 0 ]] || return 0
  update_whole_ticket "$command" "$project" "$key" --arg name "$variation" --argjson events "$events" '
    .variations |= map(if .name != $name or .["is-deleted"] then . else
        (.["work-mode"].mode // "unset") as $mode
        | (.["ci-results"] // []) as $had
        | ([$events[] | . as $e | select(all($had[]; if $e.result == "failed" then (.mr != $e.mr or .head != $e.head or .result != "failed") else (.mr != $e.mr or .result != "passed") end))
            | . + { at: $at, mode: $mode }]) as $new
        | if $new == [] then . else .["ci-results"] = $had + $new end
      end)'
}

retain_memory() {
  local project="$1" doc="$2" key="$3" content="$4" port body
  port="$(jq -r '.hindsight.port // empty | numbers' "$work_mode_projects/$project/project.json" 2>/dev/null || true)"
  [[ -n "$port" ]] || return 1
  body="$(jq -nc --arg c "$content" --arg d "$doc" --arg k "$key" '{ items: [{ content: $c, document_id: $d, metadata: { ticket: $k, kind: "work-mode-ci" } }] }')"
  curl -sf --max-time 10 -X POST "http://127.0.0.1:$port/v1/default/banks/$project/memories" -H 'content-type: application/json' -d "$body" >/dev/null
}
