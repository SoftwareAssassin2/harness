// ASS-534: a project's Substrate sandbox image — its declaration
// (data/projects/<p>/sandbox/services.yaml) and its validation, the build
// (substrate:build-image: the golden definition plus each service's files
// copied out of its pinned image, the command server, pushed to the project's
// zot pinned by digest), its rebuild with the golden environment
// (vm:golden-stale, vm:golden-status, vm:build-golden-start's trigger) and its
// status per architecture. zot is a fake OCI registry (fake-oci-registry.js)
// holding a fake service image, as its on-demand sync of the upstream would;
// docker is a fake builder on PATH that logs each call, keeps the Dockerfile,
// the context's files and each OCI-layout build context it was handed, and
// writes a prepared image as the build's OCI output. No network, no real
// registry or build. Every name here is generic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync, rmSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fakeOciRegistry } from '../support/fake-oci-registry.js';
import { parseServices, validateServices, normalizeServices, DEFAULT_BASE } from '../../src/substrate/services.js';
import { renderDockerfile } from '../../src/substrate/dockerfile.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const AR = 'us-central1-docker.pkg.dev';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json', OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const sha = content => `sha256:${createHash('sha256').update(content).digest('hex')}`;
const D = c => `sha256:${c.repeat(64)}`;

// A valid declaration: amd64, one database service from the upstream, one job, one toolchain from elsewhere.
const SERVICES = `
architectures: [amd64]
packages: [libexample1]
files:
  - { from: files/db.conf, to: /etc/sandbox/db/db.conf }
services:
  - name: db
    version: "18.6"
    image: ${AR}/example-gcp-project/containers/example-db:18.6.17
    digest: DB_DIGEST
    architectures: [amd64]
    paths:
      - { from: /, to: /opt/sandbox/rootfs/db }
      - /usr/lib/example-db/18
    env: { DBDATA: /var/lib/sandbox/db }
    start: "example-db -D $DBDATA"
    ready: "example-db-ready"
    ports: [5432]
  - name: migrate
    kind: job
    version: "12.5.0"
    image: ${AR}/example-gcp-project/containers/example-db:18.6.17
    digest: DB_DIGEST
    paths: [/opt/migrate]
    start: [migrate, up]
    after: [db]
  - name: tools
    kind: toolchain
    version: "1.0"
    image: docker.io/example/tools:1.0
    digest: ${D('7')}
    paths: [/opt/tools]
`;

// The image the fake docker's build writes: an OCI layout of one linux/<arch> image, as a tar.
function builtImage(dir, arch) {
  const layout = join(dir, `built-${arch}`), blobs = join(layout, 'blobs', 'sha256');
  mkdirSync(blobs, { recursive: true });
  const blob = content => { const digest = sha(content); writeFileSync(join(blobs, digest.slice(7)), content); return { digest, size: Buffer.byteLength(content) }; };
  const config = blob(JSON.stringify({ architecture: arch, os: 'linux', rootfs: { type: 'layers', diff_ids: [] }, sandbox: true }));
  const layer = blob(`sandbox layer ${arch}`);
  const manifest = blob(JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config }, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...layer }] }));
  writeFileSync(join(layout, 'index.json'), JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [{ mediaType: OCI_MANIFEST, ...manifest, platform: { architecture: arch, os: 'linux' } }] }));
  writeFileSync(join(layout, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
  return { layout, manifest };
}

// The fake builder: `buildx build … --build-context svc-<n>=oci-layout://<dir>@<digest> … -f <file> --output type=oci,dest=<tar> <ctx>`
// keeps the Dockerfile (Dockerfile.<n>), the context's file list (context.<n>) and, per OCI-layout context, whether the layout
// holds that manifest and every blob it names (layouts.<n>); fails, as a broken build does, while a `fail-build` file is there;
// then writes built-<arch>'s layout as the tar.
const DOCKER = dir => `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${dir}/docker.log'
[[ "$1 $2" == "buildx build" ]] || exit 0
n=$(grep -c '^buildx build' '${dir}/docker.log'); arch="" dest=""
while (( $# )); do
  case "$1" in
    -f) cp "$2" '${dir}/Dockerfile.'$n; shift ;;
    --platform) arch="\${2#linux/}"; shift ;;
    --output) dest="\${2#type=oci,dest=}"; shift ;;
    --build-context)
      spec="\${2#*=oci-layout://}" name="\${2%%=*}"; lay="\${spec%@*}" dig="\${spec#*@}"
      m="$lay/blobs/sha256/\${dig#sha256:}"
      if [[ -f "$m" ]] && jq -r '.config.digest, .layers[].digest' "$m" | while read -r b; do [[ -f "$lay/blobs/sha256/\${b#sha256:}" ]] || exit 1; done; then echo "$name $dig whole" >> '${dir}/layouts.'$n; else echo "$name $dig missing" >> '${dir}/layouts.'$n; fi
      shift ;;
  esac
  ctx="$1"; shift
done
(cd "$ctx" && find . -type f | sort) > '${dir}/context.'$n
echo "#1 building for linux/$arch"
if [[ -f '${dir}/fail-build' ]]; then echo '#9 ERROR: process "/bin/sh -c bash /tmp/harness-image/provision.sh" did not complete successfully: exit code: 1'; exit 1; fi
tar -c -f "$dest" -C '${dir}/built-'$arch .
`;

async function setup({ services = SERVICES, reg = null } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'substrate-image-')));
  const project = join(dir, 'projects', 'p'), bin = join(dir, 'bin'), shared = join(dir, 'shared');
  for (const d of [bin, join(project, 'golden-image'), join(project, 'sandbox', 'files'), shared]) mkdirSync(d, { recursive: true });
  reg ??= await fakeOciRegistry();
  const db = reg.upstream('example-gcp-project/containers/example-db', '18.6.17');
  writeFileSync(join(project, 'project.json'), JSON.stringify({
    name: 'P', repositories: [{ url: `file://${dir}/example-repo` }], 'golden-image': { folder: 'projects/p/golden-image' },
    registry: { 'storage-path': 'projects/p/registry', 'max-size-gb': 20, port: reg.port, upstream: { host: AR, credentials: 'gcloud' } },
  }, null, 4));
  writeFileSync(join(project, 'golden-image', 'template.yaml'), 'vmType: vz\n');
  writeFileSync(join(project, 'golden-image', 'provision.sh'), '#!/bin/bash\necho provision\n');
  writeFileSync(join(project, 'golden-image', 'images.txt'), '');
  for (const f of ['git.sh', 'repositories.sh', 'desktop.sh']) writeFileSync(join(shared, f), `#!/bin/bash\necho ${f}\n`);
  if (services !== null) writeFileSync(join(project, 'sandbox', 'services.yaml'), services.replaceAll('DB_DIGEST', db.digest));
  writeFileSync(join(project, 'sandbox', 'files', 'db.conf'), 'port = 5432\n');
  writeFileSync(join(bin, 'docker'), DOCKER(dir));
  chmodSync(join(bin, 'docker'), 0o755);
  const images = { amd64: builtImage(dir, 'amd64'), arm64: builtImage(dir, 'arm64') };
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJECTS_DIR: join(dir, 'projects'), LIMA_HOME: join(dir, 'lima'), GOLDEN_IMAGE_SHARED: shared };
  const agent = (...args) => run(AGENT, args, { env });
  const result = (...args) => agent(...args).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));
  const json = async (...args) => { const r = await result(...args); assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`); return JSON.parse(r.out); };
  return {
    dir, project, reg, db, images, env, agent, result, json,
    file: name => readFileSync(join(dir, name), 'utf8'),
    has: name => existsSync(join(dir, name)),
    builds: () => (existsSync(join(dir, 'docker.log')) ? readFileSync(join(dir, 'docker.log'), 'utf8').trim().split('\n').filter(l => l.startsWith('buildx build')) : []),
    services: text => writeFileSync(join(project, 'sandbox', 'services.yaml'), text.replaceAll('DB_DIGEST', db.digest)),
    label: arch => JSON.parse(readFileSync(join(project, `sandbox-image-${arch}.json`), 'utf8')),
    // golden-p's label, as vm:build-golden writes it: current with the inputs vm:golden-stale reads now.
    goldenCurrent: async () => {
      const stale = JSON.parse((await agent('vm:golden-stale', 'p')).stdout);
      mkdirSync(join(dir, 'lima', 'golden-p'), { recursive: true });
      const inputs = (await run('bash', ['-c', `source '${join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'vm', 'golden.bash')}'; golden_definition t p; printf '%s' "$inputs"`], { env })).stdout;
      writeFileSync(join(dir, 'lima', 'golden-p', 'golden-image.json'), JSON.stringify({ project: 'p', hash: stale.hash, 'built-at': '2026-11-20T12:00:00Z', inputs: inputs.replace(/\n$/, '').split('\n') }));
    },
  };
}

test('AC1, AC5: services.yaml is validated, each bad entry named — kinds, images by tag and digest, paths, ports, after, files, architectures', () => {
  const ok = parseServices(SERVICES.replaceAll('DB_DIGEST', D('a')));
  assert.deepEqual(validateServices(ok, { folder: '/s', exists: f => f === '/s/files/db.conf' }), []);
  const bad = (change, pattern, options = {}) => {
    const d = structuredClone(ok);
    change(d);
    const problems = validateServices(d, { folder: '/s', exists: () => true, ...options });
    assert.ok(problems.some(p => pattern.test(p)), `${pattern}: ${JSON.stringify(problems)}`);
  };
  bad(d => { d.architectures = ['x86']; }, /^architectures must list the image's builds/);
  bad(d => { delete d.architectures; }, /^architectures must list/);
  bad(d => { d.extra = 1; }, /^has an unknown key "extra"/);
  bad(d => { d.services[0].digest = 'sha256:abc'; }, /^services\[0\] \(db\): digest must be sha256:<64 hex>/);
  bad(d => { delete d.services[0].digest; }, /^services\[0\] \(db\): digest must be/);
  bad(d => { d.services[0].image = `${AR}/x/y`; }, /^services\[0\] \(db\): image must be the pinned image's name and tag/);
  bad(d => { d.services[0].image = `${AR}/x/y:1@${D('a')}`; }, /^services\[0\] \(db\): image must be/);
  bad(d => { delete d.services[0].version; }, /^services\[0\] \(db\): version must say/);
  bad(d => { d.services[0].paths = []; }, /^services\[0\] \(db\): paths must list/);
  bad(d => { d.services[0].paths = ['relative/path']; }, /^services\[0\] \(db\): paths\[0\]: from must be an absolute path/);
  bad(d => { d.services[0].paths = ['/usr/../etc']; }, /paths\[0\]: from must be an absolute path/);
  bad(d => { d.services[0].paths = ['/']; }, /paths\[0\]: a whole filesystem goes to a folder of its own/);
  bad(d => { d.services[1].paths = [{ from: '/opt/other', to: '/usr/lib/example-db/18' }]; }, /^services\[1\] \(migrate\) paths\[0\]: \/usr\/lib\/example-db\/18 is copied to by services\[0\] \(db\) paths\[1\] too/);
  // The very same copy (image, digest, path) declared twice is shared, not a clash.
  { const d = structuredClone(ok); d.services[1].paths = ['/usr/lib/example-db/18']; assert.deepEqual(validateServices(d, { exists: () => true }), []); }
  bad(d => { d.services[0].kind = 'daemon'; }, /^services\[0\] \(db\): kind must be one of service, job, toolchain/);
  bad(d => { delete d.services[0].start; }, /^services\[0\] \(db\): start must say how it starts/);
  bad(d => { d.services[2].start = 'go'; }, /^services\[2\] \(tools\): a toolchain starts nothing: no start/);
  bad(d => { d.services[1].ready = 'x'; }, /^services\[1\] \(migrate\): ready must be a shell command, and only a service has one/);
  bad(d => { d.services[1].ports = [5432]; }, /^services\[1\] \(migrate\): port 5432 is services\[0\] \(db\)'s too/);
  bad(d => { d.services[1].after = ['nope']; }, /^services\[1\] \(migrate\): after names no service: nope/);
  bad(d => { d.services[1].after = ['tools']; }, /after names tools, a toolchain/);
  bad(d => { d.services[0].after = ['migrate']; }, /^services: after makes a cycle: (db → migrate → db|migrate → db → migrate)/);
  bad(d => { d.services[1].name = 'db'; }, /^services\[1\] \(db\): name db is services\[0\]'s too/);
  bad(d => { d.services[0].name = 'Bad_Name'; }, /^services\[0\] \(Bad_Name\): name must be lower-case/);
  bad(d => { d.services[0].unknown = true; }, /^services\[0\] \(db\): has an unknown key "unknown"/);
  bad(d => { d.architectures = ['amd64', 'arm64']; }, /^services\[0\] \(db\): its image offers amd64 only, but the image is built for arm64/);
  bad(d => { d.files[0].from = '../outside'; }, /^files\[0\]: from must be a relative path inside the sandbox folder/);
  bad(d => { d.files[0].to = 'etc/x'; }, /^files\[0\]: to must be an absolute file path/);
  bad(d => { d.files[0].to = '/opt/tools'; }, /^services\[2\] \(tools\) paths\[0\]: \/opt\/tools is copied to by files\[0\] too/);
  bad(d => {}, /^files\[0\]: from names no file of the sandbox folder: files\/db\.conf/, { exists: () => false });
  bad(d => { d.provision = 'missing.sh'; }, /^provision names no file of the sandbox folder: missing\.sh/, { exists: () => false });
  bad(d => { d.base = { image: 'debian:trixie' }; }, /^base must be \{ image: <name>:<tag>, digest: sha256:<64 hex> \}/);
  bad(d => { d.services = {}; }, /^services must be a list/);
  bad(d => { d.packages = ['Bad Package']; }, /^packages must be a list of Debian package names/);
  assert.throws(() => parseServices('services: [', 'x.yaml'), /^Error: x\.yaml:\d+:\d+: /);
  assert.throws(() => parseServices('- a\n', 'x.yaml'), /x\.yaml: a sandbox declaration is a mapping/);
  // Normalized: defaults filled in, paths { from, to }, a shell start as bash -c, services in start order.
  const n = normalizeServices({ ...ok, services: [ok.services[1], ok.services[0], ok.services[2]] });
  assert.deepEqual(n.services.map(s => s.name), ['db', 'migrate', 'tools']);
  assert.deepEqual(n.services[0].paths, [{ from: '/', to: '/opt/sandbox/rootfs/db' }, { from: '/usr/lib/example-db/18', to: '/usr/lib/example-db/18' }]);
  assert.deepEqual([n.services[0].start, n.services[1].start, n.services[2].start], [['bash', '-c', 'example-db -D $DBDATA'], ['migrate', 'up'], null]);
  assert.deepEqual([n.services[0].user, n.services[0].kind, n.services[2].kind, n.base, n.provision], ['agent', 'service', 'toolchain', DEFAULT_BASE, null]);
});

test('AC1: a project\'s commands name a bad entry of its services.yaml; a project with none declares no sandbox', async () => {
  const s = await setup({ services: 'architectures: [amd64]\nservices:\n  - name: db\n    version: "1"\n    image: example/db:1\n    digest: sha256:nope\n    paths: [/x]\n    start: db\n' });
  for (const command of ['substrate:image-status', 'substrate:build-image', 'vm:golden-stale', 'vm:golden-status']) {
    const r = await s.result(command, 'p');
    assert.equal(r.code, 1, command);
    assert.match(r.err, /p's sandbox declaration is wrong: .*services\.yaml:\n {2}- services\[0\] \(db\): digest must be sha256:<64 hex>: "sha256:nope"/, `${command}: ${r.err}`);
  }
  const none = await setup({ services: null });
  assert.deepEqual(await none.json('substrate:image-status', 'p'), {});
  assert.equal((await none.json('vm:golden-status', 'p'))['sandbox-images'], undefined);
});

test('AC2, AC5, AC6: the copy-out build — each service\'s files COPY --from its pinned image, the upstream one fetched through zot for the architecture into an OCI layout, the command server built from source; pushed to zot pinned by digest; current next time', async () => {
  const s = await setup();
  const [out] = await s.json('substrate:build-image', 'p');
  const label = s.label('amd64');
  const tag = `amd64-${label.hash.slice(0, 12)}`;
  assert.deepEqual(out, { project: 'p', image: 'sandbox-p', arch: 'amd64', built: true, digest: s.images.amd64.manifest.digest, ref: `127.0.0.1:${s.reg.port}/0local/sandbox/p@${s.images.amd64.manifest.digest}`, hash: label.hash, seconds: out.seconds });
  // In zot under 0local (never synced upstream), the tag naming the very manifest built; nothing else pushed anywhere.
  assert.equal(sha(s.reg.get('0local/sandbox/p', tag).body), s.images.amd64.manifest.digest);
  assert.ok(s.reg.requests.every(r => !/^(PUT|POST|PATCH) /.test(r) || r.includes('/v2/0local/sandbox/p/')), s.reg.requests.join('\n'));
  assert.deepEqual([label.repository, label.tag, label.arch, label.image], ['0local/sandbox/p', tag, 'amd64', 'sandbox-p']);
  // One build, for linux/amd64, OCI output, no attestations, the forge tokens a secret, the db image's layout handed over whole.
  const [build] = s.builds();
  assert.match(build, /--platform linux\/amd64 --provenance=false --sbom=false .*--secret id=forge,env=HARNESS_FORGE_TOKENS/);
  assert.match(build, /--output type=oci,dest=/);
  assert.equal(s.file('layouts.1').trim(), `svc-db ${s.db.digest} whole\nsvc-migrate ${s.db.digest} whole`);
  assert.ok(s.reg.requests.includes(`GET /v2/example-gcp-project/containers/example-db/manifests/${s.db.digest}`), s.reg.requests.join('\n'));
  const dockerfile = s.file('Dockerfile.1');
  for (const line of [
    'FROM --platform=$BUILDPLATFORM golang:1.26-trixie@sha256:',
    'RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -ldflags=-s -o /out/harness-command-server .',
    'FROM docker.io/example/tools:1.0@sha256:7777777777777777777777777777777777777777777777777777777777777777 AS svc-tools',
    `FROM ${DEFAULT_BASE.image}@${DEFAULT_BASE.digest}`,
    'RUN bash /tmp/harness-image/provision.sh',
    'RUN bash /tmp/harness-image/git.sh',
    `RUN --mount=type=secret,id=forge,required=true,uid=1000 bash /tmp/harness-image/repositories.sh 'file://${s.dir}/example-repo' < /run/secrets/forge`,
    'COPY --from=svc-db ["/","/opt/sandbox/rootfs/db"]',
    'COPY --from=svc-db ["/usr/lib/example-db/18","/usr/lib/example-db/18"]',
    'COPY --from=svc-migrate ["/opt/migrate","/opt/migrate"]',
    'COPY --from=svc-tools ["/opt/tools","/opt/tools"]',
    'COPY ["files/files/db.conf","/etc/sandbox/db/db.conf"]',
    'COPY ["harness/services.json","/etc/sandbox/services.json"]',
    'COPY --from=command-server ["/out/harness-command-server","/usr/local/bin/harness-command-server"]',
    'CMD ["/usr/local/bin/harness-command-server"]',
  ]) assert.ok(dockerfile.includes(line), `${line}\n---\n${dockerfile}`);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends ca-certificates curl git jq libexample1 procps sudo xz-utils/);
  assert.doesNotMatch(dockerfile, /AS svc-db|desktop\.sh|memory\.sh|registry\.sh|images/);   // the db's is a build context; VM-only steps skipped
  assert.ok(dockerfile.indexOf('provision.sh\n') < dockerfile.indexOf('git.sh\n'), 'provision.sh before git.sh, as in the golden VM');
  assert.deepEqual(s.file('context.1').trim().split('\n'), [
    './Dockerfile', './files/files/db.conf', './harness/command-server/go.mod', './harness/command-server/main.go',
    './harness/git.sh', './harness/provision.sh', './harness/repositories.sh', './harness/sandbox-docker', './harness/sandbox-login', './harness/sandbox-rootfs-exec', './harness/sandbox-services', './harness/services.json',
  ]);
  // Current: nothing built again.
  const [again] = await s.json('substrate:build-image', 'p', '--arch', 'amd64');
  assert.equal(again.built, false);
  assert.equal(s.builds().length, 1);
  // The work folder is gone; the log says what ran.
  assert.deepEqual((await run('find', [join(s.project, 'registry', 'substrate'), '-mindepth', '1'])).stdout, '');
  assert.match(readFileSync(join(s.project, 'sandbox-image-build-amd64.log'), 'utf8'), /built sandbox-p \(amd64\) in 0m \d+s: 0local\/sandbox\/p@sha256:/);
});

test('AC2: an architecture the declaration does not build, a service image without it, and a failing build are each refused, saying why; the run records the failure', async () => {
  const s = await setup();
  let r = await s.result('substrate:build-image', 'p', '--arch', 'arm64');
  assert.equal(r.code, 1);
  assert.match(r.err, /p's sandbox\/services\.yaml builds for amd64 only \(architectures\), not arm64/);
  // Declared for arm64 but its image (as Artifact Registry serves it) is amd64 only: named, nothing built.
  s.services(SERVICES.replace('architectures: [amd64]\npackages', 'architectures: [arm64]\npackages').replace('    architectures: [amd64]\n', ''));
  r = await s.result('substrate:build-image', 'p');
  assert.equal(r.code, 1);
  assert.match(r.err, /sandbox-p \(arm64\): services \(db\): its image .*example-db:18\.6\.17@sha256:\w+ could not be fetched for linux\/arm64: .* is a linux\/amd64 image, not linux\/arm64/);
  assert.equal(s.builds().length, 0);
  s.services(SERVICES);
  writeFileSync(join(s.dir, 'fail-build'), '');
  r = await s.result('substrate:build-image', 'p');
  assert.equal(r.code, 1);
  assert.match(r.err, /sandbox-p \(amd64\): the build failed: #9 ERROR: process "\/bin\/sh -c bash \/tmp\/harness-image\/provision\.sh" did not complete successfully: exit code: 1 — see .*sandbox-image-build-amd64\.log/);
  const status = (await s.json('substrate:image-status', 'p')).amd64;
  assert.deepEqual([status.status, status['exit-code'], status.digest], ['failed', 1, null]);
  // The disk hold on: refused, as a golden build is.
  rmSync(join(s.dir, 'fail-build'));
  writeFileSync(join(s.dir, 'disk-space.json'), JSON.stringify({ level: 'hold', 'free-bytes': 10 * 2 ** 30 }));
  r = await run(AGENT, ['substrate:build-image', 'p'], { env: { ...s.env, DISK_SPACE_FILE: join(s.dir, 'disk-space.json') } }).catch(e => e);
  assert.match(r.stderr, /Disk nearly full — work held \(10\.0 GiB free\): no image build starts/);
  // The zot not answering: refused before anything runs.
  await s.reg.close();
  r = await s.result('substrate:build-image', 'p');
  assert.match(r.err, /p's registry is not answering on 127\.0\.0\.1:\d+, and the image goes there — start it \(registry:up p\)/);
});

test('AC4, AC5: the status per architecture — stale, building, failed, current — in substrate:image-status and vm:golden-status, whose status is the whole golden environment\'s', async () => {
  const s = await setup({ services: SERVICES.replace('architectures: [amd64]\npackages', 'architectures: [amd64, arm64]\npackages').replace('    architectures: [amd64]\n', '').replace(/digest: DB_DIGEST/g, 'digest: DB_DIGEST') });
  // db's image as a multi-arch index here, so arm64 builds too.
  const arm = s.reg.blob('example-gcp-project/containers/example-db', JSON.stringify({ architecture: 'arm64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } }));
  const armLayer = s.reg.blob('example-gcp-project/containers/example-db', 'arm64 layer');
  const armManifest = s.reg.manifest('example-gcp-project/containers/example-db', 'arm', JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...arm }, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...armLayer }] }), OCI_MANIFEST);
  const index = s.reg.manifest('example-gcp-project/containers/example-db', 'multi', JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [
    { mediaType: 'application/vnd.docker.distribution.manifest.v2+json', digest: s.db.digest, size: s.db.body.length, platform: { os: 'linux', architecture: 'amd64' } },
    { mediaType: OCI_MANIFEST, digest: armManifest, size: 1, platform: { os: 'linux', architecture: 'arm64' } }] }), OCI_INDEX);
  s.services(SERVICES.replace('architectures: [amd64]\npackages', 'architectures: [amd64, arm64]\npackages').replace('    architectures: [amd64]\n', '').replaceAll('DB_DIGEST', index));
  await s.goldenCurrent();
  let st = await s.json('substrate:image-status', 'p');
  assert.deepEqual(Object.keys(st), ['amd64', 'arm64']);
  assert.deepEqual([st.amd64.status, st.amd64.why, st.amd64.digest], ['stale', ['sandbox-p has not been built'], null]);
  let golden = await s.json('vm:golden-status', 'p');
  assert.deepEqual([golden.status, golden['vm-status'], golden['sandbox-images'].arm64.status], ['failed', 'current', 'stale']);
  await s.json('substrate:build-image', 'p', '--arch', 'amd64');
  golden = await s.json('vm:golden-status', 'p');
  assert.deepEqual([golden.status, golden['sandbox-images'].amd64.status, golden['sandbox-images'].arm64.status], ['failed', 'current', 'stale']);
  assert.equal(golden['sandbox-images'].amd64.digest, s.images.amd64.manifest.digest);
  // A build holding the lock: building, the environment too.
  const lock = join(s.project, 'sandbox-image-build.lock');
  closeSync(openSync(lock, 'a'));
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 30', lock], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(resolve => holder.stdout.once('data', resolve));
  try {
    golden = await s.json('vm:golden-status', 'p');
    assert.deepEqual([golden.status, golden['sandbox-images'].amd64.status], ['building', 'building']);
    const r = await s.result('substrate:build-image', 'p', '--arch', 'arm64');
    assert.match(r.err, /p's sandbox image is being built already/);
  } finally { holder.kill(); }
  await new Promise(resolve => holder.once('exit', resolve));
  await s.json('substrate:build-image', 'p');
  assert.deepEqual(s.file('layouts.2').trim(), `svc-db ${armManifest} whole\nsvc-migrate ${armManifest} whole`);
  golden = await s.json('vm:golden-status', 'p');
  assert.deepEqual([golden.status, golden['sandbox-images'].arm64.status, golden['sandbox-images'].arm64.digest], ['current', 'current', s.images.arm64.manifest.digest]);
  st = await s.json('substrate:image-status', 'p', '--arch', 'arm64');
  assert.deepEqual(Object.keys(st), ['arm64']);
});

test('AC4: the image goes stale when the golden definition or services.yaml changes — vm:golden-stale (which vm:raise-golden-rebuilds reads) says so, as for the golden VM', async () => {
  const s = await setup();
  await s.goldenCurrent();
  await s.json('substrate:build-image', 'p');
  let stale = await s.json('vm:golden-stale', 'p');
  assert.deepEqual([stale.stale, stale.why, stale.sandbox.map(x => [x.arch, x.stale])], [false, [], [['amd64', false]]]);
  s.services(SERVICES.replace('version: "18.6"', 'version: "18.7"'));
  stale = await s.json('vm:golden-stale', 'p');
  assert.deepEqual([stale.stale, stale.why], [true, ['sandbox-p (amd64): changed sandbox/services.yaml']]);
  assert.equal((await s.json('vm:golden-status', 'p')).status, 'failed');   // what vm:build-golden-start starts a run on
  await s.json('substrate:build-image', 'p');
  writeFileSync(join(s.project, 'golden-image', 'provision.sh'), '#!/bin/bash\necho provision v2\n');
  stale = await s.json('vm:golden-stale', 'p');
  assert.deepEqual([stale.stale, stale.why], [true, ['changed definition/provision.sh', 'sandbox-p (amd64): changed definition/provision.sh']]);
  // A file the sandbox folder adds (a config override) is an input too; images.txt, which a sandbox never uses, is not.
  await s.goldenCurrent();
  await s.json('substrate:build-image', 'p');
  writeFileSync(join(s.project, 'golden-image', 'images.txt'), 'example/x:1\n');
  writeFileSync(join(s.project, 'sandbox', 'files', 'extra.conf'), 'x\n');
  stale = await s.json('vm:golden-stale', 'p');
  assert.ok(stale.why.includes('sandbox-p (amd64): added sandbox/files/extra.conf'), stale.why.join('\n'));
  assert.ok(!stale.why.some(w => w.startsWith('sandbox-p') && w.includes('images.txt')), stale.why.join('\n'));
});

test('AC4: vm:build-golden rebuilds the sandbox images too — with the VM image current, only the stale sandbox image is built', async () => {
  const s = await setup();
  await s.goldenCurrent();
  const { stdout } = await s.agent('vm:build-golden', 'p');
  assert.match(stdout, /golden-p is current \(inputs \w+\); nothing built/);
  assert.match(stdout, /sandbox-p \(amd64\): built in \d+s, 127\.0\.0\.1:\d+\/0local\/sandbox\/p@sha256:/);
  assert.equal(s.builds().length, 1);
  const again = await s.agent('vm:build-golden', 'p');
  assert.match(again.stdout, /sandbox-p \(amd64\): current; nothing built/);
  assert.equal(s.builds().length, 1);
  assert.equal((await s.json('vm:golden-status', 'p')).status, 'current');
});

test('dockerfile.js: no repositories, no secret step; a quote in a repository URL is refused', () => {
  const declaration = normalizeServices({ architectures: ['arm64'], services: [] });
  const text = renderDockerfile({ project: 'q', arch: 'arm64', declaration, repositories: [], hash: 'h' });
  assert.doesNotMatch(text, /--mount=type=secret/);
  assert.match(text, /LABEL org\.opencontainers\.image\.title="sandbox-q" harness\.sandbox\.project="q" harness\.sandbox\.arch="arm64" harness\.sandbox\.inputs="h"/);
  assert.throws(() => renderDockerfile({ project: 'q', arch: 'arm64', declaration, repositories: ["https://x/'y"] }), /cannot hold a quote/);
  // The very same copy declared by two services (three instances of one API binary, say) is made once.
  const api = n => ({ name: n, version: '1', image: 'example/api:1', digest: D('a'), paths: [{ from: '/bin/api', to: '/usr/local/bin/api' }], start: 'api' });
  const shared = renderDockerfile({ project: 'q', arch: 'arm64', declaration: normalizeServices({ architectures: ['arm64'], services: [api('one'), api('two')] }) });
  assert.equal(shared.match(/COPY --from=svc-\w+ \["\/bin\/api"/g).length, 1);
});

test('registry:sweep keeps the builds sandbox labels pin', async () => {
  const s = await setup();
  await s.json('substrate:build-image', 'p');
  // The registry over its cap: zot's storage holds the pushed image's repository as zot writes it.
  const repo = join(s.project, 'registry', 'images', '0local', 'sandbox', 'p');
  mkdirSync(join(repo, 'blobs', 'sha256'), { recursive: true });
  const digest = s.label('amd64').digest;
  writeFileSync(join(repo, 'blobs', 'sha256', digest.slice(7)), JSON.stringify({ config: { size: 10 }, layers: [{ size: 30e9 }] }));
  writeFileSync(join(repo, 'index.json'), JSON.stringify({ manifests: [{ digest }] }));
  const p = join(s.project, 'project.json');
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), registry: { ...JSON.parse(readFileSync(p, 'utf8')).registry, 'max-size-gb': 0.000001 } }));
  const out = await s.json('registry:sweep', 'p');
  assert.deepEqual(out.deleted, []);
  rmSync(join(s.project, 'sandbox-image-amd64.json'));
  assert.deepEqual((await s.json('registry:sweep', 'p')).deleted, [`0local/sandbox/p@${digest}`]);
});
