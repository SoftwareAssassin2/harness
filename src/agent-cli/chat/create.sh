#!/usr/bin/env bash
# Description: Start a chat on the chat screen — chat:create <project> <title>; prints it.
set -euo pipefail

# Appends { id (a new uuid), project, title, created (now, UTC), session-id:
# null } to chats.json (see chats.bash) and prints it. Fails, writing
# nothing, on a bad project or a blank title.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/chats.bash"

[[ $# -eq 2 ]] || { echo "usage: chat:create <project> <title>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "chat:create: invalid project '$1'" >&2; exit 1; }
[[ -n "${2//[[:space:]]/}" ]] || { echo "chat:create: the title is empty" >&2; exit 1; }

chat="$(jq -nc --arg id "$(uuidgen | tr '[:upper:]' '[:lower:]')" --arg project "$1" --arg title "$2" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{ id: $id, project: $project, title: $title, created: $at, "session-id": null }')"
update_json "$(chats_file)" --argjson chat "$chat" '.chats += [$chat]'
jq . <<< "$chat"
