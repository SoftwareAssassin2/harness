#!/usr/bin/env bash
# Description: Record a proposal to split a ticket too large into smaller ones — ticket:propose-split <project> <ticket-key> <json-file|->.
set -euo pipefail

# ASS-252: Split's agent's one write, at the harness's backlog refinement's
# Split step; the operator sees the proposal at Awaiting Split Decision, and
# Accept creates its tickets (ticket:apply-split). The JSON, from the file or
# stdin (-), is { summary (optional), tickets: [ { title, type (Story, Bug or
# Spike; Story when left out), points (1, 2, 3 or 5), user-story, context,
# acceptance-criteria (non-empty strings, one line each), covers (the
# original's acceptance-criteria numbers it carries), depends-on (optional:
# the proposal's own tickets by their place in the list, 1 first, or keys of
# the project's other off-board tickets) }… ] }. Checked against the original
# (off-board.sh ticket:get, in its home project): at least two tickets; each
# with a single-line title, a user story, context and criteria; every
# criterion of the original covered by at least one, and none covered that it
# lacks; no ticket depending on itself, on a place the list lacks, on an
# unknown key or on the ticket being split; no cycle among them. Written,
# whole, to the ticket's work folder as split-proposal.json — { ticket,
# proposed-at, summary, tickets }, each ticket's type filled in and its
# depends-on keys canonical — under the file's lock, replacing any earlier
# proposal; the harness's own file (work.bash WORK_MANAGED), which work:write
# refuses. ASS-266: a proposal after a partial apply builds on the tickets
# that apply already made (split.bash split_made — the keys the earlier
# proposal recorded, or the marker each carries), so none is made twice: each
# is listed in already-created — { key, title, place } in key order — place
# the first ticket of this proposal with the same title (case and edge spaces
# aside) that no earlier one took, which ticket:apply-split then reuses,
# rewriting it to this proposal's; or null, the ticket left as it is, outside
# the split. The operator sees them with the proposal at the gate. With none
# made, no already-created. Prints { ticket, tickets } (how many). Fails,
# writing nothing, saying why, on anything else.
here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
source "$here/../ticket-system.bash"
source "$here/../work.bash"
source "$here/../split.bash"

command=ticket:propose-split
[[ $# -eq 3 ]] || { echo "usage: $command <project> <ticket-key> <json-file|->" >&2; exit 1; }
project="$1" key="$(tr '[:lower:]' '[:upper:]' <<< "$2")"
file="$(work_path "$command" "$project" "$key" - split-proposal.json)"
if [[ "$3" == - ]]; then input="$(cat)"; else [[ -f "$3" ]] || { echo "$command: no file $3" >&2; exit 1; }; input="$(cat "$3")"; fi
jq -e 'type == "object"' <<< "$input" >/dev/null 2>&1 || { echo "$command: the proposal is not JSON: an object { summary, tickets }" >&2; exit 1; }

home="$(home_project "$command" "$project" "$key")"
original="$(off_board_run "$command" ticket:get "$home" "$key")"
key="$(jq -r .key <<< "$original")"

# Each key a ticket depends on, resolved to its canonical spelling: { "<as written>": "<KEY>" }.
resolved='{}'
while IFS=$'\t' read -r place dep; do
  [[ -n "$dep" ]] || continue
  [[ "$(tr '[:lower:]' '[:upper:]' <<< "$dep")" != "$key" ]] || { echo "$command: ticket $place: cannot depend on $key, the ticket being split" >&2; exit 1; }
  got="$(off_board_run "$command" ticket:get "$home" "$dep" 2>/dev/null)" || { echo "$command: ticket $place: depends on $dep, no ticket of $home" >&2; exit 1; }
  resolved="$(jq -c --arg d "$dep" --arg k "$(jq -r .key <<< "$got")" '.[$d] = $k' <<< "$resolved")"
done < <(jq -r '.tickets // [] | if type == "array" then to_entries[] | (.key + 1) as $i | (.value["depends-on"]? // []) | if type == "array" then .[] | strings | "\($i)\t\(.)" else empty end else empty end' <<< "$input")

err="$(mktemp)"
trap 'rm -f "$err"' EXIT
checked="$(jq -c --arg key "$key" --argjson acs "$(jq -c '[.["acceptance-criteria"][]["criteria-number"]]' <<< "$original")" --argjson resolved "$resolved" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  def blank: type != "string" or test("^\\s*$");
  def line: (blank | not) and (test("\n") | not);
  def check(ok; $why): if ok then . else error($why) end;
  # No cycle: Kahn — tickets with nothing left to wait on taken out until none is left, or none can be.
  def acyclic($adj): { left: [range(0; $adj | length)] }
    | until((.left | length) == 0 or .stuck; .left as $l
        | [$l[] | select(($adj[.] - ($adj[.] - $l)) | length == 0)] as $free
        | if ($free | length) == 0 then .stuck = true else .left = ($l - $free) end)
    | .stuck != true;
  check((.tickets | type) == "array" and (.tickets | length) >= 2; "a proposal needs at least two tickets")
  | (.tickets | length) as $n
  | .tickets |= [to_entries[] | (.key + 1) as $i | .value
      | check(type == "object"; "ticket \($i): not an object")
      | check(.title | line; "ticket \($i): needs a title, one line")
      | check((.type // "Story") | IN("Story", "Bug", "Spike"); "ticket \($i): type must be Story, Bug or Spike")
      | check(.points | IN(1, 2, 3, 5); "ticket \($i): points must be 1, 2, 3 or 5")
      | check(.["user-story"] | blank | not; "ticket \($i): needs a user-story")
      | check(.context | blank | not; "ticket \($i): needs a context")
      | check((.["acceptance-criteria"] | type) == "array" and (.["acceptance-criteria"] | length) > 0 and all(.["acceptance-criteria"][]; line); "ticket \($i): needs acceptance-criteria, each a non-empty line")
      | check((.covers | type) == "array" and all(.covers[]; type == "number" and . == floor); "ticket \($i): covers must list criteria numbers")
      | (first(.covers[] | select(. as $c | $acs | index($c) | not)) // null) as $lacks
      | check($lacks == null; "ticket \($i): covers AC\($lacks), which \($key) does not have")
      | (.["depends-on"] // []) as $deps
      | check(($deps | type) == "array" and all($deps[]; type == "string" or (type == "number" and . == floor)); "ticket \($i): depends-on must list places in the proposal or ticket keys")
      | check(all($deps[]; . != $i); "ticket \($i): cannot depend on itself")
      | (first($deps[] | numbers | select(. < 1 or . > $n)) // null) as $out
      | check($out == null; "ticket \($i): depends on ticket \($out), which the proposal does not have")
      | { title, type: (.type // "Story"), points, "user-story", context, "acceptance-criteria", covers,
          "depends-on": (reduce ($deps[] | if type == "string" then $resolved[.] else . end) as $d ([]; if index([$d]) then . else . + [$d] end)) }]
  | ($acs - [.tickets[].covers[]]) as $missing
  | check(($missing | length) == 0; "\($key)'"'"'s AC\($missing[0]) is covered by no ticket")
  | check(acyclic([.tickets[] | [.["depends-on"][] | numbers | . - 1]]); "the tickets'"'"' dependencies make a cycle")
  | { ticket: $key, "proposed-at": $at, summary: (.summary // null), tickets }' <<< "$input" 2>"$err")" \
  || { echo "$command: $(sed -E 's/^jq: error \(at [^)]*\): //' "$err" | head -1)" >&2; exit 1; }

# The tickets an earlier apply made, each matched to the place here that reuses it.
made="$(split_made "$command" "$home" "$key" "$file")"
if [[ "$made" != '[]' ]]; then
  checked="$(jq -c --argjson made "$made" "$split_same_title"'
    reduce $made[] as $m (. + { "already-created": [] };
      (first(range(0; .tickets | length) as $i
        | select((.tickets[$i].title | same_title) == ($m.title | same_title) and ([.["already-created"][].place] | index([$i + 1]) | not))
        | $i + 1) // null) as $place
      | .["already-created"] += [{ key: $m.key, title: $m.title, place: $place }])' <<< "$checked")"
fi

lock_on 9 "$file.lock" "$command" "${JSON_LOCK_TIMEOUT:-30}"
jq --indent 4 . <<< "$checked" | replace_file "$file"
jq -nc --arg t "$key" --argjson n "$(jq '.tickets | length' <<< "$checked")" '{ ticket: $t, tickets: $n }'
