#!/bin/bash
# In a VM started with a display, for vm:demo (ASS-76 AC3): its desktop
# started and the demo plan's tool opened on it, as the VM's user —
#   demo-desktop.sh browser <address> | terminal <command…> | other
# lightdm (desktop.sh: not started at boot) logs the VM's user straight into
# Xfce; once that session's xfce4-session runs, its DISPLAY, XAUTHORITY and
# D-Bus are the tool's. The browser opens at the address; the terminal at
# /repos/, the commands shown and in its history (↑ recalls them), for the
# operator to run; for other, the desktop alone. The tool is detached, so the
# shell this runs in ends at once. Fails, saying why, when the session does
# not start within DEMO_SESSION_TIMEOUT seconds (60).
set -euo pipefail
R="${HARNESS_VM_ROOT-}"   # empty in a VM; tests run this against a folder standing in for its root
sudo systemctl start lightdm
pid=""
for (( i = 0; i < ${DEMO_SESSION_TIMEOUT:-60}; i++ )); do
  pid="$(pgrep -u "$(id -un)" -x xfce4-session | head -n 1)" || true
  [[ -z "$pid" ]] || break
  sleep 1
done
[[ -n "$pid" ]] || { echo "the desktop did not start: no xfce4-session for $(id -un) (systemctl status lightdm)" >&2; exit 1; }
while IFS= read -r -d '' pair; do
  case "$pair" in DISPLAY=*|XAUTHORITY=*|DBUS_SESSION_BUS_ADDRESS=*|XDG_RUNTIME_DIR=*) export "${pair?}" ;; esac
done < "$R/proc/$pid/environ"
case "$1" in
  browser) setsid -f firefox-esr "$2" ;;
  terminal)
    shift
    rc=/tmp/harness-demo.rc
    mkdir -p "$R/tmp"
    { echo '[ -f ~/.bashrc ] && . ~/.bashrc'
      echo "echo \"The demo's commands, to run here (↑ recalls them):\""
      for command in "$@"; do printf 'history -s %q\necho "  "%q\n' "$command" "$command"; done
    } > "$R$rc"
    setsid -f xfce4-terminal --working-directory=/repos -x bash --rcfile "$rc" -i ;;
  other) ;;
esac >/dev/null 2>&1 </dev/null
