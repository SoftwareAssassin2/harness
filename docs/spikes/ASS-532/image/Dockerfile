# ASS-532 spike: the harness project's golden-image definition
# (data/projects/harness/golden-image/provision.sh, copied verbatim beside this
# file) run as a Dockerfile, plus what a Substrate sandbox needs:
# - the Substrate sandbox demo's /process server (an HTTP exec endpoint: the
#   Substrate API has no exec, so a sandbox must serve its own),
# - docker.io, to try Docker inside the sandbox,
# - a clone of the harness repo at /repos/harness, as the golden VM's
#   repositories.sh does.
FROM debian:trixie
# curl and xz: the Lima cloud image has them and the golden steps assume them.
RUN apt-get update && apt-get install -y --no-install-recommends sudo git ca-certificates curl xz-utils \
    && useradd -m -s /bin/bash agent && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent
COPY git.sh provision.sh /tmp/
USER agent
# The golden VM's shared steps come first (build-golden.sh): git.sh builds
# git >= 2.48 (worktree add --relative-paths). Without it the harness's own
# worktree tests fail. desktop.sh, memory.sh (VM kernel settings), registry.sh
# (dockerd mirror) and finish.sh are VM-only; repositories.sh is the COPY below.
RUN bash /tmp/git.sh
RUN bash /tmp/provision.sh
USER root
RUN apt-get update && apt-get install -y --no-install-recommends docker.io iptables procps \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY sandbox-server /usr/local/bin/sandbox-server
COPY tlshold.mjs /usr/local/bin/tlshold.mjs
COPY repo /repos/harness
RUN chown -R agent:agent /repos
ENV PORT=80
CMD ["/usr/local/bin/sandbox-server"]
