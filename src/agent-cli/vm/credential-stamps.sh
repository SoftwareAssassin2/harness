#!/usr/bin/env bash
# Description: Each of a project's declared VM credentials' keychain modification times, never their values — vm:credential-stamps <project>; prints JSON { "<kind>": "<mdat>" }.
set -euo pipefail

# ASS-350: what control compares with the stamps vm:credentials recorded on
# each VM's vms.json row (credential-stamps), once per VM job pass per project
# (vm-lifecycle.js), to refresh a running VM whose keychain item was saved
# again since — a rotated key. Reads the items' attributes only
# (vm-credentials.bash read_stamps: `security find-generic-password -s
# <service>`, no -w or -g), so no token is read, printed or written. atlassian
# is never stamped (it never goes into a VM); an item that cannot be read is
# left out. Fails, naming why, when the project declares no credentials.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../vm-credentials.bash"

[[ $# -eq 1 ]] || { echo "usage: vm:credential-stamps <project>" >&2; exit 1; }
[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "vm:credential-stamps: invalid project '$1'" >&2; exit 1; }
decl="$(declared_credentials vm:credential-stamps "$1")"
read_stamps "$decl"
