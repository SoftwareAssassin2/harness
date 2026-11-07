#!/usr/bin/env bash
# Description: Record a chat's Claude session, to resume it — chat:set-session <chat-id> <session-id>.
set -euo pipefail

# Writes session-id on the chat in chats.json (see chats.bash): the session
# `claude --resume` continues once its process has ended. Fails, writing
# nothing, when there is no such chat.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/chats.bash"

[[ $# -eq 2 ]] || { echo "usage: chat:set-session <chat-id> <session-id>" >&2; exit 1; }
update_chat chat:set-session "$1" --arg session "$2" '.["session-id"] = $session'
