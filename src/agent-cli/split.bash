# The tickets a split already made (ASS-266), for ticket:propose-split and
# ticket:apply-split (ASS-252), so a split tried again after a partial apply
# never creates one twice.
#
#   source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../split.bash"
#   split_made <command> <home> <key> [<proposal-file>]   # [{ key, title }…], in key-number order
#
# A ticket was made for <key>'s split when the proposal file records its key
# (a ticket's key, set by apply as it creates one, or an already-created
# entry, set by propose) or when its context carries the marker apply writes
# on each, "Split from <KEY> (": that finds one whose key was never recorded,
# a run stopped between creating it and writing its key. Read from
# off-board.sh ticket:list in <home>; a Done one, closed by the operator, is
# none. Needs ticket-system.bash (off_board_run) sourced.

split_made() {
  local command="$1" home="$2" key="$3" file="${4:-}" recorded='[]'
  [[ -n "$file" && -f "$file" ]] && recorded="$(jq -c '[((.tickets // [])[].key), ((.["already-created"] // [])[].key)] | map(strings)' "$file" 2>/dev/null || echo '[]')"
  off_board_run "$command" ticket:list "$home" | jq -c --arg key "$key" --argjson recorded "$recorded" '
    [.[] | select(.key != $key and .status != "Done"
        and (.key as $k | ($recorded | index([$k])) or ((.description // "") | contains("Split from \($key) ("))))
     | { key, title }]'
}

# same_title — jq: a title compared case and edge spaces aside.
# shellcheck disable=SC2034
split_same_title='def same_title: ascii_downcase | gsub("^\\s+|\\s+$"; "");'
