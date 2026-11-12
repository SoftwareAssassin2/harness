# ASS-394: a test the merge gate (merge-request/merge-in-turn.sh) found
# failing on the project's latest master too — master's flake or bug, not the
# ticket's — raised once in that project, never twice for the same test.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../master-test-failures.bash"
#   raise_master_failures <command> <project> <names-json> <context>
#     <names-json> a JSON array of test names (test-results.js's "<file>: <test>",
#     or a command when the output named none); <context> a line for the
#     ticket's Context. Prints the keys of the tickets raised for them, a JSON
#     array, the earlier one for a test raised before.
#
# The record, data/projects/<project>/master-test-failures.json, holds
# { "<name>": { ticket, "raised-at", "raised-by" } } for every test raised. A
# name in it is never raised again; the rest are raised together, one ticket.
# Its one writer is the gate, which holds the project's merge lock while it
# runs, so two gates never raise the same test at once. Where it goes is the
# existing rule for a project issue (ASS-163, project:check-on-master): only
# a failure on the latest master — which the gate has just run — and in the
# project's own ticket system, through the commands create-ticket-grouped's
# writer uses: the harness project's issues are its own backlog, and any
# project's off-board work source takes them by off-board.sh ticket:create;
# a Jira one by agent.sh ticket:raise-bug. A project with neither has nowhere
# to raise one: the test is recorded with a null ticket, so it is not tried
# again either. A create that fails records nothing, so the next gate that
# meets the test tries again.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/ticket-system.bash"
master_failures_here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

raise_master_failures() {
  local command="$1" project="$2" names="$3" context="$4"
  local registry="$projects/$project/master-test-failures.json" fresh key='' body out title
  [[ -s "$registry" ]] || echo '{}' | replace_file "$registry"
  fresh="$(jq -c --slurpfile r "$registry" '[.[] | . as $t | select($r[0] | has($t) | not)] | unique' <<< "$names")"
  if [[ "$(jq length <<< "$fresh")" -gt 0 ]]; then
    title="$(jq -r 'if length == 1 then "Fails on master: \(.[0])" else "Fails on master: \(.[0]) and \(length - 1) more" end | .[0:200]' <<< "$fresh")"
    body="$(mktemp)"
    if [[ -n "$(off_board_prefix "$command" "$project")" ]] || is_harness_project "$project"; then
      master_failures_markdown "$fresh" "$context" | replace_file "$body"
      out="$("$master_failures_here/../../off-board.sh" ticket:create "$project" Bug "$title" "$body" 6>&-)" || { rm -f "$body"; echo "$command: could not raise $title" >&2; return 1; }
      key="$(jq -r '.key // empty' <<< "$out")"
    elif [[ "$(ticket_system "$command" "$project")" == jira ]]; then
      master_failures_adf "$fresh" "$context" | replace_file "$body"
      out="$("$master_failures_here/ticket/raise-bug.sh" "$project" "$title" "$body" 6>&-)" || true
      key="$(jq -r '.key // empty' <<< "${out:-null}" 2>/dev/null || true)"
      [[ -n "$key" ]] || { rm -f "$body"; echo "$command: could not raise $title" >&2; return 1; }
    else
      echo "$command: $project has no ticket system to raise $title in; recorded, not raised" >&2
    fi
    rm -f "$body"
    jq --argjson fresh "$fresh" --arg k "$key" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg by "$command" \
      '. + ([$fresh[] | { key: ., value: { ticket: (if $k == "" then null else $k end), "raised-at": $at, "raised-by": $by } }] | from_entries)' \
      "$registry" | replace_file "$registry"
  fi
  jq -c --argjson n "$names" '[.[$n[]] | .ticket // empty] | unique' "$registry"
}

# master_failures_markdown <names-json> <context> — the ticket's body, create-ticket-grouped's headings.
master_failures_markdown() {
  jq -r --arg c "$2" '"## User story\n\nAs the operator, I want the tests below to pass reliably on master, so that merge gates stop failing on them.\n\n## Context\n\n\($c)\n\nFailing on master (failed, failed again, and failed on the latest master):\n\n" + (map("- \(.)") | join("\n"))
    + "\n\n## Acceptance criteria\n\n" + ([to_entries[] | "\(.key + 1). AC\(.key + 1): \(.value) passes on master, run 10 times in a row."] | join("\n")) + "\n"' <<< "$1"
}

# master_failures_adf <names-json> <context> — the same as ADF JSON, for ticket:raise-bug.
master_failures_adf() {
  jq -c --arg c "$2" 'def p($t): { type: "paragraph", content: [{ type: "text", text: $t }] };
    def h($t): { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: $t }] };
    { type: "doc", version: 1, content: [
      h("User story"), p("As the operator, I want the tests below to pass reliably on master, so that merge gates stop failing on them."),
      h("Context"), p($c), p("Failing on master (failed, failed again, and failed on the latest master): " + join("; ")),
      h("Acceptance criteria"),
      { type: "orderedList", content: [to_entries[] | { type: "listItem", content: [p("AC\(.key + 1): \(.value) passes on master, run 10 times in a row.")] }] } ] }' <<< "$1"
}
