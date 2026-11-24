// The Dockerfile of a project's Substrate sandbox image (ASS-534), for one
// architecture: the golden definition run as the golden VM runs it, plus each
// declared service's files copied out of its pinned image, plus what a
// sandbox needs that a VM does not. substrate:build-image writes it into the
// build's context, laid out as
//   harness/git.sh, harness/repositories.sh   the golden image's shared steps (vm/golden-image/)
//   harness/provision.sh                      the golden definition's provision.sh, or the sandbox
//                                             folder's own (services.yaml provision)
//   harness/command-server/                   the command server's source (image/command-server/)
//   harness/sandbox-services                  the services' launcher (image/sandbox-services)
//   harness/sandbox-rootfs-exec               runs a program of a service's whole copied filesystem
//                                             with its own libraries (image/sandbox-rootfs-exec)
//   harness/sandbox-login                     signs an agent's browser in as the seeded user (ASS-542)
//   harness/sandbox-docker                    the `docker` a suite run sees: compose against the stack (ASS-542)
//   harness/services.json                     the normalized declaration, the launcher's input
//   files/<path>                              the sandbox folder's files (services.yaml files)
//
// What it runs, and why (the ASS-532 spike, docs/spikes/ASS-532-substrate.md
// section 3, found each):
// - The base is the golden VMs' distribution (Debian trixie), pinned by
//   digest, with curl and xz (git.sh assumes them; the Lima cloud image has
//   them), sudo, git, jq and procps, and the user `agent` with passwordless
//   sudo, as the VM's user is.
// - As agent: provision.sh, then the shared git.sh (git >= 2.48: worktree
//   add --relative-paths), unchanged and in the golden VM's order (apt's lists
//   kept until the last step: both install packages). desktop.sh and memory.sh (VM kernel
//   settings), registry.sh (the dockerd mirror: no Docker in a sandbox),
//   images.txt and finish.sh are VM-only and skipped.
// - The repositories baked in at /repos/<name> by the shared repositories.sh,
//   in place of the VM build's repositories step: its tokens (GitHub, then
//   GitLab, a line each) come in as the BuildKit secret `forge`, mounted for
//   that one RUN, so no token reaches a layer.
// - ASS-542: the declaration's prepare steps, as agent, after the
//   repositories (what a step needs from the network — a repository's
//   packages — is fetched here: a sandbox has no egress). One with npm: true
//   gets the BuildKit secret `npm` (a user config naming the project's GitLab
//   npm registries with its token, vm-credentials.json's gitlab) as
//   NPM_CONFIG_USERCONFIG for that one RUN: no token reaches a layer.
// - Each service's paths, COPY --from its image: a stage `svc-<name>`, either
//   a named build context (an OCI layout of the image, fetched through the
//   project's zot: contexts[<name>]) or a FROM of the pinned image itself.
//   Pinned by digest, for this architecture.
// - The declared Debian packages, the sandbox folder's files, and the
//   declaration at /etc/sandbox/services.json for sandbox-services.
// - The command server (Substrate has no exec API: a sandbox serves its own),
//   cross-compiled from source in a golang stage on the build's own platform,
//   so an amd64 image does not compile Go under emulation. It runs as root on
//   port 80, the image's CMD.
import { DEFAULT_BASE } from './services.js';

// Pinned by digest: the stage that compiles the command server.
export const GOLANG = { image: 'golang:1.26-trixie', digest: 'sha256:cff05dd6b81c901f2e8249eb6f91c69a60451d0f12c26bfef08e476a85b32d4d' };
// The base's own packages: git.sh and provision.sh assume curl and xz; sandbox-services needs jq and ps.
const BASE_PACKAGES = ['ca-certificates', 'curl', 'git', 'jq', 'procps', 'sudo', 'xz-utils'];

// A word for a shell command line, single-quoted.
const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// A path for COPY, JSON form so a space survives.
const copy = (from, sources, to) => `COPY ${from ? `--from=${from} ` : ''}${JSON.stringify([...sources, to])}`;

// renderDockerfile({ project, arch, declaration, repositories, contexts, hash }) — the Dockerfile's text.
export function renderDockerfile({ project, arch, declaration, repositories = [], contexts = {}, hash = '' }) {
  const d = declaration;
  const base = d.base ?? DEFAULT_BASE;
  // ASS-542: a declared CA is put in the agent's NSS database too (Chromium reads it): certutil.
  const packages = [...new Set([...BASE_PACKAGES, ...(d.ca ? ['libnss3-tools'] : []), ...d.packages, ...d.services.flatMap(s => s.packages)])].sort();
  const lines = [
    `# sandbox-${project} for linux/${arch} (ASS-534), written by src/substrate/dockerfile.js for substrate:build-image.`,
    `FROM --platform=$BUILDPLATFORM ${GOLANG.image}@${GOLANG.digest} AS command-server`,
    'ARG TARGETARCH',
    'WORKDIR /src',
    copy(null, ['harness/command-server/'], './'),
    'RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -ldflags=-s -o /out/harness-command-server .',
    '',
  ];
  for (const s of d.services) {
    if (!s.image) continue;   // ASS-542: run from what the image has already
    if (contexts[s.name]) lines.push(`# svc-${s.name}: ${s.image}@${s.digest}, an OCI layout handed to the build (--build-context)`);
    else lines.push(`FROM ${s.image}@${s.digest} AS svc-${s.name}`);
  }
  lines.push(
    '',
    `FROM ${base.image}@${base.digest}`,
    `RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.join(' ')} \\`,
    "    && useradd -m -s /bin/bash agent && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent && chmod 0440 /etc/sudoers.d/agent",
    copy(null, ['harness/git.sh', 'harness/provision.sh', 'harness/repositories.sh'], '/tmp/harness-image/'),
    'USER agent',
    'RUN bash /tmp/harness-image/provision.sh',
    'RUN bash /tmp/harness-image/git.sh',
  );
  if (repositories.length) {
    for (const url of repositories) if (/['\n]/.test(url)) throw new Error(`a repository URL cannot hold a quote or a newline: ${JSON.stringify(url)}`);
    lines.push(`RUN --mount=type=secret,id=forge,required=true,uid=1000 bash /tmp/harness-image/repositories.sh ${repositories.map(quote).join(' ')} < /run/secrets/forge`);
  }
  lines.push('USER root');
  const copied = new Set();   // the very same copy declared by several services is made once
  for (const s of d.services) {
    if (!s.image) continue;
    lines.push(`# ${s.name} ${s.version} (${s.kind}) from ${s.image}`);
    for (const p of s.paths) {
      const key = `${s.image}@${s.digest}:${p.from}>${p.to}`;
      if (copied.has(key)) continue;
      copied.add(key);
      lines.push(copy(`svc-${s.name}`, [p.from], p.to));
    }
  }
  // ASS-542: the prepare steps, as agent, once every service's files (the toolchains they use) are in — and before
  // the sandbox folder's files and the harness's own (declaration, scripts, command server), which change most often,
  // so a change to those rebuilds and delivers a small last layer, never the prepare steps' (a node_modules).
  if (d.prepare?.length) {
    lines.push('USER agent');
    for (const p of d.prepare ?? []) {
      const env = Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${quote(v)} `).join('');
      lines.push(`# prepare ${p.name} (ASS-542)`);
      lines.push(p.npm
        ? `RUN --mount=type=secret,id=npm,required=true,uid=1000 cd ${quote(p.workdir)} && ${env}NPM_CONFIG_USERCONFIG=/run/secrets/npm bash -c ${quote(p.run)}`
        : `RUN cd ${quote(p.workdir)} && ${env}bash -c ${quote(p.run)}`);
    }
    lines.push('USER root');
  }
  for (const f of d.files) lines.push(copy(null, [`files/${f.from}`], f.to));
  lines.push(
    copy(null, ['harness/services.json'], '/etc/sandbox/services.json'),
    copy(null, ['harness/sandbox-services', 'harness/sandbox-rootfs-exec', 'harness/sandbox-login', 'harness/sandbox-docker'], '/usr/local/bin/'),
    copy('command-server', ['/out/harness-command-server'], '/usr/local/bin/harness-command-server'),
    'RUN chmod 0755 /usr/local/bin/sandbox-services /usr/local/bin/sandbox-rootfs-exec /usr/local/bin/sandbox-login /usr/local/bin/sandbox-docker /usr/local/bin/harness-command-server && rm -rf /tmp/harness-image /var/lib/apt/lists/* \\',
    '    && install -d -o agent -g agent /var/lib/sandbox /var/log/sandbox /run/sandbox',
    `LABEL org.opencontainers.image.title=${JSON.stringify(`sandbox-${project}`)} harness.sandbox.project=${JSON.stringify(project)} harness.sandbox.arch=${JSON.stringify(arch)} harness.sandbox.inputs=${JSON.stringify(hash)}`,
    'ENV PORT=80',
    'CMD ["/usr/local/bin/harness-command-server"]',
  );
  lines.push('');
  return lines.join('\n');
}
