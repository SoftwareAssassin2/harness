#!/bin/bash
# Golden image step (vm:build-golden), shared by every project (ASS-76): a
# lightweight desktop for the Demo action at human review — Xfce (session,
# window manager, panel, terminal) with Firefox ESR, started by lightdm, which
# logs the VM user straight in. Not started at boot: an agent's VM has no
# display (the templates' video.display is "none"), so the default target is
# multi-user; the Demo action starts lightdm (systemctl start lightdm) in a VM
# it started with a display.
# Debian's cloud kernel has no DRM (no virtio-gpu, the display Lima's vz gives
# a VM) and no USB HID (its keyboard and pointer), so the generic kernel
# replaces it; it boots at the build's restart.
# Adds about 0.9 GiB (Debian trixie arm64, --no-install-recommends, measured
# in a bare debian:trixie container, an upper bound): Firefox ESR and X about
# 640 MiB, Xfce and lightdm about 190 MiB, the generic kernel about 100 MiB
# more than the cloud one.
# sudo resets the environment (env_reset), so DEBIAN_FRONTEND is set on apt's own
# command line: without it, removing the running cloud kernel asks to confirm
# (linux-check-removal), and with no terminal the removal aborts. apt's output
# is kept quiet but printed in full when it fails.
set -euo pipefail
apt() {
  local out
  out="$(sudo DEBIAN_FRONTEND=noninteractive apt-get -y "$@" 2>&1)" || { printf 'desktop.sh: apt-get %s failed:\n%s\n' "$1" "$out" >&2; return 1; }
}
arch="$(dpkg --print-architecture)"
apt update
apt install --no-install-recommends "linux-image-$arch" \
  xserver-xorg-core xserver-xorg-input-libinput fonts-dejavu-core dbus-x11 \
  lightdm lightdm-gtk-greeter xfce4-session xfwm4 xfce4-panel xfce4-terminal firefox-esr
mapfile -t cloud < <(dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 'linux-image-*cloud*' 2>/dev/null | awk '$1 == "ii" { print $2 }')
[[ ${#cloud[@]} -eq 0 ]] || apt purge "${cloud[@]}"
sudo install -d /etc/lightdm/lightdm.conf.d
printf '[Seat:*]\nautologin-user=%s\nautologin-session=xfce\n' "$(id -un)" | sudo tee /etc/lightdm/lightdm.conf.d/50-harness-demo.conf >/dev/null
sudo systemctl set-default multi-user.target
apt clean
ls /boot/vmlinuz-*; dpkg-query -W firefox-esr xfce4-session xfce4-terminal lightdm
