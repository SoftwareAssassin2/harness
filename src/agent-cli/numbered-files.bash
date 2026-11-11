# A project's numbered files (ASS-385): migrations, numbered test files and the
# like, whose number must be above the target branch's highest and taken by no
# other open merge request — for merge-request:check-numbered-files and
# agent:dispatch's {numbered-files} (prompt.bash).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../numbered-files.bash"
#   numbered_rules <command> <project.json>   # the rules, a JSON list; fails, naming the problem, on a malformed declaration
#   numbered_rule_text <rules-json>           # the rules as the prompts say them
#   NUMBERED_JQ                               # (jq defs) glob_re: a glob as a regex; number: a path's number (null when none)
#
# project.json's "numbered-files" declares them, one entry per kind:
#   "numbered-files": [
#     { "kind": "migration", "glob": "**/V*__*.sql", "command": "scripts/next-free-number.sh migration" },
#     { "kind": "test",      "glob": "tests/db/*.sql" } ]
# kind names it (unique); glob picks its files, matched from the repository's
# root, as ci-checks.json's changes are (** any folders, * and ? within one,
# {a,b} either); command, optional, prints the next free number (its output's
# last number), run in the repository's checkout in the variation's VM. A
# file's number is the first run of digits in its name (V43__x.sql: 43;
# 0414_x.sql: 414); a file the glob matches with none is no numbered file.
# Each folder is a sequence of its own (a Flyway location). Unset, a project
# has one kind, Flyway's versioned migrations ("migration", **/V*__*.sql), its
# number found by the fallback; [] declares none.
NUMBERED_DEFAULT='[{ "kind": "migration", "glob": "**/V*__*.sql" }]'

NUMBERED_JQ='def glob_re: gsub("(?<c>[.+()|^$\\[\\]\\\\])"; "\\\(.c)") | gsub("\\{(?<a>[^{}]*)\\}"; "(" + (.a | gsub(","; "|")) + ")")
    | gsub("\\*\\*/"; "\u0001") | gsub("\\*\\*"; "\u0002") | gsub("\\*"; "[^/]*") | gsub("\\?"; "[^/]")
    | gsub("\u0001"; "(.*/)?") | gsub("\u0002"; ".*") | "^\(.)$";
  def number: split("/") | last | (capture("^[^0-9]*(?<n>[0-9]+)") | .n | tonumber) // null;'

numbered_rules() {
  local command="$1" json="$2" rules problem
  rules="$(jq -c --argjson d "$NUMBERED_DEFAULT" 'if has("numbered-files") then .["numbered-files"] else $d end' "$json" 2>/dev/null)" \
    || { echo "$command: $json is not valid JSON" >&2; return 1; }
  problem="$(jq -r '
    def check($at):
      if type != "object" then "\($at) must be an object"
      elif (.kind | type) != "string" or (.kind | test("^[A-Za-z0-9_-]+$") | not) then "\($at): \"kind\" must be a name (letters, digits, _ and -)"
      elif (.glob | type) != "string" or .glob == "" then "\($at): \"glob\" must be a non-empty string"
      elif has("command") and ((.command | type) != "string" or .command == "") then "\($at): \"command\" must be a non-empty string"
      elif (keys - ["kind", "glob", "command"]) != [] then "\($at): unknown key \"\((keys - ["kind", "glob", "command"])[0])\""
      else empty end;
    first(
      if type != "array" then "\"numbered-files\" must be a list of { kind, glob, command }"
      else (to_entries[] | .key as $i | .value | check("numbered-files[\($i)]")),
           (map(.kind) | group_by(.) | map(select(length > 1))[0][0] // empty | "numbered-files names the kind \"\(.)\" twice")
      end) // empty' <<< "$rules")"
  [[ -z "$problem" ]] || { echo "$command: $json: $problem" >&2; return 1; }
  echo "$rules"
}

numbered_rule_text() {
  jq -r 'if . == [] then "none: the project declares no numbered files"
    else map("\(.kind): files matching \(.glob), the next free number " + (if .command then "from `\(.command)`, run in the repository" else "one above the highest on the target branch and in the other open merge requests" end)) | join("; ") end' <<< "$1"
}
