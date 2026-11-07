# A project's merge request title format (ASS-219), for agent:dispatch's
# {merge-request-title} (prompt.bash) and merge-request:check-details.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../merge-request-title.bash"
#   title_format <command> <project.json>   # the format's name; fails, naming it, on an unknown one
#   title_rule <format>                     # the format, as the prompts say it
#   title_fits <format> <key> <title>       # whether <title>, its draft prefix left off, is in <format> for ticket <key>
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
