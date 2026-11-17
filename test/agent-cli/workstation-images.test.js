// A project's images on a GCP workstation (ASS-472), pulled at a step's claim
// once per boot of the workstation: a local rebuild in zot (registry:push's)
// first, as in a VM; else straight from Artifact Registry under its own name,
// as the workstation's service account (the metadata server's token, in a
// Docker config of the run's own: the owner's is never touched, no token
// shown or recorded); else through zot, why said; each pull logged with its
// source and time, and the run's summary on the workstation's live data
// (last-image-pull). ASS-477: the agents' own pulls in the harness's
// sessions go to Artifact Registry as the service account too, through the
// harness's Docker config (docker-credential-harness), the owner's other
// registries kept. Against a fake workstation (fake-workstation.js: its
// docker asks the registries) and fake registries and metadata server
// (fake-registry.js).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wsFixture, closeAll, edit, ID } from './workstation-fixture.js';
import { fakeRegistry, fakeMetadata } from '../support/fake-registry.js';

const run = promisify(execFile);
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
  Object.assign(s.env, { FAKE_AR_URL: ar.url, HARNESS_WS_METADATA_URL: metadata.url, HARNESS_WS_PULL_RETRY_SECONDS: '0' });
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
  // ASS-473: an image the workstation's Docker already holds, as an older boot left it.
  const has = (image, d) => writeFileSync(join(ws, 'images'), `${read('images').join('\n')}\n${image} ${d}\n`.replace(/^\n/, ''));
  const release = async () => assert.equal((await s.result('workstation:release', 'p', ID, '--force')).code, 0);
  // A new boot of the workstation, as far as the images are concerned: its images are pulled at the next claim.
  const reboot = () => edit(s.at('projects', 'p', 'workstations.json'), w => { delete w[ID]['images-boot-id']; });
  assert.equal((await s.result('vm:create', 'p', 'ABC-3', 'A')).code, 0);
  return { s, ar, zot, metadata, pulls: () => read('pulls'), held, has, claim, release, reboot };
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
  t.has(`${name('containers/nowhere')}:1`, digest('9'));   // ASS-473: there at an older version, so its failure is a warning

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
    [`${name('containers/nowhere')}:1`]: digest('9'),
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
    'from-registry': 2, 'from-zot': 2, failed: 1, 'up-to-date': 0, missing: 0,
    zot: [
      { image: `${name('containers/devcontainer')}:1.8.12`, why: 'a local rebuild (registry:push) in zot, which wins over Artifact Registry\'s' },
      { image: `${name('containers/only-in-zot')}:2.0`, why: `Artifact Registry: Error response from daemon: manifest for ${name('containers/only-in-zot')}:2.0 not found: manifest unknown: manifest unknown` },
    ],
    failures: [{ image: `${name('containers/nowhere')}:1`, why: last.failures[0].why, present: true }],
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
    { at: undefined, seconds: undefined, zot: undefined, 'boot-id': undefined, 'from-registry': 1, 'from-zot': 1, failed: 0, 'up-to-date': 1, missing: 0, failures: [] });
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

// ASS-473: retries, and an image that still fails: a warning when the workstation has it at an older version, the
// claim failed (5) when it has none.
test('ASS-473 AC1, AC4: a pull that fails is tried again, 3 tries from each source, and pulled; a registry that fails every try leaves it to zot; "not found" is not asked again', async () => {
  const t = await setup([`${name('containers/keycloak')}:master`]);
  t.ar.put(`${P}/containers/keycloak`, 'master', digest('b'));
  t.ar.flaky(2);
  const r = await t.claim();
  const ar = `${name('containers/keycloak')}:master yes`;
  assert.deepEqual(t.pulls(), [ar, ar, ar], 'tried 3 times from Artifact Registry, the third pulled');
  assert.match(r.err, /pull-images: pulling .*keycloak:master from Artifact Registry failed \(try 1 of 3\): .*; trying again in 0s/);
  assert.match(r.err, /\(try 2 of 3\)/);
  assert.match(r.err, /pulled .*keycloak:master from Artifact Registry in \d+s \(downloaded\)/);
  assert.equal(t.held()[`${name('containers/keycloak')}:master`], digest('b'));

  // Artifact Registry failing every try: on to zot after its 3.
  await t.release();
  t.reboot();
  writeFileSync(t.s.at('projects', 'p', 'golden-image', 'images.txt'), `${name('containers/caddy')}:2\n${name('containers/nowhere')}:1\n`);
  t.ar.put(`${P}/containers/caddy`, '2', digest('c'));
  t.zot.put(`${P}/containers/caddy`, '2', digest('c'));
  t.has(`${name('containers/nowhere')}:1`, digest('9'));
  t.ar.flaky(3);
  const z = await t.claim();
  assert.deepEqual(t.pulls().slice(3), [
    `${name('containers/caddy')}:2 yes`, `${name('containers/caddy')}:2 yes`, `${name('containers/caddy')}:2 yes`,
    `127.0.0.1:${t.zot.port}/${P}/containers/caddy:2 no`,
    `${name('containers/nowhere')}:1 yes`, `127.0.0.1:${t.zot.port}/${P}/containers/nowhere:1 no`,
  ], 'a source that says it has no such image is asked once');
  assert.match(z.err, /pulled .*caddy:2 through zot in \d+s \(downloaded\): Artifact Registry: .*connection refused \(3 tries\)/);
});

test('ASS-473 AC2, AC4: an image that still fails and is not on the workstation fails the claim (5), naming it and the error; the workstation is given back and nothing recorded as pulled; the next claim pulls again and goes on', async () => {
  const t = await setup([`${name('containers/keycloak')}:master`, `${name('containers/nowhere')}:1`]);
  t.ar.put(`${P}/containers/keycloak`, 'master', digest('b'));
  const r = await t.s.result('workstation:claim', 'p', 'ABC-3', 'A');
  assert.equal(r.code, 5, r.err);
  assert.match(r.err, /could not pull .*nowhere:1 \(\d+s\): Artifact Registry: .*not found.*; zot .*not found.*; the workstation has no such image/);
  assert.match(r.err, /1 from Artifact Registry, 0 through zot, 1 failed, 1 of them not there/);
  const last = r.err.trim().split('\n').at(-1);
  assert.match(last, new RegExp(`^workstation:claim: ABC-3 A's step cannot start on workstation ada-dev: images it needs could not be pulled and are not there: ${name('containers/nowhere')}:1 \\(Artifact Registry: Error response from daemon: manifest for .* not found.*\\); it is given back$`));
  const entry = t.s.entry();
  assert.equal(entry.holder, undefined, 'given back');
  assert.equal(entry['images-boot-id'], undefined, 'not recorded as pulled for the boot');
  assert.equal(entry['last-image-pull'].missing, 1);
  assert.deepEqual(entry['last-image-pull'].failures.map(f => [f.image, f.present]), [[`${name('containers/nowhere')}:1`, false]]);
  assert.equal(t.s.variation('A').workstation, undefined, 'the variation holds no workstation');

  // The registry has it again: the next claim pulls every image again and goes on.
  t.ar.put(`${P}/containers/nowhere`, '1', digest('d'));
  await t.claim();
  assert.equal(t.held()[`${name('containers/nowhere')}:1`], digest('d'));
  assert.equal(t.s.entry()['images-boot-id'], t.s.entry().setup['boot-id']);
  assert.equal(t.s.entry().holder.ticket, 'ABC-3');
});

test('ASS-473 AC2, AC4: an image that still fails but is on the workstation at an older version is a warning: the claim goes on with it', async () => {
  const pinned = `${name('dockerhub/caddy')}@${digest('e')}`;
  const t = await setup([`${name('containers/nowhere')}:1`, pinned]);
  t.has(`${name('containers/nowhere')}:1`, digest('9'));
  t.has(`${name('dockerhub/caddy')}`, digest('e'));
  const r = await t.claim();
  assert.match(r.err, /could not pull .*nowhere:1 \(\d+s\): .*; the workstation keeps the image it has/);
  assert.match(r.err, /could not pull .*caddy@sha256:e+ \(\d+s\): .*; the workstation keeps the image it has/);
  assert.match(r.err, /0 from Artifact Registry, 0 through zot, 2 failed \(0 already up to date\)/);
  const entry = t.s.entry();
  assert.deepEqual(entry['last-image-pull'].failures.map(f => f.present), [true, true]);
  assert.equal(entry['images-boot-id'], entry.setup['boot-id'], 'a warning: recorded as pulled for the boot');
  assert.equal(entry.holder.ticket, 'ABC-3');
});

// ASS-477: the agents' own pulls (docker pull, docker compose up, devcontainer builds) in the harness's sessions
// use the harness's Docker config, ~/harness/docker: the owner's, with the Artifact Registry host's credentials
// from docker-credential-harness (the workstation's service account, the metadata server's token) instead of the
// owner's gcloud helper, whose login on the workstation lapses.
const MACHINE_BASH = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'machine.bash');
const bash = (script, env) => run('bash', ['-c', `source "${MACHINE_BASH}" && ${script}`], { env }).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));
const basic = token => Buffer.from(`oauth2accesstoken:${token}`).toString('base64');
// Every file under a folder (links followed), each with its mode, mtime and content: the owner's ~/.docker as it is.
function files(dir, rel = '') {
  const out = {};
  for (const n of readdirSync(join(dir, rel))) {
    const r = rel ? `${rel}/${n}` : n, st = statSync(join(dir, r));
    if (st.isDirectory()) Object.assign(out, files(dir, r)); else out[r] = `${st.mode.toString(8)} ${st.mtimeMs} ${readFileSync(join(dir, r), 'utf8')}`;
  }
  return out;
}

// The owner's Docker setup on the workstation, as ASS-472 found it: Artifact Registry sent to the owner's gcloud
// helper, its login expired; another registry logged in (auths), a third through a helper of the owner's own; a
// context and a per-user compose plugin.
async function ownerDocker(t) {
  const other = await fakeRegistry({ token: 'OTHER-SECRET' }), third = await fakeRegistry({ token: 'THIRD-SECRET' });
  servers.push(other, third);
  other.put('team/tool', '1', digest('5'));
  third.put('team/base', '2', digest('6'));
  const bin = t.s.w.system(ID);
  writeFileSync(join(bin, 'docker-credential-gcloud'), '#!/bin/bash\necho "ERROR: (gcloud.auth.docker-helper) There was a problem refreshing your current auth tokens: Reauthentication failed." >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'docker-credential-owner'), '#!/bin/bash\nread -r h\necho "{\\"ServerURL\\":\\"$h\\",\\"Username\\":\\"oauth2accesstoken\\",\\"Secret\\":\\"THIRD-SECRET\\"}"\n', { mode: 0o755 });
  const home = t.s.w.home(ID), docker = join(home, '.docker');
  mkdirSync(join(docker, 'contexts', 'meta', 'abc'), { recursive: true });
  mkdirSync(join(docker, 'cli-plugins'), { recursive: true });
  writeFileSync(join(docker, 'contexts', 'meta', 'abc', 'meta.json'), '{"Name":"remote"}');
  writeFileSync(join(docker, 'cli-plugins', 'docker-compose'), '#!/bin/bash\n', { mode: 0o755 });
  const config = {
    auths: { [`127.0.0.1:${other.port}`]: { auth: basic('OTHER-SECRET') }, [`https://${AR}`]: { auth: basic('ya29.an-old-login') } },
    credHelpers: { [AR]: 'gcloud', [`127.0.0.1:${third.port}`]: 'owner' },
    psFormat: 'table {{.ID}}',
  };
  writeFileSync(join(docker, 'config.json'), JSON.stringify(config, null, 2));
  return { other, third, docker, config, home };
}

test('ASS-477 AC1, AC2, AC4: an agent session\'s docker pull of an Artifact Registry image uses the service account\'s token through the harness\'s Docker config, the owner\'s gcloud login expired; the owner\'s other registries still work; the owner\'s ~/.docker unchanged; the config follows the owner\'s at each claim', async () => {
  const t = await setup([]);
  t.ar.put(`${P}/containers/keycloak`, 'master', digest('b'));
  const o = await ownerDocker(t);
  const before = files(o.docker);
  const r = await t.claim();
  const machine = `workstation:p:${ID}:${t.s.root()}`;
  const hd = join(t.s.root(), 'docker');

  // AC1: the harness's sessions get DOCKER_CONFIG ~/harness/docker, its Artifact Registry helper the harness's.
  const session = await bash(`machine_run --workdir / "${machine}" -- bash -c 'echo "$DOCKER_CONFIG"'`, t.s.env);
  assert.equal(session.out.trim(), hd, session.err);
  const config = JSON.parse(readFileSync(join(hd, 'config.json'), 'utf8'));
  assert.deepEqual(config, {
    auths: { [`127.0.0.1:${o.other.port}`]: { auth: basic('OTHER-SECRET') } },
    credHelpers: { [AR]: 'harness', [`127.0.0.1:${o.third.port}`]: 'owner' },
    psFormat: 'table {{.ID}}',
  }, 'the owner\'s config carried over (AC2), the Artifact Registry host\'s own login dropped and its helper the harness\'s');
  assert.equal(statSync(hd).mode & 0o777, 0o700);
  assert.equal(readlinkSync(join(hd, 'contexts')), join(o.docker, 'contexts'));
  assert.equal(readlinkSync(join(hd, 'cli-plugins')), join(o.docker, 'cli-plugins'));

  // AC3, AC4: the pull, as the service account; the owner's own session (no harness env) still fails as it did.
  const pulled = await bash(`machine_run --workdir / "${machine}" -- docker pull ${name('containers/keycloak')}:master`, t.s.env);
  assert.equal(pulled.code, 0, pulled.err);
  assert.equal(t.held()[`${name('containers/keycloak')}:master`], digest('b'));
  assert.deepEqual(t.pulls().at(-1), `${name('containers/keycloak')}:master yes`);
  const owners = await t.s.result('workstation:ssh', 'p', ID, 'docker', 'pull', `${name('containers/keycloak')}:master`);
  assert.notEqual(owners.code, 0);
  assert.match(owners.err, /error getting credentials/, 'the owner\'s config, its gcloud login expired, as ASS-472 found it');

  // AC2, AC4: another registry's auth and the owner's helper for a third host still work in the agents' sessions.
  for (const ref of [`127.0.0.1:${o.other.port}/team/tool:1`, `127.0.0.1:${o.third.port}/team/base:2`]) {
    const p = await bash(`machine_run --workdir / "${machine}" -- docker pull ${ref}`, t.s.env);
    assert.equal(p.code, 0, `${ref}: ${p.err}`);
    assert.equal(t.pulls().at(-1), `${ref} yes`);
  }

  // Never a token printed or written: not in the claim's or the pulls' output, nowhere in the workstation's home.
  for (const out of [r.out, r.err, pulled.out, pulled.err]) assert.ok(!out.includes(TOKEN));
  assert.ok(!Object.values(files(t.s.root())).some(c => c.includes(TOKEN)), 'no token under ~/harness');
  assert.deepEqual(files(o.docker), before, 'the owner\'s ~/.docker untouched');

  // Kept in step: the owner logs in to another registry and drops a plugin; the next step's claim follows.
  await t.release();
  const changed = { ...o.config, auths: { ...o.config.auths, 'registry.example.com': { auth: basic('NEW') } } };
  writeFileSync(join(o.docker, 'config.json'), JSON.stringify(changed));
  rmSync(join(o.docker, 'cli-plugins'), { recursive: true });
  await t.claim();
  const again = JSON.parse(readFileSync(join(hd, 'config.json'), 'utf8'));
  assert.deepEqual(again.auths['registry.example.com'], { auth: basic('NEW') });
  assert.equal(again.credHelpers[AR], 'harness');
  assert.ok(!existsSync(join(hd, 'cli-plugins')) && !lstatExists(join(hd, 'cli-plugins')), 'the link to what the owner removed removed');
});

const lstatExists = path => { try { lstatSync(path); return true; } catch { return false; } };

test('ASS-477 AC3: setup installs the credential helper and checks it gets a token, failing naming it when the metadata server gives none, no token printed; a project with no Artifact Registry upstream gets no harness Docker config', async () => {
  const t = await setup([]);
  const helper = join(t.s.root(), 'bin', 'docker-credential-harness');
  assert.ok(existsSync(helper));
  assert.ok(t.s.entry().setup.did.some(d => /^installed the harness's Docker credential helper/.test(d)));
  assert.ok(t.s.entry().setup.did.some(d => /^wrote the harness's Docker config .*us-central1-docker\.pkg\.dev's credentials the workstation's service account's/.test(d)));
  assert.deepEqual(JSON.parse(readFileSync(join(t.s.root(), 'docker', 'config.json'), 'utf8')), { credHelpers: { [AR]: 'harness' } }, 'no owner\'s config: the helper alone');

  // Docker's protocol: get answers the service account's token for the host; store, erase and list keep nothing.
  const get = await t.s.result('workstation:ssh', 'p', ID, 'bash', '-c', `. ~/harness/env && echo ${AR} | docker-credential-harness get`);
  assert.deepEqual(JSON.parse(get.out), { ServerURL: AR, Username: 'oauth2accesstoken', Secret: TOKEN });
  const list = await t.s.result('workstation:ssh', 'p', ID, 'bash', '-c', '. ~/harness/env && echo x | docker-credential-harness store && docker-credential-harness list');
  assert.equal(list.out.trim(), '{}');

  t.metadata.failing();
  const failed = await t.s.result('workstation:setup', 'p', ID);
  assert.equal(failed.code, 1);
  assert.match(failed.err, /setup failed: docker-credential-harness: gets no token for us-central1-docker\.pkg\.dev: no token from the metadata server for the workstation's service account/);
  t.metadata.failing(false);
  const ok = await t.s.result('workstation:setup', 'p', ID);
  assert.equal(ok.code, 0, ok.err);
  for (const out of [failed.out, failed.err, ok.out, ok.err]) assert.ok(!out.includes(TOKEN), 'no token printed');
  assert.ok(!readFileSync(t.s.at('projects', 'p', 'workstations.json'), 'utf8').includes(TOKEN));

  // No upstream: the setup's version changes, and its rerun removes the harness's Docker config, so the owner's is used.
  edit(t.s.at('projects', 'p', 'project.json'), p => { delete p.registry.upstream; });
  const none = await t.s.result('workstation:setup', 'p', ID);
  assert.equal(none.code, 0, none.err);
  assert.ok(!existsSync(join(t.s.root(), 'docker')));
  const env = await t.s.result('workstation:ssh', 'p', ID, 'bash', '-c', '. ~/harness/env && echo "${DOCKER_CONFIG-none}"');
  assert.equal(env.out.trim(), 'none');
});
