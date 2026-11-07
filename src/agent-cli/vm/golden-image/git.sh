#!/bin/bash
# Golden image step (vm:build-golden), shared by every project. Debian trixie
# ships git 2.47 and trixie-backports has none; every project needs >= 2.48
# (`git worktree add --relative-paths`: harness code:create-worktree,
# a workspace's doctor.sh). Builds the current git release into /usr/local
# (Rust parts off). From ASS-69's provision-git.sh.
set -euo pipefail
# sudo resets the environment (env_reset), so DEBIAN_FRONTEND is set on apt's
# own command line; apt's output is kept quiet but printed in full when it fails.
apt() {
  local out
  out="$(sudo DEBIAN_FRONTEND=noninteractive apt-get -y "$@" 2>&1)" || { printf '%s: apt-get %s failed:\n%s\n' "${0##*/}" "$1" "$out" >&2; return 1; }
}
V=$(curl --retry 5 --retry-all-errors -fsSL https://mirrors.edge.kernel.org/pub/software/scm/git/ | grep -oE 'git-2\.[0-9]+\.[0-9]+\.tar\.xz' | sort -V | tail -1 | sed 's/git-//; s/.tar.xz//')
DEPS='build-essential libcurl4-openssl-dev libexpat1-dev gettext zlib1g-dev libssl-dev libpcre2-dev'
# If libcurl came from trixie-backports, the -dev package must too.
apt install $DEPS 2>/dev/null || apt install -t trixie-backports $DEPS
cd /tmp && curl --retry 5 --retry-all-errors -fsSL "https://mirrors.edge.kernel.org/pub/software/scm/git/git-$V.tar.xz" | tar xJ
cd "git-$V" && make -s -j"$(nproc)" prefix=/usr/local NO_TCLTK=1 NO_PERL=1 NO_RUST=1 all >/dev/null && sudo make -s prefix=/usr/local NO_TCLTK=1 NO_PERL=1 NO_RUST=1 install >/dev/null
cd / && rm -rf "/tmp/git-$V"
apt purge build-essential; apt autoremove; apt clean
hash -r; git --version
