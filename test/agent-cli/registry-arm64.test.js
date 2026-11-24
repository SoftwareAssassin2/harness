// registry:arm64-build and registry:arm64-status (ASS-466): arm64 variants of
// images a project pins (its golden image's images.txt) but publishes for amd64
// only, served from its zot as a multi-arch index under the pinned name. zot
// is a fake registry (an HTTP server holding manifests and blobs per
// repository, the cache's upstream image already in it, as zot's on-demand
// sync would have it); docker is a fake builder on PATH that logs each call,
// keeps the Dockerfile and context it was given, and `docker save`s a
// prepared arm64 image; the build repository is a local git repository. No
// network, no real registry or build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeOciRegistry as fakeRegistry } from '../support/fake-oci-registry.js';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const AR = 'us-central1-docker.pkg.dev';
const DB = `${AR}/example-gcp-project/containers/example-db`, DB_PATH = 'example-gcp-project/containers/example-db';
const TOOLS = `${AR}/example-gcp-project/containers/example-tools`, TOOLS_PATH = 'example-gcp-project/containers/example-tools';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json', OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json', DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';

const sha = content => `sha256:${createHash('sha256').update(content).digest('hex')}`;

// The arm64 image `docker save` hands over: an OCI layout, an index over the arm64 manifest.
function arm64Layout(dir, name = 'arm64') {
  const layout = join(dir, `layout-${name}`), blobs = join(layout, 'blobs', 'sha256');
  mkdirSync(blobs, { recursive: true });
  const blob = content => { const digest = sha(content); writeFileSync(join(blobs, digest.slice(7)), content); return { digest, size: Buffer.byteLength(content) }; };
  const config = blob(JSON.stringify({ architecture: 'arm64', variant: 'v8', os: 'linux', rootfs: { type: 'layers', diff_ids: [] }, name }));
  const layer = blob(`arm64 layer ${name}`);
  const manifestBody = JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config }, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...layer }] });
  const manifest = blob(manifestBody);
  const index = blob(JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [{ mediaType: OCI_MANIFEST, ...manifest, platform: { architecture: 'arm64', os: 'linux' } }] }));
  writeFileSync(join(layout, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: OCI_INDEX, ...index }] }));
  writeFileSync(join(layout, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
  execFileSync('tar', ['-c', '-f', join(dir, `${name}.tar`), '-C', layout, '.']);
  return { config, layer, manifest, manifestBody };
}

// A project p with a registry on the fake's port, images.txt pinning example-db:18.6.19 and
// example-tools:2.1, a git repository holding the database image's Dockerfile, and `arm64` as its arm64-images.
function setup(reg, { arm64, images = `${DB}:18.6.19\n# a comment\n${TOOLS}:2.1\n` } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'registry-arm64-')));
  const bin = join(dir, 'bin'), project = join(dir, 'projects', 'p'), repo = join(dir, 'example-db-images');
  for (const d of [bin, join(project, 'golden-image'), join(repo, 'db')]) mkdirSync(d, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, 'db', 'Dockerfile'), 'ARG PG_TAG\nFROM postgres:18\nRUN make pgtap\n');
  git('add', '.'); git('commit', '-qm', 'db'); git('tag', 'v18.6.19');
  const json = {
    name: 'P', repositories: [{ url: `file://${repo}` }], 'golden-image': { folder: 'projects/p/golden-image' },
    registry: { 'storage-path': 'projects/p/registry', 'max-size-gb': 20, port: reg?.port ?? 1, upstream: { host: AR, credentials: 'gcloud' } },
    'arm64-images': arm64 ?? [
      { image: DB, build: { repository: 'example-db-images', ref: 'v{tag}', context: 'db', args: { PG_TAG: '{tag}' } } },
      { image: TOOLS, 'base-swap': { base: 'debian:13-slim', copy: ['/opt/tools', '/etc/tools.conf'] } },
    ],
  };
  writeFileSync(join(project, 'project.json'), JSON.stringify(json, null, 4));
  writeFileSync(join(project, 'golden-image', 'images.txt'), images);
  const layout = arm64Layout(dir);
  // The fake builder: `buildx build … -f <file> … <context>` keeps the Dockerfile and lists the context, failing
  // (as a build that breaks does, its error in its output) when the args hold fail-build's text; `save` prints the layout.
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${dir}/docker.log'
if [[ "$1 $2" == "buildx build" ]]; then
  n=$(grep -c '^buildx build' '${dir}/docker.log')
  while (( $# )); do if [[ "$1" == -f ]]; then cp "$2" '${dir}/Dockerfile.'$n; shift; fi; ctx="$1"; shift; done
  ls "$ctx" > '${dir}/context.'$n
  echo "#1 building for linux/arm64"
  if [[ -f '${dir}/fail-build' ]] && grep -qF "$(cat '${dir}/fail-build')" '${dir}/Dockerfile.'$n; then echo '#7 ERROR: process "/bin/sh -c make pgtap" did not complete successfully: exit code: 2'; exit 1; fi
elif [[ "$1" == save ]]; then cat '${dir}/arm64.tar'
fi`);
  chmodSync(join(bin, 'docker'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJECTS_DIR: join(dir, 'projects') };
  const storage = join(project, 'registry');
  return {
    dir, repo, git, storage, env, json, layout,
    agent: (...args) => run(AGENT, args, { env }),
    builds: () => (existsSync(join(dir, 'docker.log')) ? readFileSync(join(dir, 'docker.log'), 'utf8').trim().split('\n').filter(l => l.startsWith('buildx build')) : []),
    file: name => readFileSync(join(dir, name), 'utf8'),
    images: text => writeFileSync(join(project, 'golden-image', 'images.txt'), text),
    state: () => JSON.parse(readFileSync(join(storage, 'arm64.json'), 'utf8')),
  };
}

// What a VM's Docker does with hosts.toml (registry:hosts-toml): asks 0local first, then the cache; from an
// index takes the linux/arm64 image. Returns { from, platform, digest } for the image it would run.
function vmPull(reg, path, tag) {
  for (const repo of [`0local/${path}`, path]) {
    const top = reg.get(repo, tag);
    if (!top) continue;
    const body = JSON.parse(top.body);
    if (!body.manifests) return { from: repo, platform: JSON.parse(reg.blobs.get(`${repo}@${body.config.digest}`)).architecture, digest: sha(top.body) };
    const entry = body.manifests.find(e => e.platform.architecture === 'arm64') ?? body.manifests.find(e => e.platform.architecture === 'amd64');
    const image = JSON.parse(reg.get(repo, entry.digest).body);
    for (const b of [image.config, ...image.layers]) assert.ok(reg.blobs.has(`${repo}@${b.digest}`), `${repo} holds ${b.digest}`);
    return { from: repo, platform: entry.platform.architecture, digest: entry.digest };
  }
  return null;
}

test('AC1: arm64-images is validated: an image images.txt does not pin, a missing build source, and other mistakes are each named', async () => {
  const cases = [
    [[{ image: `${AR}/example-gcp-project/containers/unpinned`, 'base-swap': { base: 'debian:13', copy: ['/x'] } }], /arm64-images\[0\] \(.*unpinned\) is an unknown image: images\.txt pins no .*unpinned:<tag>/],
    [[{ image: DB }], /arm64-images\[0\] \(.*example-db\) needs a build source: exactly one of build \{ repository, ref, … \} and base-swap \{ base, copy \}/],
    [[{ image: DB, build: { ref: 'main' } }], /build is missing its build source: a repository/],
    [[{ image: DB, build: { repository: 'no-such-repository', ref: 'main' } }], /build names no repository of the project, nor a git URL: no-such-repository/],
    [[{ image: DB, build: { repository: 'example-db-images' } }], /build needs a ref/],
    [[{ image: DB, 'base-swap': { copy: ['/x'] } }], /base-swap is missing its build source: a base/],
    [[{ image: DB, 'base-swap': { base: 'debian:13', copy: ['relative'] } }], /base-swap needs copy: the absolute paths/],
    [[{ image: DB, build: { repository: 'example-db-images', ref: 'main' }, 'base-swap': { base: 'debian:13', copy: ['/x'] } }], /needs a build source: exactly one/],
    [[{ image: `${DB}:18.6.19`, 'base-swap': { base: 'debian:13', copy: ['/x'] } }], /image is the name alone, without a tag or digest/],
    [[{ image: 'docker.io/library/postgres', 'base-swap': { base: 'debian:13', copy: ['/x'] } }], /is not an image of the registry upstream us-central1-docker\.pkg\.dev/],
    [[{ image: DB, build: { repository: 'example-db-images', ref: 'main', context: '../up' } }], /build context must be a folder inside the repository/],
    [[{ image: DB, build: { repository: 'example-db-images', ref: 'main', args: { A: 1 } } }], /build args must be an object of strings/],
    [[{ image: DB, 'base-swap': { base: 'debian:13', copy: ['/x'] }, extra: true }], /has an unknown key "extra"/],
    [{ image: DB }, /arm64-images must be a list/],
  ];
  for (const [arm64, message] of cases) {
    const s = setup(null, { arm64 });
    for (const command of ['registry:arm64-status', 'registry:arm64-build'])
      await assert.rejects(s.agent(command, 'p'), e => message.test(e.stderr) && e.stderr.includes(`${command}: p: `), `${command} ${JSON.stringify(arm64)}`);
  }
  // Two problems, both named; an image pinned by digest only is not pinned by tag.
  const s = setup(null, { arm64: [{ image: DB }, { image: TOOLS, 'base-swap': { base: 'debian:13', copy: ['/x'] } }], images: `${DB}:18.6.19\n${TOOLS}@sha256:${'0'.repeat(64)}\n` });
  await assert.rejects(s.agent('registry:arm64-status', 'p'), e => /arm64-images\[0\].*needs a build source/.test(e.stderr) && /arm64-images\[1\].*unknown image/.test(e.stderr));
  // A valid declaration, by repository name or git URL, passes; no declaration at all is an empty report.
  const ok = setup(null, { arm64: [{ image: DB, build: { repository: 'https://example.com/g/example-db-images.git', ref: 'main' } }] });
  assert.deepEqual(JSON.parse((await ok.agent('registry:arm64-status', 'p')).stdout).map(i => [i.image, i.tag, i.arm64]), [[DB, '18.6.19', null]]);
  const none = setup(null, { arm64: [] });
  assert.deepEqual(JSON.parse((await none.agent('registry:arm64-build', 'p')).stdout), []);
});

test('AC2: each declared image is built for linux/arm64 and served under its pinned name as a multi-arch index pairing the upstream amd64 image with the arm64 build', async t => {
  const reg = await fakeRegistry();
  t.after(reg.close);
  const db = reg.upstream(DB_PATH, '18.6.19');
  reg.upstream(TOOLS_PATH, '2.1');
  const s = setup(reg);
  assert.deepEqual(vmPull(reg, DB_PATH, '18.6.19'), { from: DB_PATH, platform: 'amd64', digest: db.digest }, 'before: the VM gets amd64, emulated');

  const out = JSON.parse((await s.agent('registry:arm64-build', 'p')).stdout);
  const { layout } = s;   // what the fake builder saved
  assert.deepEqual(out.map(r => [r.image, r.tag, r.result, r.digest, r.error]), [
    [DB, '18.6.19', 'built', layout.manifest.digest, null],
    [TOOLS, '2.1', 'built', layout.manifest.digest, null],
  ]);

  // The builds: linux/arm64, the database image from its repository at the pinned tag's ref, with its args filled in.
  const [dbBuild, toolsBuild] = s.builds();
  assert.match(dbBuild, /^buildx build --platform linux\/arm64 --provenance=false --sbom=false --load -t harness-arm64\.local\/example-gcp-project\/containers\/example-db:18\.6\.19 -f \S+\/db\/Dockerfile --build-arg PG_TAG=18\.6\.19 \S+\/db$/);
  assert.equal(s.file('Dockerfile.1'), 'ARG PG_TAG\nFROM postgres:18\nRUN make pgtap\n');
  assert.equal(s.file('context.1'), 'Dockerfile\n');
  // The base swap: the base's arm64 image with the listed paths from the pinned amd64 image.
  assert.match(toolsBuild, /--platform linux\/arm64 .* -t harness-arm64\.local\/example-gcp-project\/containers\/example-tools:2\.1 /);
  assert.equal(s.file('Dockerfile.2'), [
    `FROM --platform=linux/amd64 ${TOOLS}:2.1 AS upstream`, 'FROM debian:13-slim', 'COPY --from=upstream /opt/tools /opt/tools', 'COPY --from=upstream /etc/tools.conf /etc/tools.conf', ''].join('\n'));

  // The index: the upstream amd64 manifest (its digest unchanged) and the arm64 build, under the pinned tag in 0local.
  const repo = `0local/${DB_PATH}`;
  const index = JSON.parse(reg.get(repo, '18.6.19').body);
  assert.equal(reg.get(repo, '18.6.19').type, OCI_INDEX);
  assert.deepEqual(index.manifests, [
    { mediaType: DOCKER_MANIFEST, digest: db.digest, size: Buffer.byteLength(db.body), platform: { architecture: 'amd64', os: 'linux' } },
    { mediaType: OCI_MANIFEST, digest: layout.manifest.digest, size: Buffer.byteLength(layout.manifestBody), platform: { architecture: 'arm64', os: 'linux', variant: 'v8' } },
  ]);
  assert.equal(reg.get(repo, db.digest).body.toString(), db.body, 'the amd64 manifest, byte for byte');
  assert.match(index.annotations['org.opencontainers.image.created'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // Children before the tag: nothing answers for 0local's tag until the index is whole; the amd64 blobs mounted from the cache.
  const puts = reg.requests.filter(r => r.startsWith(`PUT /v2/${repo}/manifests/`));
  assert.deepEqual(puts, [`PUT /v2/${repo}/manifests/${layout.manifest.digest}`, `PUT /v2/${repo}/manifests/${db.digest}`, `PUT /v2/${repo}/manifests/18.6.19`]);
  assert.ok(reg.requests.includes(`POST /v2/${repo}/blobs/uploads/?mount=${db.layer.digest}&from=${DB_PATH}`));

  // A VM pulling the unchanged pinned name gets the arm64 image from 0local; the cache still answers amd64.
  assert.deepEqual(vmPull(reg, DB_PATH, '18.6.19'), { from: repo, platform: 'arm64', digest: layout.manifest.digest });
  assert.deepEqual(vmPull(reg, TOOLS_PATH, '2.1'), { from: `0local/${TOOLS_PATH}`, platform: 'arm64', digest: layout.manifest.digest });
  assert.equal(JSON.parse(reg.get(DB_PATH, '18.6.19').body).mediaType, DOCKER_MANIFEST);

  // Recorded, for registry:arm64-status and the golden image's inputs.
  const state = s.state();
  assert.deepEqual(Object.keys(state), [DB, TOOLS]);
  assert.deepEqual({ ...state[DB], 'built-at': 'x' }, { tag: '18.6.19', digest: layout.manifest.digest, index: sha(reg.get(repo, '18.6.19').body), amd64: db.digest, 'built-at': 'x' });
  assert.equal(state[DB]['built-at'], index.annotations['org.opencontainers.image.created']);
  assert.match(readFileSync(out[0].log, 'utf8'), /docker buildx build for linux\/arm64[\s\S]*is sha256:/);
});

test('AC3: a variant already there is skipped; a new tag in images.txt builds again; one swept away is rebuilt', async t => {
  const reg = await fakeRegistry();
  t.after(reg.close);
  reg.upstream(DB_PATH, '18.6.19'); reg.upstream(TOOLS_PATH, '2.1');
  const s = setup(reg);
  await s.agent('registry:arm64-build', 'p');
  assert.equal(s.builds().length, 2);
  const putsBefore = reg.requests.filter(r => r.startsWith('PUT')).length;

  const again = JSON.parse((await s.agent('registry:arm64-build', 'p')).stdout);
  assert.deepEqual(again.map(r => r.result), ['present', 'present']);
  assert.ok(again.every(r => /^sha256:/.test(r.digest)));
  assert.equal(s.builds().length, 2, 'nothing built');
  assert.equal(reg.requests.filter(r => r.startsWith('PUT')).length, putsBefore, 'nothing pushed');

  // The project pins a new tag of the database image.
  const next = reg.upstream(DB_PATH, '18.6.20');
  s.git('tag', 'v18.6.20');
  s.images(`${DB}:18.6.20\n${TOOLS}:2.1\n`);
  const bumped = JSON.parse((await s.agent('registry:arm64-build', 'p')).stdout);
  assert.deepEqual(bumped.map(r => [r.tag, r.result]), [['18.6.20', 'built'], ['2.1', 'present']]);
  assert.equal(s.builds().length, 3);
  assert.match(s.builds()[2], /-t harness-arm64\.local\/example-gcp-project\/containers\/example-db:18\.6\.20 .*--build-arg PG_TAG=18\.6\.20/);
  assert.equal(JSON.parse(reg.get(`0local/${DB_PATH}`, '18.6.20').body).manifests[0].digest, next.digest);
  assert.equal(s.state()[DB].tag, '18.6.20');
  // Only one image, by name.
  assert.deepEqual(JSON.parse((await s.agent('registry:arm64-build', 'p', TOOLS)).stdout).map(r => r.image), [TOOLS]);
  await assert.rejects(s.agent('registry:arm64-build', 'p', `${AR}/example-gcp-project/containers/other`), e => /declares no arm64 image/.test(e.stderr));

  // The sweep took the arm64 image the index names: not whole, so built again.
  const arm64 = JSON.parse(reg.get(`0local/${TOOLS_PATH}`, '2.1').body).manifests[1].digest;
  reg.manifests.delete(`0local/${TOOLS_PATH}@${arm64}`);
  assert.deepEqual(JSON.parse((await s.agent('registry:arm64-build', 'p', TOOLS)).stdout).map(r => r.result), ['built']);
});

test('AC3: a failed build is reported per image with its build log, the other images still built, and VMs still pull the upstream amd64 image', async t => {
  const reg = await fakeRegistry();
  t.after(reg.close);
  const db = reg.upstream(DB_PATH, '18.6.19'); reg.upstream(TOOLS_PATH, '2.1');
  const s = setup(reg);
  writeFileSync(join(s.dir, 'fail-build'), 'make pgtap');
  const e = await s.agent('registry:arm64-build', 'p').then(() => assert.fail('it should fail'), x => x);
  assert.equal(e.code, 1);
  const out = JSON.parse(e.stdout);
  assert.deepEqual(out.map(r => [r.image, r.result]), [[DB, 'failed'], [TOOLS, 'built']]);
  assert.equal(out[0].error, 'the linux/arm64 build failed');
  assert.equal(out[0].digest, null);
  assert.equal(out[0].log, join(s.storage, 'arm64', 'example-gcp-project_containers_example-db.log'));
  assert.match(readFileSync(out[0].log, 'utf8'), /did not complete successfully/);
  // On stderr: the image, why, and the build log's end.
  assert.match(e.stderr, new RegExp(`registry:arm64-build: ${DB}:18\\.6\\.19: the linux/arm64 build failed — VMs pull it as amd64 \\(emulated\\) until it builds; build log ${out[0].log}:\\n[\\s\\S]*  #7 ERROR: process "/bin/sh -c make pgtap" did not complete successfully`));
  // Nothing of it in 0local: a VM's pull falls through to the cache's amd64 image.
  assert.deepEqual(reg.requests.filter(r => r.startsWith(`PUT /v2/0local/${DB_PATH}/manifests/`)), []);
  assert.deepEqual(vmPull(reg, DB_PATH, '18.6.19'), { from: DB_PATH, platform: 'amd64', digest: db.digest });
  assert.deepEqual(Object.keys(s.state()), [TOOLS]);
  const status = JSON.parse((await s.agent('registry:arm64-status', 'p')).stdout);
  assert.deepEqual(status.map(i => [i.image, i.arm64, i.log]), [[DB, false, out[0].log], [TOOLS, true, join(s.storage, 'arm64', 'example-gcp-project_containers_example-tools.log')]]);

  // A registry that cannot fetch the image upstream (the Mac logged out) fails the image, saying so, before any build.
  const lost = setup(reg, { images: `${DB}:9.9\n${TOOLS}:2.1\n` });
  const e2 = await lost.agent('registry:arm64-build', 'p', DB).then(() => assert.fail('it should fail'), x => x);
  assert.match(JSON.parse(e2.stdout)[0].error, /could not fetch .*example-db:9\.9 through p's registry/);
  assert.deepEqual(lost.builds(), []);
});

test('an upstream image that is multi-arch with linux/arm64 already needs no build', async t => {
  const reg = await fakeRegistry();
  t.after(reg.close);
  reg.upstream(TOOLS_PATH, '2.1');
  const amd = reg.upstream(DB_PATH, 'amd'), arm = reg.upstream(DB_PATH, 'arm');
  reg.manifest(DB_PATH, '18.6.19', JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [
    { mediaType: DOCKER_MANIFEST, digest: amd.digest, size: 1, platform: { architecture: 'amd64', os: 'linux' } },
    { mediaType: DOCKER_MANIFEST, digest: arm.digest, size: 1, platform: { architecture: 'arm64', os: 'linux' } }] }), OCI_INDEX);
  const s = setup(reg);
  const out = JSON.parse((await s.agent('registry:arm64-build', 'p', DB)).stdout);
  assert.deepEqual(out.map(r => [r.result, r.digest]), [['upstream', null]]);
  assert.deepEqual(s.builds(), []);
});

test('AC5: registry:arm64-status reports per declared image the pinned tag, whether an arm64 variant exists, when it was built and its digest', async t => {
  const reg = await fakeRegistry();
  t.after(reg.close);
  reg.upstream(DB_PATH, '18.6.19'); reg.upstream(TOOLS_PATH, '2.1');
  const s = setup(reg);
  assert.deepEqual(JSON.parse((await s.agent('registry:arm64-status', 'p')).stdout), [
    { image: DB, tag: '18.6.19', arm64: false, 'built-at': null, digest: null, index: null, log: null },
    { image: TOOLS, tag: '2.1', arm64: false, 'built-at': null, digest: null, index: null, log: null },
  ]);
  await s.agent('registry:arm64-build', 'p', DB);
  const [db, tools] = JSON.parse((await s.agent('registry:arm64-status', 'p')).stdout);
  const state = s.state()[DB];
  assert.deepEqual(db, { image: DB, tag: '18.6.19', arm64: true, 'built-at': state['built-at'], digest: state.digest, index: state.index, log: join(s.storage, 'arm64', 'example-gcp-project_containers_example-db.log') });
  assert.equal(tools.arm64, false);
  // A new pin has no variant yet, whatever was built for the last.
  reg.upstream(DB_PATH, '18.6.20');
  s.images(`${DB}:18.6.20\n${TOOLS}:2.1\n`);
  assert.deepEqual(JSON.parse((await s.agent('registry:arm64-status', 'p')).stdout)[0], { image: DB, tag: '18.6.20', arm64: false, 'built-at': null, digest: null, index: null, log: db.log });
  // zot not answering: unknown.
  await reg.close();
  assert.deepEqual(JSON.parse((await s.agent('registry:arm64-status', 'p')).stdout).map(i => i.arm64), [null, null]);
});

test('registry:sweep deletes a 0local multi-arch index together with the images it names, the index first, never one of them alone', async t => {
  const reg = await fakeRegistry();
  t.after(reg.close);
  const s = setup(reg);
  // zot's storage: 0local's index over an amd64 and an arm64 image (300 KB each), and a cached image pulled later.
  const images = join(s.storage, 'images');
  const write = (repo, content) => { const blobs = join(images, repo, 'blobs', 'sha256'); mkdirSync(blobs, { recursive: true }); writeFileSync(join(blobs, sha(content).slice(7)), content); return { digest: sha(content), size: Buffer.byteLength(content) }; };
  const image = (repo, fill) => { const layer = write(repo, Buffer.alloc(300_000, fill)); return write(repo, JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: { digest: 'sha256:00', size: 2 }, layers: [layer] })); };
  const local = `0local/${DB_PATH}`;
  const amd = image(local, 'a'), arm = image(local, 'b');
  const index = write(local, JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [{ ...amd, platform: { architecture: 'amd64', os: 'linux' } }, { ...arm, platform: { architecture: 'arm64', os: 'linux' } }] }));
  writeFileSync(join(images, local, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [
    { mediaType: OCI_MANIFEST, ...amd }, { mediaType: OCI_MANIFEST, ...arm }, { mediaType: OCI_INDEX, ...index, annotations: { 'org.opencontainers.image.ref.name': '18.6.19' } }] }));
  const cached = image('x/c', 'c');
  writeFileSync(join(images, 'x/c', 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: OCI_MANIFEST, ...cached }] }));
  // The arm64 image was pulled last of all, the index (by tag) first: the index's own pull decides.
  writeFileSync(join(s.storage, 'last-pulls.json'), JSON.stringify({ [`${local}@18.6.19`]: 1000, [`${local}@${arm.digest}`]: 9000, [`x/c@${cached.digest}`]: 5000 }));
  const json = JSON.parse(readFileSync(join(s.dir, 'projects', 'p', 'project.json'), 'utf8'));
  writeFileSync(join(s.dir, 'projects', 'p', 'project.json'), JSON.stringify({ ...json, registry: { ...json.registry, 'max-size-gb': 0.0007 } }));
  const swept = JSON.parse((await s.agent('registry:sweep', 'p')).stdout);
  assert.deepEqual(swept.deleted, [`${local}@${index.digest}`, `${local}@${amd.digest}`, `${local}@${arm.digest}`]);
  assert.deepEqual(reg.requests.filter(r => r.startsWith('DELETE')).map(r => r.split('/manifests/')[1]), [index.digest, amd.digest, arm.digest]);
});
