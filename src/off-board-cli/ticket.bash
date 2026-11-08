# The off-board ticket store, for the ticket:* commands: one Markdown file per
# ticket, <OFF_BOARD_DIR>/<folder>/<KEY>.md — front matter (key, type, status,
# points when estimated, depends-on: <KEY>, <KEY> when set (ASS-194,
# ticket:set-dependencies), overlaps-with: <KEY>, <KEY> when set (ASS-196,
# ticket:set-overlaps), priority when set, fast-track: true on a
# fast-tracked ticket — ASS-83, ticket:create --fast-track, and ASS-306,
# ticket:mark-fast-track on one already created — kept-whole: true
# on a ticket the operator kept whole and split-into: <KEY>, <KEY> on one split
# into others — ASS-252, ticket:keep-whole and ticket:mark-split — created,
# updated) between `---` lines, an H1 title, then H2 sections, the
# acceptance criteria a numbered list under `## Acceptance criteria`.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../ticket.bash"
#   ticket_folder <command> <project>       # OFF_BOARD_DIR/<folder>, <folder> from the project's off-board work source
#   key_prefix <command> <project>          # the work source's key-prefix; fails when it has none
#   ticket_files <folder>                   # the folder's *.md, one path a line, in key-number order; nothing when the folder is missing
#   ticket_file <command> <project> <key>   # the ticket's file, its key matched in any case
#   ticket_key <file>                       # the canonical key: the file's name
#   priority_name <command> <name> [<more>] # <name> when it is one of $priorities; fails otherwise, <more> after the list of names
#   ticket_json <command> <file>            # the ticket as ticket:get prints it
#   rewrite_ticket <command> <file> [jq options…] '<filter>'   # rewrite the file; <filter> maps its lines (an array) to the new lines
#   lock_store <command> <folder>           # hold the folder's store lock until exit (ASS-175)
#
# <folder> comes from data/projects/<project>/project.json's work source of type
# off-board; PROJECTS_DIR overrides the projects folder and OFF_BOARD_DIR the
# store, used by tests. A rewrite checks the file first, goes to a temp file
# renamed over the original (a failed one writes nothing), stamps `updated`
# with the time now, UTC, and drops blank lines at the end. The filter has the
# parser's definitions: close (the front matter's closing line), h1 (the
# title line), ac_start (the `## Acceptance criteria` line, -1 when none),
# next_heading($from), index_of(f), lines, strip_blank, trim. Each fails,
# naming <command>, when the project is missing or has no off-board work
# source with a folder, the ticket is missing, or its file is malformed (no
# front matter, no key, no title).
#
# Every write to a folder — ticket:create's key allocation and file, and every
# rewrite — holds one store lock, <folder>/.lock (json-file.bash's lock_on,
# descriptor 7, JSON_LOCK_TIMEOUT seconds), until the command exits: two
# creates never take the same key, and a rewrite's read, checks and write are
# one transaction. A command that reads the ticket to decide its rewrite
# (ticket:add-acceptance-criteria's next number) takes it before that read;
# taking it again in the same process is a no-op.
projects="${PROJECTS_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../data/projects}"
off_board="${OFF_BOARD_DIR:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../off-board}"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../agent-cli/harness-project.bash"
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../agent-cli/json-file.bash"

upper() { tr '[:lower:]' '[:upper:]' <<< "$1"; }

# The priority names a ticket may carry, highest first: the ranking's
# (src/control/rank.js priorityOrder), so the downloader's
# ticket-system-priority ranks like a Jira ticket's.
priorities=('Highest' 'Critical' 'Very High' 'High' 'Medium' 'Low' 'Very Low' 'Lowest')

priority_name() {
  local name names
  for name in "${priorities[@]}"; do [[ "$2" == "$name" ]] && { echo "$2"; return 0; }; done
  names="$(printf ', %s' "${priorities[@]}")"
  echo "$1: '$2' is not a priority; one of ${names:2}${3:-}" >&2
  return 1
}

# off_board_source <command> <project> — the project's off-board work source,
# as JSON; for a project with none, the harness project's (harness.json
# harness-project: a harness ticket raised from any project lands there).
off_board_source() {
  local command="$1" project="$2" source harness
  [[ "$project" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$command: invalid project '$project'" >&2; return 1; }
  [[ -f "$projects/$project/project.json" ]] || { echo "$command: no project '$project'" >&2; return 1; }
  source="$(jq -c 'first(.["work-sources"][]? | select(.type == "off-board")) // empty' "$projects/$project/project.json")"
  if [[ -z "$source" ]]; then
    harness="$(harness_project)"
    [[ -n "$harness" && -f "$projects/$harness/project.json" ]] \
      && source="$(jq -c 'first(.["work-sources"][]? | select(.type == "off-board")) // empty' "$projects/$harness/project.json")"
  fi
  [[ -n "$source" ]] || { echo "$command: project '$project' has no off-board work source" >&2; return 1; }
  echo "$source"
}

ticket_folder() {
  local folder
  folder="$(off_board_source "$1" "$2" | jq -r '.folder // empty')" || return 1
  [[ -n "$folder" ]] || { echo "$1: project '$2' has no off-board folder" >&2; return 1; }
  echo "$off_board/$folder"
}

key_prefix() {
  local prefix
  prefix="$(off_board_source "$1" "$2" | jq -r '.["key-prefix"] // empty')" || return 1
  [[ -n "$prefix" ]] || { echo "$1: project '$2' has no off-board key-prefix" >&2; return 1; }
  echo "$prefix"
}

ticket_files() {
  local file number
  for file in "$1"/*.md; do
    [[ -e "$file" ]] || continue
    number="$(basename "$file" .md)"
    number="${number##*-}"
    [[ "$number" =~ ^[0-9]+$ ]] || number=0
    printf '%s\t%s\n' "$number" "$file"
  done | sort -n | cut -f2-
}

ticket_file() {
  local command="$1" project="$2" key="$3" folder file
  folder="$(ticket_folder "$command" "$project")" || return 1
  for file in "$folder"/*.md; do
    [[ "$(upper "$(ticket_key "$file")")" == "$(upper "$key")" ]] && { echo "$file"; return 0; }
  done
  echo "$command: no ticket $(upper "$key") in $project" >&2
  return 1
}

ticket_key() { basename "$1" .md; }

# The parser, shared by ticket_json and rewrite_ticket; `checked` is the
# malformed-file check. $command and $file are jq arguments.
ticket_defs='
  def malformed($why): error("\($command): \($file) is malformed: \($why)");
  def trim: sub("^\\s+"; "") | sub("\\s+$"; "");
  def lines: rtrimstr("\n") | split("\n");
  def strip_blank: if .[0] == "" then .[1:] | strip_blank elif .[-1] == "" then .[:-1] | strip_blank else . end;
  def index_of(f): first(range(length) as $i | select(.[$i] | f) | $i) // -1;
  def close: if .[0] != "---" then malformed("no front matter") else (.[1:] | index_of(. == "---")) as $i | if $i < 0 then malformed("no front matter") else $i + 1 end end;
  def h1: index_of(startswith("# ")) as $i | if $i < 0 then malformed("no title") else $i end;
  def ac_start: index_of(test("^## Acceptance criteria *$"));
  def next_heading($from): (.[$from:] | index_of(startswith("## "))) as $i | if $i < 0 then length else $from + $i end;
  def checked: close as $c | h1 as $h | if any(.[1:$c][]; test("^key: *[^ ]")) then . else malformed("no key") end;
'

ticket_json() {
  jq -Rs --arg command "$1" --arg file "$2" "$ticket_defs"'
    lines | checked | close as $c
    | (.[1:$c] | map(capture("^(?<k>[^:]+): *(?<v>.*)$") | { key: .k, value: .v }) | from_entries) as $fm
    | .[$c + 1:] | h1 as $h
    | { key: $fm.key, type: $fm.type, status: $fm.status, points: ($fm.points // null | if . == null then null else tonumber? // null end), priority: ($fm.priority // null), title: (.[$h] | ltrimstr("# ") | trim), created: $fm.created, updated: $fm.updated, file: $file,
        "depends-on": ($fm["depends-on"] // "" | split(",") | map(trim) | map(select(. != ""))),
        "overlaps-with": ($fm["overlaps-with"] // "" | split(",") | map(trim) | map(select(. != ""))) }
      + (if $fm["fast-track"] == "true" then { "fast-track": true } else {} end)
      + (if $fm["kept-whole"] == "true" then { "kept-whole": true } else {} end)
      + (if ($fm["split-into"] // "") != "" then { "split-into": ($fm["split-into"] | split(",") | map(trim) | map(select(. != ""))) } else {} end)
      + (.[$h + 1:] | {
          description: (join("\n") | trim),
          "acceptance-criteria": (ac_start as $s | if $s < 0 then [] else .[$s:next_heading($s + 1)]
            | map(capture("^(?<n>[0-9]+)\\. (?<text>.*)$") | { "criteria-number": (.n | tonumber), description: .text }) end) })' "$2"
}

store_locked=
lock_store() {
  [[ -n "$store_locked" ]] && return 0
  lock_on 7 "$2/.lock" "$1" "${JSON_LOCK_TIMEOUT:-30}" && store_locked=1
}

rewrite_ticket() {
  local command="$1" file="$2"
  shift 2
  local filter="${*: -1}" tmp
  lock_store "$command" "$(dirname "$file")" || return 1
  tmp="$(mktemp "$file.XXXXXX")"
  cp -p "$file" "$tmp"
  if jq -Rs -r --arg command "$command" --arg file "$file" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${@:1:$#-1}" "$ticket_defs"'
      lines | checked | ('"$filter"')
      | close as $c | to_entries | map(if .key < $c and (.value | startswith("updated:")) then .value = "updated: " + $at else . end) | map(.value)
      | strip_blank | join("\n")' "$file" > "$tmp"; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
    return 1
  fi
}
