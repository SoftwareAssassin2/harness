#!/usr/bin/env bash
# Description: Keep every VM off the Mac's own services on its vzNAT network, with pf — vm:firewall [--install]; prints the rules, --install loads them (sudo).
set -euo pipefail

# A VM reaches the Mac two ways (ASS-69). Through its host agent, at
# host.lima.internal (192.168.5.2), which Lima maps onto the Mac's loopback:
# vm:start runs that host agent in a sandbox that lets it reach only the
# forwarder, its project's zot and its own ssh port. And over vzNAT, macOS's
# vmnet shared network (192.168.64.0/24, the Mac 192.168.64.1 on bridge100),
# where any service of the Mac's bound to every address answers it (Docker's
# 5432, ControlCenter's 5000…): these pf rules drop all of that but DNS and
# DHCP — and the rest of the Mac's LAN with it — while the VM's own traffic
# out to the internet, which vmnet NATs, is untouched; so is the Mac's to the
# VM (the demo browser, ASS-76). Both are on the Mac, out of reach of the
# agent, who has sudo in its VM (AC6).
#
# With no argument, prints the rules. With --install (it asks for your
# password, through sudo): writes them to /etc/pf.anchors/com.harness.vm,
# loads them as the anchor com.apple/harness-vm (macOS's /etc/pf.conf
# evaluates every com.apple/* anchor, so the system file is never edited),
# enables pf, and installs /Library/LaunchDaemons/com.harness.vm-firewall.plist
# to load and enable them again at every boot. Run again, it replaces them.
# VM_SUBNET overrides the vzNAT subnet.
subnet="${VM_SUBNET:-192.168.64.0/24}"
[[ "$subnet" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || { echo "vm:firewall: invalid VM_SUBNET '$subnet'" >&2; exit 1; }
gateway="${subnet%.*}.1"
# pf expands self when the rules load, and bridge100 (with 192.168.64.1) is
# there only while a vzNAT VM runs, so every private, loopback and
# link-local range is dropped too — the Mac's own addresses there, whatever
# they become, and the rest of its LAN. The Mac's own connections to a VM
# keep state, so their replies come back.
rules="# The harness's VMs (vm:firewall, ASS-74): from vzNAT, nothing of the Mac's but DNS and DHCP.
pass out quick inet from any to $subnet keep state
pass in quick inet proto { udp, tcp } from $subnet to $gateway port 53
pass in quick inet proto udp from $subnet port 68 to any port 67
block drop in quick inet from $subnet to { self, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10 }
pass out quick on bridge100 inet6 keep state
pass in quick on bridge100 inet6 proto icmp6
block drop in quick on bridge100 inet6 to { self, fc00::/7, fe80::/10 }"

case "${1:-}" in
  "") printf '%s\n' "$rules" ;;
  --install)
    anchor=/etc/pf.anchors/com.harness.vm daemon=/Library/LaunchDaemons/com.harness.vm-firewall.plist
    printf '%s\n' "$rules" | sudo tee "$anchor" >/dev/null
    sudo pfctl -q -a com.apple/harness-vm -f "$anchor"
    sudo pfctl -q -E 2>/dev/null || true   # already enabled is fine
    cat <<EOF | sudo tee "$daemon" >/dev/null
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.harness.vm-firewall</string>
  <key>ProgramArguments</key>
  <array><string>/sbin/pfctl</string><string>-E</string><string>-a</string><string>com.apple/harness-vm</string><string>-f</string><string>$anchor</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
    sudo launchctl bootout system "$daemon" 2>/dev/null || true
    sudo launchctl bootstrap system "$daemon"
    echo "vm:firewall: loaded into pf as com.apple/harness-vm, and at every boot ($daemon)" ;;
  *) echo "usage: vm:firewall [--install]" >&2; exit 1 ;;
esac
