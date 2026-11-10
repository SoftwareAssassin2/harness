# A project's merge request title format (ASS-219), for agent:dispatch's
# {merge-request-title} (prompt.bash), merge-request:check-details and
# merge-request:create (ASS-335).
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-request-title.bash"
#   title_format <command> <project.json>   # the format's name; fails, naming it, on an unknown one
#   title_rule <format>                     # the format, as the prompts say it
#   title_fits <format> <key> <title>       # whether <title>, its draft prefix left off, is in <format> for ticket <key>
#   title_of <format> <key> <title> <issue-type> [<note>]   # the title merge-request:create opens one with (below)
#
# project.json's "merge-request-title" names it:
#   "key-summary"  — the default, unset: `KEY: summary`
#   "conventional" — a conventional commit ending in the key, `type(scope): subject (KEY)`:
#                    what a GitLab CI mr-title lint job may require,
#                    its type and scope rule copied below.

# lint-title.sh's CONVENTIONAL_COMMIT_REGEX, the subject's length not checked.
CONVENTIONAL_TITLE='^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test|flow)(\([a-z0-9._/-]+\))?!?: .+'

title_format() {
  local format
  format="$(jq -r '.["merge-request-title"] // "key-summary"' "$2" 2>/dev/null || echo key-summary)"
  case "$format" in key-summary|conventional) echo "$format" ;; *) echo "$1: unknown \"merge-request-title\" \"$format\" in $2 (key-summary or conventional)" >&2; return 1 ;; esac
}

title_rule() {
  case "$1" in
    conventional) printf '%s' 'a conventional commit ending in the ticket key, "type(scope): subject (KEY)" — type one of build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test, flow; scope optional, lowercase letters, digits and . _ / -; e.g. "fix(search): stop the search timing out (ABC-1234)"' ;;
    *) printf '%s' 'the ticket key and summary, e.g. "ABC-1234: Fix the search timeout"' ;;
  esac
}

title_fits() {
  local title="$3" draft='^(draft:|\[draft\]|\(draft\))[[:space:]]*'
  [[ "$(tr '[:upper:]' '[:lower:]' <<< "$title")" =~ $draft ]] && title="${title:${#BASH_REMATCH[0]}}"
  case "$1" in
    conventional) [[ "$title" =~ $CONVENTIONAL_TITLE && "$title" == *" ($2)" ]] ;;
    *) [[ "$title" == "$2: "?* ]] ;;
  esac
}

# title_of — the title merge-request:create opens a merge request with
# (ASS-335), in the project's format, so a CI mr-title job passes from its
# first pipeline: key-summary "KEY: title"; conventional "type: title (KEY)",
# the type from the ticket's issue type (conventional_type) and the title's
# first letter lowered, unless its first word is an acronym. <note> (e.g.
# "MR 2", one of several) follows the title in brackets, before the "(KEY)".
title_of() {
  local format="$1" key="$2" title="$3" note="${5:+ ($5)}"
  case "$format" in
    conventional)
      [[ "$title" =~ ^[A-Z][a-z] ]] && title="$(tr '[:upper:]' '[:lower:]' <<< "${title:0:1}")${title:1}"
      printf '%s: %s%s (%s)' "$(conventional_type "$4")" "$title" "$note" "$key" ;;
    *) printf '%s: %s%s' "$key" "$title" "$note" ;;
  esac
}

# conventional_type <issue-type> — a Bug is a fix; a Task, Sub-task, Spike or Chore a chore; anything else (a Story, none) a feat.
conventional_type() {
  case "$(tr '[:upper:]' '[:lower:]' <<< "$1")" in
    bug) echo fix ;;
    task|sub-task|subtask|spike|chore) echo chore ;;
    *) echo feat ;;
  esac
}
