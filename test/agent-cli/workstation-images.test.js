// A project's images on a GCP workstation (ASS-472), pulled at a step's claim
// once per boot of the workstation: a local rebuild in zot (registry:push's)
// first, as in a VM; else straight from Artifact Registry under its own name,
// as the workstation's service account (the metadata server's token, in a
// Docker config of the run's own: the owner's is never touched, no token
// shown or recorded); else through zot, why said; each pull logged with its
// source and time, and the run's summary on the workstation's live data
// (last-image-pull). Against a fake workstation (fake-workstation.js: its
// docker asks the registries) and fake registries and metadata server
// (fake-registry.js).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wsFixture, closeAll, edit, ID } from './workstation-fixture.js';
import { fakeRegistry, fakeMetadata } from '../support/fake-registry.js';

const servers = [];
afterEach(async () => { await closeAll(); for (const s of servers.splice(0)) await s.close(); });

const TOKEN = 'ya29.service-account-token-TEST';
const AR = 'us-central1-docker.pkg.dev', P = 'example-project';
const digest = c => `sha256:${c.repeat(64)}`;
const name = path => `${AR}/${P}/${path}`;

// The fixture's project p on fake registries: Artifact Registry (asking for the service account's token), zot (asking
// nothing) on the workstation's loopback, and the metadata server; images.txt as given.
async function setup(images) {
  const s = wsFixture();
  const ar = await fakeRegistry({ token: TOKEN }), zot = await fakeRegistry(), metadata = await fakeMetadata(TOKEN);
  servers.push(ar, zot, metadata);
  Object.assign(s.env, { FAKE_AR_URL: ar.url, HARNESS_WS_METADATA_URL: metadata.url });
  edit(s.at('projects', 'p', 'project.json'), p => {
    p.registry = { 'storage-path': 'projects/p/registry', 'max-size-gb': 1, port: zot.port, upstream: { host: AR, credentials: 'gcloud' } };
    p['golden-image'] = { folder: 'projects/p/golden-image' };
  });
  mkdirSync(s.at('projects', 'p', 'golden-image'), { recursive: true });
  writeFileSync(s.at('projects', 'p', 'golden-image', 'images.txt'), images.join('\n'));
  const ws = join(s.w.system(ID), '..');
  const read = file => (existsSync(join(ws, file)) ? readFileSync(join(ws, file), 'utf8').trim().split('\n').filter(Boolean) : []);
  const held = () => Object.fromEntries(read('images').map(l => l.split(' ')));
  const claim = async () => {
    const r = await s.result('workstation:claim', 'p', 'ABC-3', 'A');
    assert.equal(r.code, 0, r.err);
    return r;
  };
  const release = async () => assert.equal((await s.result('workstation:release', 'p', ID, '--force')).code, 0);
  // A new boot of the workstation, as far as the images are concerned: its images are pulled at the next claim.
  const reboot = () => edit(s.at('projects', 'p', 'workstations.json'), w => { delete w[ID]['images-boot-id']; });
  assert.equal((await s.result('vm:create', 'p', 'ABC-3', 'A')).code, 0);
  return { s, ar, zot, metadata, pulls: () => read('pulls'), held, claim, release, reboot };
}

test('AC1, AC2, AC3: Artifact Registry first as the service account, zot the fallback (why said), a local rebuild in zot winning; each pull logged with its source and time, the summary recorded; no token shown or kept; once per boot', async () => {
  const t = await setup([
    '# baked in',
    `${name('containers/devcontainer')}:1.8.12`,
    `${name('containers/keycloak')}:master`,
    `${name('dockerhub/caddy')}:2.10.2-alpine@${digest('c')}`,
    `${name('containers/only-in-zot')}:2.0`,
    `${name('containers/nowhere')}:1`,
    '',
    'docker.io/library/node:24',
  ]);
  // Artifact Registry: the dev container, keycloak and the pinned caddy. zot: a local rebuild of the dev container
  // (registry:push's), and a tag Artifact Registry lacks in its cache.
  t.ar.put(`${P}/containers/devcontainer`, '1.8.12', digest('a'));
  t.ar.put(`${P}/containers/keycloak`, 'master', digest('b'));
  t.ar.put(`${P}/dockerhub/caddy`, digest('c'), digest('c'));
  t.zot.put(`0local/${P}/containers/devcontainer`, '1.8.12', digest('1'));
  t.zot.put(`${P}/containers/only-in-zot`, '2.0', digest('2'));

  const r = await t.claim();
  const port = t.zot.port;
  assert.deepEqual(t.pulls(), [
    `127.0.0.1:${port}/0local/${P}/containers/devcontainer:1.8.12 no`,
    `${name('containers/keycloak')}:master yes`,
    `${name('dockerhub/caddy')}:2.10.2-alpine@${digest('c')} yes`,
    `${name('containers/only-in-zot')}:2.0 yes`,
    `127.0.0.1:${port}/${P}/containers/only-in-zot:2.0 no`,
    `${name('containers/nowhere')}:1 yes`,
    `127.0.0.1:${port}/${P}/containers/nowhere:1 no`,
  ], 'the rebuild from zot; the rest from Artifact Registry with the service account\'s token first, zot after a failure; never another registry\'s image');
  assert.deepEqual(t.held(), {
    [`127.0.0.1:${port}/0local/${P}/containers/devcontainer:1.8.12`]: digest('1'),
    [`${name('containers/devcontainer')}:1.8.12`]: digest('1'),
    [`${name('containers/keycloak')}:master`]: digest('b'),
    [`${name('dockerhub/caddy')}:2.10.2-alpine`]: digest('c'),
    [`127.0.0.1:${port}/${P}/containers/only-in-zot:2.0`]: digest('2'),
    [`${name('containers/only-in-zot')}:2.0`]: digest('2'),
  }, 'what came through zot tagged as named: the local rebuild wins under the unchanged name');
  assert.ok(t.metadata.asked.length >= 4, 'the token asked of the metadata server before each pull from Artifact Registry');

  // AC3: each pull logged with its source and time; the summary.
  assert.match(r.err, /pulling 5 images on workstation ada-dev: Artifact Registry \(us-central1-docker\.pkg\.dev\) first, zot \(127\.0\.0\.1:\d+\) the fallback/);
  assert.match(r.err, /workstation ada-dev: pulled us-central1-docker\.pkg\.dev\/example-project\/containers\/keycloak:master from Artifact Registry in \d+s \(downloaded\)/);
  assert.match(r.err, /pulled us-central1-docker\.pkg\.dev\/example-project\/containers\/devcontainer:1\.8\.12 through zot in \d+s \(downloaded\): a local rebuild \(registry:push\) in zot, which wins over Artifact Registry's/);
  assert.match(r.err, /pulled us-central1-docker\.pkg\.dev\/example-project\/containers\/only-in-zot:2\.0 through zot in \d+s \(downloaded\): Artifact Registry: Error response from daemon: manifest for .* not found/);
  assert.match(r.err, /could not pull us-central1-docker\.pkg\.dev\/example-project\/containers\/nowhere:1 \(\d+s\): Artifact Registry: .*not found.*; zot \(127\.0\.0\.1:\d+\/example-project\/containers\/nowhere:1\): .*not found.*; the workstation keeps the image it has/);
  assert.match(r.err, /images pulled in \d+s: 2 from Artifact Registry, 2 through zot, 1 failed \(0 already up to date\)/);
  const entry = t.s.entry();
  const last = entry['last-image-pull'];
  assert.deepEqual({ ...last, at: undefined, seconds: undefined }, {
    at: undefined, seconds: undefined, 'boot-id': entry.setup['boot-id'],
    'from-registry': 2, 'from-zot': 2, failed: 1, 'up-to-date': 0,
    zot: [
      { image: `${name('containers/devcontainer')}:1.8.12`, why: 'a local rebuild (registry:push) in zot, which wins over Artifact Registry\'s' },
      { image: `${name('containers/only-in-zot')}:2.0`, why: `Artifact Registry: Error response from daemon: manifest for ${name('containers/only-in-zot')}:2.0 not found: manifest unknown: manifest unknown` },
    ],
    failures: [{ image: `${name('containers/nowhere')}:1`, why: last.failures[0].why }],
  });
  assert.match(last.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(entry['images-boot-id'], entry.setup['boot-id']);
  // No token anywhere: not in the log, not in the live data; the owner's Docker config never written.
  assert.ok(!r.err.includes(TOKEN) && !r.out.includes(TOKEN));
  assert.ok(!readFileSync(t.s.at('projects', 'p', 'workstations.json'), 'utf8').includes(TOKEN));
  assert.ok(!existsSync(join(t.s.w.home(ID), '.docker')), 'the owner\'s ~/.docker untouched');

  // Once per boot: the next step's claim pulls nothing.
  await t.release();
  const again = await t.claim();
  assert.equal(t.pulls().length, 7);
  assert.doesNotMatch(again.err, /pulling/);
});

test('AC2: after a new boot, images already there at the same digest are not downloaded again; a newer tag only in zot (registry:push) still arrives from zot', async () => {
  const dev = name('containers/devcontainer');
  const t = await setup([`${dev}:1.8.12`, `${name('containers/keycloak')}:master`]);
  t.ar.put(`${P}/containers/devcontainer`, '1.8.12', digest('a'));
  t.ar.put(`${P}/containers/keycloak`, 'master', digest('b'));
  await t.claim();
  assert.deepEqual(t.held(), { [`${dev}:1.8.12`]: digest('a'), [`${name('containers/keycloak')}:master`]: digest('b') });
  await t.release();

  // A new boot: the same images again, up to date; then a rebuild pushed under a tag Artifact Registry lacks.
  t.reboot();
  const same = await t.claim();
  assert.match(same.err, /pulled .*devcontainer:1\.8\.12 from Artifact Registry in \d+s \(up to date\)/);
  assert.match(same.err, /2 from Artifact Registry, 0 through zot, 0 failed \(2 already up to date\)/);
  assert.equal(t.s.entry()['last-image-pull']['up-to-date'], 2);
  await t.release();

  writeFileSync(t.s.at('projects', 'p', 'golden-image', 'images.txt'), `${dev}:1.8.13\n${name('containers/keycloak')}:master\n`);
  t.zot.put(`0local/${P}/containers/devcontainer`, '1.8.13', digest('3'));
  t.reboot();
  const newer = await t.claim();
  assert.match(newer.err, /pulled .*devcontainer:1\.8\.13 through zot in \d+s \(downloaded\): a local rebuild/);
  assert.equal(t.held()[`${dev}:1.8.13`], digest('3'));
  assert.ok(!t.ar.asked.some(a => a.includes('devcontainer/manifests/1.8.13')), 'Artifact Registry not asked for a tag zot has rebuilt');
  assert.deepEqual({ ...t.s.entry()['last-image-pull'], at: undefined, seconds: undefined, zot: undefined, 'boot-id': undefined },
    { at: undefined, seconds: undefined, zot: undefined, 'boot-id': undefined, 'from-registry': 1, 'from-zot': 1, failed: 0, 'up-to-date': 1, failures: [] });
});

test('AC1: with no token from the metadata server, Artifact Registry is not asked and every image comes through zot, why said', async () => {
  const t = await setup([`${name('containers/keycloak')}:master`]);
  t.ar.put(`${P}/containers/keycloak`, 'master', digest('b'));
  t.zot.put(`${P}/containers/keycloak`, 'master', digest('b'));
  t.metadata.failing();
  const r = await t.claim();
  assert.deepEqual(t.pulls(), [`127.0.0.1:${t.zot.port}/${P}/containers/keycloak:master no`]);
  assert.deepEqual(t.ar.asked, []);
  assert.match(r.err, /pulled .*keycloak:master through zot in \d+s \(downloaded\): Artifact Registry: no token from the metadata server for the workstation's service account: /);
  assert.equal(t.held()[`${name('containers/keycloak')}:master`], digest('b'));
  assert.equal(t.s.entry()['last-image-pull']['from-zot'], 1);
});
