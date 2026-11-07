#!/usr/bin/env bash
# Description: Delete a chat from the chat screen — chat:delete <chat-id>; its session log stays on disk.
set -euo pipefail

# Removes the chat from chats.json (see chats.bash); its log under data/chats/
# is kept. Fails, writing nothing, when there is no such chat.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/chats.bash"

[[ $# -eq 1 ]] || { echo "usage: chat:delete <chat-id>" >&2; exit 1; }
update_chat chat:delete "$1" 'empty'
