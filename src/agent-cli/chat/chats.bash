# The chat screen's chats (ASS-33): chats.json in data/, { chats: [
# { id, project, title, created, session-id } ] }, kept apart from every other
# file. CHATS_FILE overrides the path, used by tests. chats_file makes it,
# empty, when missing — never over one there — and prints its path.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../json-file.bash"

chats_file() {
  local file="${CHATS_FILE:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../data/chats.json}"
  ( set -o noclobber; printf '{\n    "chats": []\n}\n' > "$file" ) 2>/dev/null || true
  echo "$file"
}

# update_chat <command> <id> [jq options…] '<filter on the chat>' — the chat
# with that id rewritten by the filter (empty to remove it); fails, writing
# nothing, when there is none.
update_chat() {
  local command="$1" id="$2" file
  shift 2
  file="$(chats_file)"
  update_json "$file" --arg command "$command" --arg id "$id" "${@:1:$#-1}" '
    if any(.chats[]; .id == $id) then . else error("\($command): no chat \($id)") end
    | .chats |= map(if .id == $id then ('"${*: -1}"') else . end)'
}
