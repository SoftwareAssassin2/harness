// registry:* — each project's zot on the Mac (ASS-70). gcloud is a fake on
// PATH: it prints the token in its token file (or fails, as when logged out,
// while there is none). The zot registry:up downloads is a fake too (see
// server): it answers on its config's port and records each start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, rmSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { until } from '../support/until.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// example's upstream: Artifact Registry, logged in with the Mac's gcloud.
const AR = { host: 'us-central1-docker.pkg.dev', credentials: 'gcloud' };
const reg = (more = {}) => ({ 'storage-path': 'projects/p/registry', 'max-size-gb': 20, port: 5101, upstream: AR, ...more });

function setup({ registry = reg() } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'registry-')));
  const bin = join(dir, 'bin');
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true }); mkdirSync(bin);
  writeFileSync(join(dir, 'projects', 'p', 'project.json'), JSON.stringify({ name: 'P', ...(registry && { registry }) }, null, 4));
  const fake = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  fake('gcloud', `echo "$*" >> '${dir}/gcloud.log'\n[[ "$*" == "auth print-access-token" && -f '${dir}/token' ]] || { echo "ERROR: (gcloud.auth.print-access-token) You do not currently have an active account selected." >&2; exit 1; }\ncat '${dir}/token'`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJECTS_DIR: join(dir, 'projects'), ZOT_DIR: join(dir, 'zot'), ZOT_STARTS: join(dir, 'zot-starts.log') };
  const storage = join(dir, 'projects', 'p', 'registry');
  return {
    dir, storage, env,
    agent: (...args) => run(AGENT, args, { env }),
    gcloudCalls: () => (existsSync(join(dir, 'gcloud.log')) ? readFileSync(join(dir, 'gcloud.log'), 'utf8').trim().split('\n') : []),
    token: t => (t === null ? rmSync(join(dir, 'token'), { force: true }) : writeFileSync(join(dir, 'token'), `${t}\n`)),
    // Each start of the fake zot, as { pid, tz, args }.
    starts: () => (existsSync(join(dir, 'zot-starts.log')) ? readFileSync(join(dir, 'zot-starts.log'), 'utf8').trim().split('\n').map(l => { const [pid, tz, ...args] = l.split(' '); return { pid: Number(pid), tz, args }; }) : []),
  };
}

test('registry:refresh-credentials writes the Mac\'s gcloud token as zot\'s Artifact Registry login, 0600, and touches zot\'s config only when the token changed', async () => {
  const s = setup();
  mkdirSync(s.storage, { recursive: true });
  const config = join(s.storage, 'config.json');
  writeFileSync(config, '{}');
  const old = new Date('2026-01-01T00:00:00Z');
  utimesSync(config, old, old);
  s.token('ya29.first');
  const { stdout } = await s.agent('registry:refresh-credentials', 'p');
  assert.match(stdout, /refreshed/);
  const file = join(s.storage, 'credentials.json');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'us-central1-docker.pkg.dev': { username: 'oauth2accesstoken', password: 'ya29.first' } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(statSync(config).mtimeMs > old.getTime(), 'zot reloads its config, and with it the credentials, when the config is touched');
  utimesSync(config, old, old);
  assert.match((await s.agent('registry:refresh-credentials', 'p')).stdout, /unchanged/);
  assert.equal(statSync(config).mtimeMs, old.getTime());
});

test('registry:refresh-credentials fails, naming gcloud, when the Mac is not logged in, leaving the last login be', async () => {
  const s = setup();
  s.token('ya29.first');
  await s.agent('registry:refresh-credentials', 'p');
  s.token(null);
  await assert.rejects(s.agent('registry:refresh-credentials', 'p'), e => /gcloud is not logged in.*gcloud auth login/s.test(e.stderr));
  assert.equal(JSON.parse(readFileSync(join(s.storage, 'credentials.json'), 'utf8'))['us-central1-docker.pkg.dev'].password, 'ya29.first');
});

test('AC2: registry:refresh-credentials on a project with no upstream says so and succeeds, never calling gcloud', async () => {
  const s = setup({ registry: reg({ upstream: undefined }) });
  const { stdout } = await s.agent('registry:refresh-credentials', 'p');
  assert.match(stdout, /p's registry has no upstream; no credentials to refresh/);
  assert.deepEqual(s.gcloudCalls(), []);
  assert.equal(existsSync(join(s.storage, 'credentials.json')), false);
});

test('AC1: a project\'s upstream host comes from its project.json; an upstream without a host, or with a credential source other than gcloud, fails clearly', async () => {
  const s = setup({ registry: reg({ upstream: { host: 'europe-docker.pkg.dev', credentials: 'gcloud' } }) });
  s.token('ya29.first');
  await s.agent('registry:refresh-credentials', 'p');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(s.storage, 'credentials.json'), 'utf8'))), ['europe-docker.pkg.dev']);
  for (const upstream of [{ credentials: 'gcloud' }, { host: 'h.example', credentials: 'keychain' }, { host: 'h.example' }])
    await assert.rejects(setup({ registry: reg({ upstream }) }).agent('registry:refresh-credentials', 'p'), e => /upstream.*\{ "host": "<host>", "credentials": "gcloud" \}/.test(e.stderr), JSON.stringify(upstream));
});

test('registry commands fail on a project without a registry, or a bad project', async () => {
  const s = setup({ registry: null });
  await assert.rejects(s.agent('registry:refresh-credentials', 'p'), e => /p has no registry in project\.json/.test(e.stderr));
  await assert.rejects(s.agent('registry:refresh-credentials', '../p'), e => /invalid project/.test(e.stderr));
  await assert.rejects(s.agent('registry:refresh-credentials', 'q'), e => /no project q/.test(e.stderr));
  await assert.rejects(s.agent('registry:refresh-credentials'), e => /usage/.test(e.stderr));
});

// A stand-in for GitHub's release download and for zot's API: one HTTP
// server, counting downloads and recording every request. What it downloads
// is a fake zot: `zot serve <config>` records its start in $ZOT_STARTS and
// answers on the config's port.
const FAKE_ZOT = `#!/usr/bin/env node
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
fs.appendFileSync(process.env.ZOT_STARTS, \`\${process.pid} \${process.env.TZ} \${process.argv.slice(2).join(' ')}\\n\`);
require('node:http').createServer((req, res) => res.end('{}')).listen(Number(config.http.port), '127.0.0.1');
`;
async function server(handler = () => false) {
  const requests = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks), type: req.headers['content-type'] });
      if (handler(req, res, requests)) return;
      if (req.url === '/download/zot') return res.end(FAKE_ZOT);
      res.end('{}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return {
    port, requests,
    sha256: createHash('sha256').update(FAKE_ZOT).digest('hex'),
    env: { ZOT_URL: `http://127.0.0.1:${port}/download/zot` },
    close: () => srv.close(),
  };
}
// A port nothing listens on, for the fake zot.
const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = pid => until(() => !alive(pid));

test('registry:up installs the pinned zot, writes its config and login, and starts zot detached; run again, it changes nothing', async t => {
  const srv = await server();
  t.after(srv.close);
  const port = await freePort();
  const s = setup({ registry: reg({ port }) });
  t.after(() => { for (const { pid } of s.starts()) try { process.kill(pid); } catch { /* gone */ } });
  s.token('ya29.first');
  const env = { ...s.env, ...srv.env, ZOT_SHA256: srv.sha256 };
  const up = () => run(AGENT, ['registry:up', 'p'], { env });

  const first = JSON.parse((await up()).stdout);
  assert.deepEqual(first, { project: 'p', url: `http://127.0.0.1:${port}`, 'vm-url': `http://host.lima.internal:${port}`, storage: s.storage, changed: true });
  const bin = join(s.dir, 'zot', 'zot-v2.1.22');
  assert.equal(readFileSync(bin, 'utf8'), FAKE_ZOT);
  assert.ok(statSync(bin).mode & 0o100);
  const config = JSON.parse(readFileSync(join(s.storage, 'config.json'), 'utf8'));
  assert.equal(config.storage.rootDirectory, join(s.storage, 'images'));
  assert.deepEqual(config.http, { address: '127.0.0.1', port: String(port), compat: ['docker2s2'] });
  assert.equal(config.extensions.sync.credentialsFile, join(s.storage, 'credentials.json'));
  assert.deepEqual(config.extensions.sync.registries.map(r => [r.urls, r.onDemand, r.content]), [[['https://us-central1-docker.pkg.dev'], true, [{ prefix: '[a-z]*/**' }]]]);
  assert.equal(JSON.parse(readFileSync(join(s.storage, 'credentials.json'), 'utf8'))['us-central1-docker.pkg.dev'].password, 'ya29.first');
  // zot runs, its log times UTC (registry:sweep reads them), its pid kept.
  const [started] = s.starts();
  assert.deepEqual(s.starts(), [{ pid: started.pid, tz: 'UTC', args: ['serve', join(s.storage, 'config.json')] }]);
  assert.equal(Number(readFileSync(join(s.dir, 'zot', 'p.pid'), 'utf8')), started.pid);
  assert.equal(Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(started.pid)], { encoding: 'utf8' })), started.pid, 'its own session: killing control\'s process group leaves it running');
  assert.equal((await fetch(`http://127.0.0.1:${port}/v2/`)).status, 200);

  const second = JSON.parse((await up()).stdout);
  assert.equal(second.changed, false);
  assert.equal(srv.requests.filter(r => r.url === '/download/zot').length, 1);
  assert.equal(s.starts().length, 1);

  // A zot that stopped is started again.
  process.kill(started.pid);
  assert.ok(await gone(started.pid));
  assert.equal(JSON.parse((await up()).stdout).changed, true);
  assert.equal(s.starts().length, 2);

  // A changed setting restarts zot with it.
  const file = join(s.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ name: 'P', registry: reg({ 'storage-path': 'elsewhere', port }) }));
  const moved = JSON.parse((await up()).stdout);
  assert.equal(moved.storage, join(s.dir, 'elsewhere'));
  assert.ok(await gone(s.starts()[1].pid), 'the zot on the old config is stopped');
  assert.deepEqual(s.starts().slice(2).map(z => z.args), [['serve', join(s.dir, 'elsewhere', 'config.json')]]);
  assert.ok(alive(s.starts()[2].pid));
});

test('registry:up run several times at once for a project starts one zot (ASS-179 AC2): one runs at a time, the rest find it answering', async t => {
  const srv = await server();
  t.after(srv.close);
  const port = await freePort();
  const s = setup({ registry: reg({ port }) });
  t.after(() => { for (const { pid } of s.starts()) try { process.kill(pid); } catch { /* gone */ } });
  s.token('ya29.first');
  const env = { ...s.env, ...srv.env, ZOT_SHA256: srv.sha256 };
  const ups = await Promise.all(Array.from({ length: 4 }, () => run(AGENT, ['registry:up', 'p'], { env })));
  assert.equal(s.starts().length, 1);
  assert.deepEqual(ups.map(u => JSON.parse(u.stdout).changed).toSorted(), [false, false, false, true]);
});

test('AC2: registry:up on a project with no upstream starts zot with no sync, gcloud logged out and never called', async t => {
  const srv = await server();
  t.after(srv.close);
  const port = await freePort();
  const s = setup({ registry: reg({ port, upstream: undefined }) });
  t.after(() => { for (const { pid } of s.starts()) try { process.kill(pid); } catch { /* gone */ } });
  const up = JSON.parse((await run(AGENT, ['registry:up', 'p'], { env: { ...s.env, ...srv.env, ZOT_SHA256: srv.sha256 } })).stdout);
  assert.equal(up.url, `http://127.0.0.1:${port}`);
  const config = JSON.parse(readFileSync(join(s.storage, 'config.json'), 'utf8'));
  assert.deepEqual(config.extensions, { search: { enable: true } }, 'no sync: zot fetches from nowhere');
  assert.equal(s.starts().length, 1);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v2/`)).status, 200);
  assert.deepEqual(s.gcloudCalls(), []);
  assert.equal(existsSync(join(s.storage, 'credentials.json')), false);
});

test('registry:up leaves be a zot it did not start that answers on the port', async t => {
  const srv = await server();
  t.after(srv.close);
  const s = setup({ registry: reg({ port: srv.port }) });
  s.token('ya29.first');
  const up = JSON.parse((await run(AGENT, ['registry:up', 'p'], { env: { ...s.env, ...srv.env, ZOT_SHA256: srv.sha256 } })).stdout);
  assert.equal(up.url, `http://127.0.0.1:${srv.port}`);
  assert.deepEqual(s.starts(), []);
});

test('registry:up refuses a download whose checksum is not the pinned one, and stops before installing when gcloud is not logged in', async t => {
  const srv = await server();
  t.after(srv.close);
  const s = setup({ registry: reg({ port: await freePort() }) });
  s.token('ya29.first');
  await assert.rejects(run(AGENT, ['registry:up', 'p'], { env: { ...s.env, ...srv.env, ZOT_SHA256: 'f'.repeat(64) } }), e => /checksum/.test(e.stderr));
  assert.equal(existsSync(join(s.dir, 'zot', 'zot-v2.1.22')), false);
  s.token(null);
  await assert.rejects(run(AGENT, ['registry:up', 'p'], { env: { ...s.env, ...srv.env, ZOT_SHA256: srv.sha256 } }), e => /gcloud is not logged in/.test(e.stderr));
  assert.deepEqual(s.starts(), []);
});

// An image as `docker save` writes it (an OCI layout): an index over one
// manifest over a config and a layer. The fake docker prints it as a tar.
function savedImage(s) {
  const layout = join(s.dir, 'layout'), blobs = join(layout, 'blobs', 'sha256');
  mkdirSync(blobs, { recursive: true });
  const blob = content => {
    const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    writeFileSync(join(blobs, digest.slice(7)), content);
    return { digest, size: Buffer.byteLength(content) };
  };
  const layer = blob('layer bytes'), config = blob('{"architecture":"arm64"}');
  const manifest = blob(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config }, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...layer }] }));
  const index = blob(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', ...manifest }] }));
  writeFileSync(join(layout, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.index.v1+json', ...index }] }));
  writeFileSync(join(layout, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
  execFileSync('tar', ['-c', '-f', join(s.dir, 'image.tar'), '-C', layout, '.']);
  writeFileSync(join(s.dir, 'bin', 'docker'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${s.dir}/docker.log'\n[[ "$1" == save ]] && cat '${s.dir}/image.tar'\n`);
  chmodSync(join(s.dir, 'bin', 'docker'), 0o755);
  return { layer, config, manifest, index };
}

test('registry:push pushes a locally built image into the project\'s zot under its upstream name, in the namespace VMs ask first', async t => {
  // A registry that has no blob yet, takes uploads at a Location, and stores manifests.
  const srv = await server((req, res) => {
    if (req.method === 'HEAD') { res.statusCode = 404; return res.end() || true; }
    if (req.method === 'POST') { res.statusCode = 202; res.setHeader('Location', `${req.url}u-${Math.random()}`); return res.end() || true; }
    if (req.method === 'PUT') { res.statusCode = 201; return res.end() || true; }
    return false;
  });
  t.after(srv.close);
  const s = setup({ registry: reg({ port: srv.port }) });
  const image = savedImage(s);
  const name = 'us-central1-docker.pkg.dev/example-project/containers/devcontainer:1.8.12';
  const { stdout } = await s.agent('registry:push', 'p', name);
  assert.match(stdout, new RegExp(`pushed ${name} as ${image.index.digest}`));
  assert.match(readFileSync(join(s.dir, 'docker.log'), 'utf8'), new RegExp(`^save ${name}$`, 'm'));
  const repo = '/v2/0local/example-project/containers/devcontainer';
  const uploads = srv.requests.filter(r => r.method === 'PUT' && r.url.startsWith(`${repo}/blobs/uploads/`));
  assert.deepEqual(new Set(uploads.map(r => new URL(r.url, 'http://x').searchParams.get('digest'))), new Set(Object.values(image).map(b => b.digest)));
  assert.equal(uploads.find(r => r.url.endsWith(image.layer.digest)).body.toString(), 'layer bytes');
  assert.deepEqual(srv.requests.filter(r => r.method === 'PUT' && r.url.includes('/manifests/')).map(r => [r.url, r.type]), [
    [`${repo}/manifests/${image.manifest.digest}`, 'application/vnd.oci.image.manifest.v1+json'],
    [`${repo}/manifests/1.8.12`, 'application/vnd.oci.image.index.v1+json'],
  ]);
  assert.equal(existsSync(join(s.storage, 'push')) && execFileSync('ls', [join(s.storage, 'push')], { encoding: 'utf8' }), '', 'the saved image is cleaned up');
});

test('registry:push takes only an Artifact Registry name with a tag', async () => {
  const s = setup();
  for (const bad of ['devcontainer:1.8.12', 'docker.io/library/node:24', 'us-central1-docker.pkg.dev/a/b/c', 'us-central1-docker.pkg.dev/a/b/c@sha256:00'])
    await assert.rejects(s.agent('registry:push', 'p', bad), e => /an upstream image with a tag/.test(e.stderr));
  await assert.rejects(s.agent('registry:push', 'p'), e => /usage/.test(e.stderr));
});

// zot's storage holding three images of 300 KB each — repo a pulled at 01:00,
// b at 03:00, c never (cached at 02:00) — and zot's log of the pulls.
function cachedImages(s) {
  const images = join(s.storage, 'images');
  const image = (repo, cachedAt) => {
    const blobs = join(images, repo, 'blobs', 'sha256');
    mkdirSync(blobs, { recursive: true });
    const layer = Buffer.alloc(300_000, repo);
    const layerDigest = `sha256:${createHash('sha256').update(layer).digest('hex')}`;
    writeFileSync(join(blobs, layerDigest.slice(7)), layer);
    const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: 'sha256:00', size: 2 }, layers: [{ digest: layerDigest, size: layer.length }] });
    const digest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
    writeFileSync(join(blobs, digest.slice(7)), manifest);
    utimesSync(join(blobs, digest.slice(7)), cachedAt, cachedAt);
    writeFileSync(join(images, repo, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest, size: manifest.length, annotations: { 'org.opencontainers.image.ref.name': '1.0' } }] }));
    return digest;
  };
  const digests = { a: image('x/a', new Date('2026-10-19T00:00:00Z')), b: image('x/b', new Date('2026-10-19T00:00:00Z')), c: image('x/c', new Date('2026-10-19T02:00:00Z')) };
  const pull = (time, repo, ref) => JSON.stringify({ time, level: 'info', message: 'HTTP API', method: 'GET', path: `/v2/${repo}/manifests/${ref}?ns=us-central1-docker.pkg.dev`, statusCode: 200 });
  writeFileSync(join(s.storage, 'zot.log'), [
    pull('2026-10-19T01:00:00.123Z', 'x/a', '1.0'),
    pull('2026-10-19T00:30:00Z', 'x/b', digests.b),
    JSON.stringify({ time: '2026-10-19T03:00:00Z', message: 'trying to get updated image by syncing on demand' }),
    'not json',
  ].join('\n') + '\n');
  writeFileSync(join(s.storage, 'last-pulls.json'), JSON.stringify({ [`x/b@${digests.b}`]: Date.parse('2026-10-19T03:00:00Z') / 1000 }));
  return digests;
}

test('registry:sweep deletes the least recently pulled images until the cache is under its max-size-gb, and nothing while it is', async t => {
  const srv = await server((req, res) => (req.method === 'DELETE' ? (res.statusCode = 202, res.end(), true) : false));
  t.after(srv.close);
  const s = setup({ registry: reg({ 'max-size-gb': 0.0007, port: srv.port }) });
  const digests = cachedImages(s);
  const swept = JSON.parse((await s.agent('registry:sweep', 'p')).stdout);
  assert.deepEqual(swept.deleted, [`x/a@${digests.a}`]);
  assert.equal(swept['max-bytes'], 700_000);
  assert.ok(swept['size-bytes'] > 900_000);
  assert.deepEqual(srv.requests.filter(r => r.method === 'DELETE').map(r => r.url), [`/v2/x/a/manifests/${digests.a}`]);
  // The log's pulls are kept, by repo@reference, and the log emptied.
  assert.deepEqual(JSON.parse(readFileSync(join(s.storage, 'last-pulls.json'), 'utf8')), {
    'x/a@1.0': Date.parse('2026-10-19T01:00:00Z') / 1000, [`x/b@${digests.b}`]: Date.parse('2026-10-19T03:00:00Z') / 1000,
  });
  assert.equal(readFileSync(join(s.storage, 'zot.log'), 'utf8'), '');

  const roomy = setup({ registry: reg({ port: srv.port }) });
  cachedImages(roomy);
  assert.deepEqual(JSON.parse((await roomy.agent('registry:sweep', 'p')).stdout).deleted, []);
  assert.equal(srv.requests.filter(r => r.method === 'DELETE').length, 1);
});

test('registry:hosts-toml prints the mirror a VM\'s Docker needs: pushed images first, then the cache, both at the project\'s zot', async () => {
  const s = setup();
  assert.equal((await s.agent('registry:hosts-toml', 'p')).stdout, [
    'server = "https://us-central1-docker.pkg.dev"',
    '',
    '[host."http://host.lima.internal:5101/v2/0local"]',
    '  capabilities = ["pull", "resolve", "referrers"]',
    '  override_path = true',
    '',
    '[host."http://host.lima.internal:5101"]',
    '  capabilities = ["pull", "resolve", "referrers"]',
    '',
  ].join('\n'));
});

test('AC2: with no upstream there is nothing to mirror or push to: registry:hosts-toml prints nothing, and registry:push refuses', async () => {
  const s = setup({ registry: reg({ upstream: undefined }) });
  assert.equal((await s.agent('registry:hosts-toml', 'p')).stdout, '');
  await assert.rejects(s.agent('registry:push', 'p', 'us-central1-docker.pkg.dev/a/b/c:1'), e => /p's registry has no upstream/.test(e.stderr));
});

test('AC1: registry:hosts-toml and registry:push use the project\'s own upstream host', async () => {
  const s = setup({ registry: reg({ upstream: { host: 'europe-docker.pkg.dev', credentials: 'gcloud' } }) });
  assert.match((await s.agent('registry:hosts-toml', 'p')).stdout, /^server = "https:\/\/europe-docker\.pkg\.dev"\n/);
  await assert.rejects(s.agent('registry:push', 'p', 'us-central1-docker.pkg.dev/a/b/c:1'), e => /like europe-docker\.pkg\.dev\/<project>/.test(e.stderr));
});

// AC2 against the real zot (the pinned binary registry:up installed on this
// Mac; skipped where there is none) and a stand-in Artifact Registry: one
// image, a manifest over a config and a layer, that answers 401 — as Artifact
// Registry does once the Mac's token has expired — when `refusing`.
const REAL_ZOT = join(homedir(), 'Library', 'Application Support', 'harness', 'zot', 'zot-v2.1.22');
async function upstreamRegistry() {
  const blob = content => ({ content, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` });
  const layer = blob('layer bytes'), config = blob('{"architecture":"arm64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}');
  const manifest = blob(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: config.digest, size: config.content.length },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: layer.digest, size: layer.content.length }] }));
  const up = { requests: [], refusing: false, manifest, blobs: [config, layer] };
  const srv = createServer((req, res) => {
    up.requests.push(`${req.method} ${req.url}`);
    if (up.refusing) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="artifact-registry"' }); return res.end(); }
    const send = (b, type) => { res.writeHead(200, { 'Content-Type': type, 'Content-Length': b.content.length, 'Docker-Content-Digest': b.digest }); res.end(req.method === 'HEAD' ? undefined : b.content); };
    const m = /^\/v2\/example-project\/containers\/app\/(manifests|blobs)\/(.+)$/.exec(req.url);
    if (req.url === '/v2/') return res.end('{}');
    if (m?.[1] === 'manifests' && [manifest.digest, '1.0'].includes(m[2])) return send(manifest, 'application/vnd.oci.image.manifest.v1+json');
    const b = m?.[1] === 'blobs' && up.blobs.find(x => x.digest === m[2]);
    if (b) return send(b, 'application/octet-stream');
    res.statusCode = 404; res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { ...up, srv, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

test('a second pull through the real zot is served from its cache, without asking upstream — and still served once upstream refuses the Mac\'s expired login', { skip: !existsSync(REAL_ZOT) && `no zot at ${REAL_ZOT}` }, async t => {
  const up = await upstreamRegistry();
  t.after(up.close);
  const port = await freePort();
  const s = setup({ registry: reg({ port }) });
  mkdirSync(join(s.dir, 'zot')); execFileSync('ln', ['-s', REAL_ZOT, join(s.dir, 'zot', 'zot-v2.1.22')]);
  const zotPid = () => Number(readFileSync(join(s.dir, 'zot', 'p.pid'), 'utf8'));
  t.after(() => { try { process.kill(zotPid()); } catch { /* gone */ } });
  s.token('ya29.first');
  const registryUp = () => run(AGENT, ['registry:up', 'p'], { env: { ...s.env, ZOT_UPSTREAM_URL: up.url } });
  await registryUp();
  // A Docker pull: the manifest, then each blob it names.
  const pull = async ref => {
    const base = `http://127.0.0.1:${port}/v2/example-project/containers/app`;
    const res = await fetch(`${base}/manifests/${ref}`, { headers: { Accept: 'application/vnd.oci.image.manifest.v1+json' } });
    assert.equal(res.status, 200, `manifest ${ref}`);
    const body = Buffer.from(await res.arrayBuffer());
    for (const b of up.blobs) assert.equal(await (await fetch(`${base}/blobs/${b.digest}`)).text(), b.content, `blob ${b.digest}`);
    return body.toString();
  };

  assert.equal(await pull('1.0'), up.manifest.content);
  assert.ok(up.requests.some(r => r === 'GET /v2/example-project/containers/app/blobs/' + up.blobs[1].digest), 'the first pull fetched the image upstream');
  const asked = up.requests.length;
  assert.equal(await pull('1.0'), up.manifest.content);
  assert.equal(await pull(up.manifest.digest), up.manifest.content);
  assert.deepEqual(up.requests.slice(asked), [], 'a second pull, by tag or digest, never goes upstream');

  // The Mac's token expires; zot restarts (as control's registry:up does), forgetting when it last checked the tag.
  up.refusing = true;
  process.kill(zotPid());
  await registryUp();
  assert.equal(await pull('1.0'), up.manifest.content);
  assert.equal(await pull(up.manifest.digest), up.manifest.content);
  const refused = up.requests.slice(asked);
  assert.ok(refused.some(r => r.endsWith('/manifests/1.0')), `zot asked upstream about the tag, and was refused: ${refused}`);
  assert.ok(refused.every(r => !r.includes('/blobs/')), 'no blob fetched upstream');
});

test('AC2: the real zot starts, and answers, on the config registry:up writes for a project with no upstream', { skip: !existsSync(REAL_ZOT) && `no zot at ${REAL_ZOT}` }, async t => {
  const port = await freePort();
  const s = setup({ registry: reg({ port, upstream: undefined }) });
  mkdirSync(join(s.dir, 'zot')); execFileSync('ln', ['-s', REAL_ZOT, join(s.dir, 'zot', 'zot-v2.1.22')]);
  t.after(() => { try { process.kill(Number(readFileSync(join(s.dir, 'zot', 'p.pid'), 'utf8'))); } catch { /* gone */ } });
  await run(AGENT, ['registry:up', 'p'], { env: s.env });
  assert.equal((await fetch(`http://127.0.0.1:${port}/v2/`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v2/example-project/containers/app/manifests/1.0`)).status, 404, 'nothing to fetch it from');
  assert.deepEqual(s.gcloudCalls(), []);
});
