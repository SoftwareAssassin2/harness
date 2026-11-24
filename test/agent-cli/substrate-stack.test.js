// ASS-542: each ticket's sandbox runs the project's whole app stack. Its declaration (services.yaml's services, hosts,
// ca, app, login, prepare, suites) and validation; the image's sandbox-services bringing the stack up — dependency
// order, health checks, jobs once per sandbox, a failing service or job stopping the start with its log — the host
// map, the CA, the app's URL; sandbox-docker standing in for compose in a suite; and, on a fake remote cluster, two
// tickets' sandboxes each running the whole stack and signed in at once, each seeing only its own database, through
// hibernation and resume, their logs and times in the ticket's folder. The stacks here are toy ones (a node "db" and
// "app", jobs that write files): every name is generic, nothing is a real project's. HARNESS_VM_ROOT stands in for a
// sandbox's / (as fake-command-server.js runs commands), so /etc/hosts and the rest are files of the test's own.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseServices, validateServices, normalizeServices } from '../../src/substrate/services.js';
import { renderDockerfile } from '../../src/substrate/dockerfile.js';
import { wsFixture, closeAll, edit, ID } from './workstation-fixture.js';
import { fakeSubstrateMachine, putKit } from '../support/fake-substrate.js';

after(closeAll);
const run = promisify(execFile);
const IMAGE_BIN = join(import.meta.dirname, '..', '..', 'src', 'substrate', 'image');
const SERVICES = join(IMAGE_BIN, 'sandbox-services');
const D = c => `sha256:${c.repeat(64)}`;
const last = out => { try { return JSON.parse(String(out ?? '').trim().split('\n').pop()); } catch { return null; } };

// A free TCP port of the loopback.
const onePort = port => new Promise(resolve => { const s = createServer(); s.once('error', () => resolve(null)); s.listen(port, '127.0.0.1', () => { const got = s.address().port; s.close(() => resolve(got)); }); });
// freePort() — a free port whose next is free too: the toy db takes it, the toy app the next (other test files run at
// once). Outside the system's ephemeral range (49152+ on macOS), which other tests' listen(0) and connections draw on
// at any moment: one that took the app's port between this check and the app's start answered its check (ASS-542).
async function freePort() {
  for (;;) {
    const port = await onePort(44000 + 2 * Math.floor(Math.random() * 2500));   // 44000–48999: no other test file's range
    if (port && port < 65535 && await onePort(port + 1)) return port;
  }
}

// The toy stack's programs: `node toy.js db` — a database: rows in $HARNESS_VM_ROOT/var/lib/toy/rows.json, which
// the migration jobs make (GET /health, GET /rows, POST /rows); `node toy.js app` — the app: POST /login with the
// seeded user's password sets a session cookie (kept in the process, as a real session store keeps it), GET / says
// who is signed in and the database's rows. Each listens on the port in $HARNESS_VM_ROOT/etc/toy-port (the db) and
// the next (the app): a sandbox's own network, which two sandboxes on one test machine cannot share.
const TOY = `
const { createServer, request } = require('node:http');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const R = process.env.HARNESS_VM_ROOT ?? '';
const base = Number(readFileSync(R + '/etc/toy-port', 'utf8'));
const rows = R + '/var/lib/toy/rows.json';
const body = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => r(b)); });
if (process.argv[2] === 'db') {
  createServer(async (req, res) => {
    if (req.url === '/health') return res.end('ok');
    if (!existsSync(rows)) { res.writeHead(503); return res.end('no schema'); }
    if (req.method === 'POST') { const all = JSON.parse(readFileSync(rows, 'utf8')); all.push(await body(req)); writeFileSync(rows, JSON.stringify(all)); return res.end('ok'); }
    res.end(readFileSync(rows, 'utf8'));
  }).listen(base, '127.0.0.1');
} else {
  const sessions = new Set();
  createServer(async (req, res) => {
    const sid = /sid=([a-z0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (req.method === 'POST' && req.url === '/login') {
      const b = new URLSearchParams(await body(req));
      if (b.get('username') !== 'dev@example.local' || b.get('password') !== 'devpw') { res.writeHead(401); return res.end('no'); }
      const id = Math.random().toString(36).slice(2); sessions.add(id);
      res.writeHead(200, { 'set-cookie': 'sid=' + id }); return res.end('signed in');
    }
    if (!sessions.has(sid)) { res.writeHead(302, { location: '/login' }); return res.end(); }
    request({ host: '127.0.0.1', port: base, path: '/rows' }, r => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => res.end('signed in as dev; rows ' + d)); }).end();
  }).listen(base + 1, '127.0.0.1');
}
`;

// A toy login (sandbox-login's stand-in: no browser in a test): curl signs in at the app and keeps the cookie, or
// with --check loads the app with the kept cookie alone.
const TOY_LOGIN = `#!/bin/bash
R="\${HARNESS_VM_ROOT-}"; port=$(( $(cat "$R/etc/toy-port") + 1 )); state="$R/var/lib/sandbox/login/dev.cookies"
if [[ "\${1-}" == --check ]]; then
  page="$(curl -s -b "$state" "http://127.0.0.1:$port/")"
  [[ "$page" == "signed in as dev"* ]] && jq -nc --arg p "$page" '{ ok: true, check: true, page: $p }' || { jq -nc --arg p "$page" '{ ok: false, check: true, why: ("not signed in: " + $p) }'; exit 1; }
else
  mkdir -p "$(dirname "$state")"
  curl -fs -c "$state" -d "username=$(jq -r .login.username "$SANDBOX_SERVICES")&password=$(jq -r .login.password "$SANDBOX_SERVICES")" "http://127.0.0.1:$port/login" >/dev/null \\
    && jq -nc '{ ok: true, check: false }' || { jq -nc '{ ok: false, why: "the sign-in was refused" }'; exit 1; }
fi
`;

// declaration({ failing, extra }) — the toy stack, as services.yaml has it: db (ready: its health), migrate-1 and
// migrate-2 (jobs, in that order, each appending to migrations.log; migrate-2 fails when `failing`), seed (a job
// adding a row), app (ready: its port answers), the hosts and the login.
function declaration({ failing = false, loginPath = '' } = {}) {
  const job = (name, after, run) => ({ name, kind: 'job', version: '1', start: run, after });
  return {
    architectures: ['amd64'],
    services: [
      { name: 'app', version: '1', aliases: ['example-web'], start: 'exec node "$HARNESS_VM_ROOT/opt/toy/toy.js" app', ready: 'curl -s -o /dev/null "http://127.0.0.1:$(( $(cat "$HARNESS_VM_ROOT/etc/toy-port") + 1 ))/"', after: ['seed'], env: { TOY_ROLE: 'app' } },
      job('seed', ['migrate-2'], 'curl -fs -d "seeded:$(basename "$(dirname "$HARNESS_VM_ROOT")")" "http://127.0.0.1:$(cat "$HARNESS_VM_ROOT/etc/toy-port")/rows" >/dev/null'),
      job('migrate-2', ['migrate-1'], failing ? 'echo "migrate-2: relation missing" >&2; exit 1' : 'echo v2 >> "$HARNESS_VM_ROOT/var/lib/toy/migrations.log"'),
      job('migrate-1', ['db'], 'mkdir -p "$HARNESS_VM_ROOT/var/lib/toy" && echo v1 >> "$HARNESS_VM_ROOT/var/lib/toy/migrations.log" && { [ -f "$HARNESS_VM_ROOT/var/lib/toy/rows.json" ] || echo "[]" > "$HARNESS_VM_ROOT/var/lib/toy/rows.json"; }'),
      { name: 'db', version: '1', aliases: ['database'], start: 'exec node "$HARNESS_VM_ROOT/opt/toy/toy.js" db', ready: 'curl -fs "http://127.0.0.1:$(cat "$HARNESS_VM_ROOT/etc/toy-port")/health"', env: { DB_NAME: 'toy' } },
    ],
    hosts: ['app.example.internal', 'accounts.example.internal'],
    login: { url: 'https://app.example.internal/', username: 'dev@example.local', password: 'devpw', ...(loginPath ? { env: { PATH: loginPath } } : {}) },
  };
}

// sandboxRoot(decl, port) — a folder standing in for a sandbox's /: the normalized declaration at
// etc/sandbox/services.json, the toy programs, its own port, an /etc/hosts with a line of its own.
function sandboxRoot(decl, port, into = mkdtempSync(join(tmpdir(), 'sandbox-'))) {
  mkdirSync(join(into, 'etc', 'sandbox'), { recursive: true });
  mkdirSync(join(into, 'opt', 'toy'), { recursive: true });
  writeFileSync(join(into, 'etc', 'sandbox', 'services.json'), JSON.stringify(normalizeServices(decl)));
  writeFileSync(join(into, 'opt', 'toy', 'toy.js'), TOY);
  writeFileSync(join(into, 'etc', 'toy-port'), String(port));
  writeFileSync(join(into, 'etc', 'hosts'), '127.0.0.1 localhost\n');
  return into;
}

// services(root, ...args) — sandbox-services run with root as the sandbox's /.
const services = (root, args, env = {}) => run(SERVICES, args, { env: { ...process.env, PATH: `${IMAGE_BIN}:${process.env.PATH}`, HARNESS_VM_ROOT: root, ...env } })
  .then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));
const stopAll = root => services(root, ['stop']);

test('AC1, AC8: the stack\'s declaration — hosts, aliases, CA, app, login, prepare and suites — is validated, naming each bad entry, a dependency cycle, two services on one port and a host name mapped twice', () => {
  const ok = declaration();
  assert.deepEqual(validateServices(ok), []);
  const n = normalizeServices(ok);
  // Start order: what each names in `after` first; the host map: every service's name and aliases, then hosts.
  assert.deepEqual(n.services.map(s => s.name), ['db', 'migrate-1', 'migrate-2', 'seed', 'app']);
  assert.deepEqual(n.hosts, ['app', 'example-web', 'seed', 'migrate-2', 'migrate-1', 'db', 'database', 'app.example.internal', 'accounts.example.internal']);
  assert.deepEqual(n.login, { url: 'https://app.example.internal/', username: 'dev@example.local', password: 'devpw', 'click-first': null, 'username-field': '#username', 'password-field': '#password', submit: '#kc-login', 'signed-in': 'https://app.example.internal', env: {} });
  assert.deepEqual([n.ca, n.app, n.prepare, n.suites], [null, null, [], []]);
  const bad = (change, pattern) => {
    const d = structuredClone(ok); change(d);
    const problems = validateServices(d);
    assert.ok(problems.some(p => pattern.test(p)), `${pattern} in ${JSON.stringify(problems)}`);
  };
  bad(d => { d.services[4].after = ['app']; }, /^services: after makes a cycle: (db → app → seed → migrate-2 → migrate-1 → db|.* → .*)$/);
  bad(d => { d.services[0].ports = [8080]; d.services[4].ports = [8080]; }, /^services\[4\] \(db\): port 8080 is services\[0\] \(app\)'s too: one port, one service$/);
  bad(d => { d.hosts.push('database'); }, /^hosts\[2\]: host database is services\[4\] \(db\)'s too: one name, one entry$/);
  bad(d => { d.hosts.push('Bad_Host'); }, /^hosts\[2\] must be a host name: "Bad_Host"$/);
  bad(d => { d.services[0].aliases = ['ok', 'no spaces']; }, /^services\[0\] \(app\): aliases must list host names$/);
  bad(d => { d.services[0].start = undefined; }, /^services\[0\] \(app\): start must say how it starts/);
  bad(d => { d.services[1]['ready-seconds'] = 30; }, /^services\[1\] \(seed\): ready-seconds must be a number of seconds, and only a service has one$/);
  bad(d => { d.services[0].image = 'example/app:1'; }, /^services\[0\] \(app\): digest must be sha256/);
  bad(d => { delete d.login.password; }, /^login: password must be the seeded user's$/);
  bad(d => { d.login.url = 'app.example.internal'; }, /^login: url must be an http\(s\) URL/);
  bad(d => { d.login.cookie = 'x'; }, /^login has an unknown key "cookie"/);
  bad(d => { d.ca = { cert: 'root.crt', after: 'nothing' }; }, /^ca: cert must be an absolute file path: "root.crt"$/);
  bad(d => { d.ca = { cert: '/x/root.crt', after: 'nothing' }; }, /^ca: after names no service: nothing$/);
  bad(d => { d.app = { url: 'https://app.example.internal/', after: ['web'] }; }, /^app: after names no service: web$/);
  bad(d => { d.suites = [{ name: 'e2e', run: 'make e2e', after: ['nope'] }, { name: 'e2e', run: 'x' }]; }, /^suites\[0\] \(e2e\): after names no service: nope$/);
  bad(d => { d.suites = [{ name: 'e2e', run: 'make e2e' }, { name: 'e2e', run: 'x' }]; }, /^suites\[1\] \(e2e\): name e2e is suites\[0\]'s too$/);
  bad(d => { d.suites = [{ name: 'e2e', run: 'make', docker: 'yes' }]; }, /^suites\[0\] \(e2e\): docker must be true or false$/);
  bad(d => { d.prepare = [{ name: 'deps', run: 'pnpm install', npm: 'yes' }]; }, /^prepare\[0\] \(deps\): npm must be true or false$/);
  bad(d => { d.prepare = [{ name: 'deps' }]; }, /^prepare\[0\] \(deps\): run must be a shell command$/);
  // Parsed from YAML, a bad entry is named by its index and name.
  assert.match(validateServices(parseServices('architectures: [amd64]\nservices:\n  - { name: web, version: "1", start: x, after: [db] }\n')).join('\n'), /services\[0\] \(web\): after names no service: db/);
  // prepare steps run last in the image, as agent; one with npm: true gets the npm secret for that RUN alone.
  const dockerfile = renderDockerfile({ project: 'p', arch: 'amd64', declaration: normalizeServices({ ...ok, ca: { cert: '/var/lib/ca/root.crt' }, prepare: [{ name: 'deps', workdir: '/repos/web', run: 'pnpm install', npm: true }, { name: 'warm', run: 'true' }] }) });
  assert.match(dockerfile, /\nUSER agent\n# prepare deps \(ASS-542\)\nRUN --mount=type=secret,id=npm,required=true,uid=1000 cd '\/repos\/web' && NPM_CONFIG_USERCONFIG=\/run\/secrets\/npm bash -c 'pnpm install'\n# prepare warm \(ASS-542\)\nRUN cd '\/' && bash -c 'true'\nUSER root\nCOPY \["harness\/services.json"/);
  assert.match(dockerfile, /CMD \["\/usr\/local\/bin\/harness-command-server"\]\n$/);
  assert.match(dockerfile, / libnss3-tools /);
  assert.doesNotMatch(dockerfile, /FROM .* AS svc-(app|db)/, 'a service of what the image has already copies nothing');
});

test('AC2, AC3, AC8: sandbox-services up — the host map, every service in dependency order each waiting for its health check, jobs once per sandbox in their order; a failing job stops the start, naming it, its log kept, nothing after it started; fixed, the next start runs only what has not run', async () => {
  const root = sandboxRoot(declaration({ failing: true }), await freePort());
  try {
    const failed = await services(root, ['up']);
    assert.equal(failed.code, 3, failed.err);
    const stack = last(failed.out);
    assert.equal(stack.state, 'failed');
    assert.deepEqual(stack.failed, { name: 'migrate-2', kind: 'job', why: 'the job failed (exit 1)', log: '/var/log/sandbox/migrate-2.log' });
    assert.match(readFileSync(join(root, 'var', 'log', 'sandbox', 'migrate-2.log'), 'utf8'), /relation missing/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'var', 'lib', 'sandbox', 'stack', 'stack.json'), 'utf8')).failed.name, 'migrate-2');
    // What came before ran (db up and ready, migrate-1 done); nothing after the failure started.
    assert.equal(readFileSync(join(root, 'var', 'lib', 'toy', 'migrations.log'), 'utf8'), 'v1\n');
    assert.ok(existsSync(join(root, 'var', 'lib', 'sandbox', 'stack', 'jobs', 'migrate-1.done')));
    assert.ok(!existsSync(join(root, 'var', 'lib', 'sandbox', 'stack', 'jobs', 'migrate-2.done')));
    assert.ok(!existsSync(join(root, 'var', 'log', 'sandbox', 'seed.log')));
    assert.ok(!existsSync(join(root, 'run', 'sandbox', 'app.pid')));
    assert.equal(stack.services.db.ran, true);
    // The host map: every service's name and aliases and the declared hosts → 127.0.0.1, the file's own lines kept.
    const hosts = readFileSync(join(root, 'etc', 'hosts'), 'utf8');
    assert.match(hosts, /^127\.0\.0\.1 localhost\n# sandbox-services hosts \(ASS-542\)\n127\.0\.0\.1 app\n127\.0\.0\.1 example-web\n/);
    for (const h of ['database', 'app.example.internal', 'accounts.example.internal']) assert.match(hosts, new RegExp(`^127\\.0\\.0\\.1 ${h.replace(/\./g, '\\.')}$`, 'm'));
    // Fixed: the next start skips the job done, runs the rest in order, and the stack is up.
    writeFileSync(join(root, 'etc', 'sandbox', 'services.json'), JSON.stringify(normalizeServices(declaration())));
    const up = await services(root, ['up']);
    assert.equal(up.code, 0, up.err);
    const ok = last(up.out);
    assert.equal(ok.state, 'up');
    assert.equal(ok.failed, null);
    assert.equal(ok.services['migrate-1'].skipped, true);
    assert.equal(ok.services['migrate-2'].ran, true);
    assert.equal(ok.services.db.skipped, true, 'a service running already is not started again');
    assert.equal(readFileSync(join(root, 'var', 'lib', 'toy', 'migrations.log'), 'utf8'), 'v1\nv2\n');
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'var', 'lib', 'toy', 'rows.json'), 'utf8')), [`seeded:${root.split('/').at(-2)}`]);
    // Once per sandbox: a third start (a resume, a restarted control) runs no job and starts nothing.
    const again = last((await services(root, ['up'])).out);
    assert.deepEqual(Object.values(again.services).map(s => Object.keys(s).includes('skipped')), [true, true, true, true, true], JSON.stringify(again.services));
    assert.equal(readFileSync(join(root, 'var', 'lib', 'toy', 'migrations.log'), 'utf8'), 'v1\nv2\n');
    // The host map is replaced, never stacked.
    assert.equal(readFileSync(join(root, 'etc', 'hosts'), 'utf8').match(/sandbox-services hosts \(ASS-542\)/g).length, 1);
    const status = (await services(root, ['status'])).out.trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(status.map(s => [s.name, s.running, s.done]), [['db', true, false], ['migrate-1', false, true], ['migrate-2', false, true], ['seed', false, true], ['app', true, false]]);
  } finally { await stopAll(root); }
});

test('AC2: a service that exits before it is ready, or is never ready, stops the start, naming it and its log', async () => {
  const d = declaration();
  d.services[4].start = 'echo "db: cannot open its data folder" >&2; exit 2';
  const root = sandboxRoot(d, await freePort());
  try {
    const r = await services(root, ['up']);
    assert.equal(r.code, 3);
    assert.deepEqual(last(r.out).failed, { name: 'db', kind: 'service', why: 'it exited before it was ready', log: '/var/log/sandbox/db.log' });
    assert.match(readFileSync(join(root, 'var', 'log', 'sandbox', 'db.log'), 'utf8'), /cannot open its data folder/);
    assert.ok(!existsSync(join(root, 'var', 'log', 'sandbox', 'migrate-1.log')), 'nothing after it ran');
    const slow = declaration();
    Object.assign(slow.services[4], { start: 'exec sleep 30', 'ready-seconds': 2 });
    writeFileSync(join(root, 'etc', 'sandbox', 'services.json'), JSON.stringify(normalizeServices(slow)));
    const r2 = await services(root, ['up']);
    assert.equal(r2.code, 3);
    assert.equal(last(r2.out).failed.why, 'not ready after 2s');
  } finally { await stopAll(root); }
});

test('AC3: the CA is trusted (system store, NODE_EXTRA_CA_CERTS) once its service has written it, and the app must answer at its URL', async () => {
  const d = declaration();
  const port = await freePort();
  d.services[0].start = `mkdir -p "$HARNESS_VM_ROOT/var/lib/proxy" && echo "-----BEGIN CERTIFICATE----- toy" > "$HARNESS_VM_ROOT/var/lib/proxy/root.crt" && exec node "$HARNESS_VM_ROOT/opt/toy/toy.js" app`;
  d.ca = { cert: '/var/lib/proxy/root.crt', after: 'app' };
  d.app = { url: `http://127.0.0.1:${port + 1}/`, after: ['app'], 'ready-seconds': 10 };
  const root = sandboxRoot(d, port);
  try {
    const r = await services(root, ['up']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(last(r.out).app, { url: `http://127.0.0.1:${port + 1}/`, status: 302 });
    assert.equal(readFileSync(join(root, 'usr', 'local', 'share', 'ca-certificates', 'sandbox-local-ca.crt'), 'utf8'), '-----BEGIN CERTIFICATE----- toy\n');
    assert.equal(readFileSync(join(root, 'etc', 'profile.d', 'sandbox-ca.sh'), 'utf8'), 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/sandbox-local-ca.crt\n');
    assert.ok(!existsSync(join(root, 'etc', 'ssl', 'sandbox-node-extra-ca.pem')), 'no gateway bundle: no combined file (ASS-588)');
    // An app that never answers fails the start, naming its URL.
    await stopAll(root);
    d.app = { url: 'http://127.0.0.1:9/', after: ['app'], 'ready-seconds': 2 };
    writeFileSync(join(root, 'etc', 'sandbox', 'services.json'), JSON.stringify(normalizeServices(d)));
    const r2 = await services(root, ['up']);
    assert.equal(r2.code, 3);
    assert.match(last(r2.out).failed.why, /^http:\/\/127\.0\.0\.1:9\/ did not answer within 2s/);
  } finally { await stopAll(root); }
});

test('ASS-588 AC1, AC2: with the egress gateway\'s bundle readable, NODE_EXTRA_CA_CERTS names one file holding the gateway bundle then the local CA, rewritten each start; the bundle gone, back to the local CA alone', async () => {
  const d = declaration();
  const port = await freePort();
  d.services[0].start = `mkdir -p "$HARNESS_VM_ROOT/var/lib/proxy" && echo "-----BEGIN CERTIFICATE----- toy" > "$HARNESS_VM_ROOT/var/lib/proxy/root.crt" && exec node "$HARNESS_VM_ROOT/opt/toy/toy.js" app`;
  d.ca = { cert: '/var/lib/proxy/root.crt', after: 'app' };
  const root = sandboxRoot(d, port);
  const bundle = join(root, 'run', 'ate', 'egress-trust-bundle', 'trust-bundle.pem');
  const combined = join(root, 'etc', 'ssl', 'sandbox-node-extra-ca.pem');
  const profile = join(root, 'etc', 'profile.d', 'sandbox-ca.sh');
  mkdirSync(dirname(bundle), { recursive: true });
  writeFileSync(bundle, '-----BEGIN CERTIFICATE----- gateway');   // no trailing newline: the two must not run together
  try {
    const r = await services(root, ['up']);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(profile, 'utf8'), 'export NODE_EXTRA_CA_CERTS=/etc/ssl/sandbox-node-extra-ca.pem\n');
    const both = readFileSync(combined, 'utf8');
    assert.match(both, /^-----BEGIN CERTIFICATE----- gateway\n+-----BEGIN CERTIFICATE----- toy\n$/, both);
    assert.equal(statSync(combined).mode & 0o777, 0o644);
    assert.equal(readFileSync(join(root, 'usr', 'local', 'share', 'ca-certificates', 'sandbox-local-ca.crt'), 'utf8'), '-----BEGIN CERTIFICATE----- toy\n');
    // A second start rewrites it, never appends.
    await stopAll(root);
    assert.equal((await services(root, ['up'])).code, 0);
    assert.equal(readFileSync(combined, 'utf8'), both);
    assert.equal(readFileSync(combined, 'utf8').match(/----- toy/g).length, 1);
    // The bundle gone: the local CA alone, the stale combined file removed.
    await stopAll(root);
    rmSync(bundle);
    const r3 = await services(root, ['up']);
    assert.equal(r3.code, 0, r3.err);
    assert.equal(readFileSync(profile, 'utf8'), 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/sandbox-local-ca.crt\n');
    assert.ok(!existsSync(combined), 'the stale combined file is removed');
  } finally { await stopAll(root); }
});

test('AC9: a suite runs against the sandbox\'s own stack, `docker compose` standing in — up, exec with the service\'s env, ps, logs, down a no-op — and its exit code and log are its own; Docker itself is refused', async () => {
  const d = declaration();
  const port = await freePort();
  d.suites = [
    { name: 'api-e2e', workdir: '/', run: 'docker compose -f compose.yml -p e2e up -d --wait database && docker compose exec -T database sh -c \'echo "db=$DB_NAME token=$TOKEN"\' && docker compose ps -q db | grep -q . && docker compose logs db | grep -q "db |" ; docker compose down -v && curl -fs "http://127.0.0.1:$(cat "$HARNESS_VM_ROOT/etc/toy-port")/rows"', env: { TOKEN: 't1' }, after: ['db', 'migrate-1'], docker: true },
    { name: 'no-docker', run: 'docker run --rm example/image:1 true', docker: true },
    { name: 'failing', run: 'echo two failed; exit 4' },
  ];
  d.services[4].start = 'echo "db started" && exec node "$HARNESS_VM_ROOT/opt/toy/toy.js" db';
  const root = sandboxRoot(d, port);
  try {
    const r = await services(root, ['suite', 'api-e2e'], { SANDBOX_DOCKER_SERVICES: 'database=db' });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /^db=toy token=t1$/m);
    assert.match(r.out, /^\[\]$/m);
    assert.match(r.out, /compose down: nothing to do/);
    assert.match(readFileSync(join(root, 'var', 'log', 'sandbox', 'suite-api-e2e.log'), 'utf8'), /db=toy token=t1/);
    assert.equal(JSON.parse(readFileSync(join(root, 'var', 'lib', 'sandbox', 'stack', 'suites', 'api-e2e.json'), 'utf8'))['exit-code'], 0);
    const no = await services(root, ['suite', 'no-docker']);
    assert.equal(no.code, 1);
    assert.match(no.out, /no Docker in a sandbox: `docker run` cannot run here/);
    const failing = await services(root, ['suite', 'failing']);
    assert.equal(failing.code, 4);
    assert.equal(JSON.parse(readFileSync(join(root, 'var', 'lib', 'sandbox', 'stack', 'suites', 'failing.json'), 'utf8'))['exit-code'], 4);
    assert.equal((await services(root, ['suite', 'nope'])).code, 1);
  } finally { await stopAll(root); }
});

// stacked() — project p with a Substrate cluster on its workstation (a fake remote machine, connected), its sandbox
// image delivered: the image's / holds the toy stack (services.json, the toy programs) and the image's own scripts
// are on the sandboxes' PATH; the project's sandbox/services.yaml declares the same stack; ABC-3 and ABC-4 in the sprint.
async function stacked() {
  const s = wsFixture();
  const digest = D('e');
  edit(s.at('projects', 'p', 'project.json'), p => {
    p['dev-environments'].substrate = { clusters: [{ machine: ID }] };
    p.registry = { 'storage-path': 'projects/p/registry', 'max-size-gb': 20, port: 9 };
    p['golden-image'] = { folder: 'projects/p/golden-image' };
  });
  mkdirSync(s.at('projects', 'p', 'golden-image'), { recursive: true });
  writeFileSync(s.at('projects', 'p', 'golden-image', 'template.yaml'), 'vmType: vz\n');
  writeFileSync(s.at('projects', 'p', 'golden-image', 'provision.sh'), '#!/bin/bash\n');
  writeFileSync(s.at('projects', 'p', 'sandbox-image-amd64.json'), JSON.stringify({ project: 'p', arch: 'amd64', digest, repository: '0local/sandbox/p', tag: 'amd64-eeeeeeeeeeee' }));
  writeFileSync(s.at('projects', 'p', 'sandbox-deliveries.json'), JSON.stringify({ [ID]: { arch: 'amd64', digest, ref: `sandbox/p@${digest}` } }));
  edit(s.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sprint => {
    sprint.features.push({ ...structuredClone(sprint.features[0]), key: 'ABC-4', variations: sprint.features[0].variations.filter(v => v.name === 'A').map(v => ({ ...structuredClone(v), sandbox: undefined })) });
  });
  // The toy login on the sandboxes' PATH ahead of the image's (no browser in a test).
  const bin = mkdtempSync(join(tmpdir(), 'login-bin-'));
  writeFileSync(join(bin, 'sandbox-login'), TOY_LOGIN, { mode: 0o755 });
  const decl = declaration({ loginPath: `${bin}:${IMAGE_BIN}:${process.env.PATH}` });
  const image = sandboxRoot(decl, 0, mkdtempSync(join(tmpdir(), 'image-')));
  mkdirSync(s.at('projects', 'p', 'sandbox'), { recursive: true });
  writeFileSync(s.at('projects', 'p', 'sandbox', 'services.yaml'), JSON.stringify(decl));   // JSON is YAML
  const m = fakeSubstrateMachine(dirname(s.w.system(ID)), { persist: s.w.home(ID) });
  putKit(join(s.env.HOME, '.harness', 'substrate'));
  const base = 21000 + Math.floor(Math.random() * 400) * 50;
  Object.assign(s.env, m.env, {
    PATH: `${IMAGE_BIN}:${s.env.PATH}`,
    HARNESS_SUBSTRATE_GRACE: '0', FAKE_SUBSTRATE_LOG: join(m.dir, 'substrate.log'),
    FAKE_COMMAND_SERVER: join(import.meta.dirname, '..', 'support', 'fake-command-server.js'), FAKE_SANDBOX_IMAGE: image,
    HARNESS_SANDBOX_PORTS: `${base}-${base + 49}`, HARNESS_SUBSTRATE_TEMPLATE_WAIT: '4', HARNESS_SUBSTRATE_RESUME_WAIT: '10', HARNESS_SANDBOX_REACH_MS: '3000',
  });
  assert.equal((await s.result('workstation:connect', 'p', ID)).code, 0);
  const up = await s.result('substrate:up', 'p', ID);
  assert.equal(up.code, 0, up.err);
  const call = (...args) => s.result(...args).then(r => ({ ...r, json: last(r.out) }));
  const root = actor => join(m.k8s(), 'sandboxes', 'harness-p', actor, 'root');
  return { s, m, call, root };
}

test('AC5, AC6, AC2, AC8: two tickets on one machine each run the whole stack in their own sandbox and sign in at once, each seeing only its own database; hibernated and resumed, the app answers and the session holds; logs and the times to first start and to resume in each ticket\'s folder', async () => {
  const t = await stacked();
  const roots = [];
  try {
    // Both sandboxes made, each given its own network's port (the toy stack's stand-in for a sandbox's own network).
    for (const key of ['ABC-3', 'ABC-4']) {
      const up = await t.call('substrate:sandbox-up', 'p', key, 'A', ID);
      assert.equal(up.code, 0, up.err);
      assert.equal(up.json.created, true);
      assert.equal(typeof up.json.seconds, 'number');
      const root = t.root(`${key.toLowerCase()}-a`);
      writeFileSync(join(root, 'etc', 'toy-port'), String(await freePort()));
      roots.push(root);
    }
    // The whole stack, in both at once.
    const [one, two] = await Promise.all(['ABC-3', 'ABC-4'].map(key => t.call('substrate:stack-up', 'p', key, 'A', '--after', 'created', '12')));
    for (const [r, key] of [[one, 'ABC-3'], [two, 'ABC-4']]) {
      assert.equal(r.code, 0, r.err);
      assert.equal(r.json.state, 'up');
      assert.equal(r.json.stack, true);
      assert.equal(r.json.login.ok, true);
      const folder = t.s.at('projects', 'p', 'work', key, 'sandbox-stack-A');
      assert.equal(r.json.folder, folder);
      assert.deepEqual(readdirSync(join(folder, 'logs')).sort(), ['app.log', 'db.log', 'migrate-1.log', 'migrate-2.log', 'seed.log']);
      assert.equal(JSON.parse(readFileSync(join(folder, 'stack.json'), 'utf8')).state, 'up');
      const times = JSON.parse(readFileSync(t.s.at('projects', 'p', 'work', key, 'sandbox-times-A.json'), 'utf8'));
      assert.equal(times['first-start'].after, 'created');
      assert.equal(times['first-start']['sandbox-seconds'], 12);
      assert.ok(times['first-start']['total-seconds'] >= 12);
      assert.equal(times['first-start'].sandbox, `${key.toLowerCase()}-a`);
    }
    // Each its own database: a row written in ABC-3's is in ABC-3's alone; each was seeded in its own.
    const page = async root => (await run('curl', ['-s', '-b', join(root, 'var', 'lib', 'sandbox', 'login', 'dev.cookies'), `http://127.0.0.1:${Number(readFileSync(join(root, 'etc', 'toy-port'), 'utf8')) + 1}/`])).stdout;
    await run('curl', ['-fs', '-d', 'only-abc-3', `http://127.0.0.1:${readFileSync(join(roots[0], 'etc', 'toy-port'), 'utf8')}/rows`]);
    assert.match(await page(roots[0]), /^signed in as dev; rows \["seeded:abc-3-a","only-abc-3"\]$/);
    assert.match(await page(roots[1]), /^signed in as dev; rows \["seeded:abc-4-a"\]$/);
    assert.notEqual(readFileSync(join(roots[0], 'etc', 'hosts'), 'utf8').length, 0);
    // Hibernated (suspended: its processes kept) and resumed: the stack is checked, nothing rerun, the session holds.
    assert.equal((await t.call('substrate:sandbox-stop', 'p', 'ABC-3', 'A')).code, 0);
    const resumed = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', ID);
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(resumed.json.resumed, true);
    const after = await t.call('substrate:stack-up', 'p', 'ABC-3', 'A', '--after', 'resumed', String(resumed.json.seconds));
    assert.equal(after.code, 0, after.err);
    assert.equal(after.json['session-kept'], true);
    assert.equal(after.json.login.check, true);
    const kept = JSON.parse(readFileSync(join(after.json.folder, 'stack.json'), 'utf8'));
    assert.ok(Object.values(kept.services).every(s => s.skipped), 'nothing started or run again after a resume');
    assert.match(await page(roots[0]), /only-abc-3/);
    const times = JSON.parse(readFileSync(t.s.at('projects', 'p', 'work', 'ABC-3', 'sandbox-times-A.json'), 'utf8'));
    assert.deepEqual([times.runs, times['last-resume'].after, times['last-resume']['session-kept'], times['first-start'].after], [2, 'resumed', true, 'created']);
    // A failing job in one ticket's sandbox stops its start (exit 3, the job and its log named) and leaves the other alone.
    writeFileSync(join(roots[1], 'etc', 'sandbox', 'services.json'), JSON.stringify(normalizeServices({ ...declaration(), services: [...declaration().services, { name: 'broken', kind: 'job', version: '1', start: 'echo "broken: no table" >&2; exit 1', after: ['db'] }] })));
    const broken = await t.call('substrate:stack-up', 'p', 'ABC-4', 'A');
    assert.equal(broken.code, 3);
    assert.match(broken.err, /substrate:stack-up: ABC-4 A's app stack in its sandbox abc-4-a on ada-dev failed: job broken: the job failed \(exit 1\) — its log: .*work\/ABC-4\/sandbox-stack-A\/logs\/broken\.log/);
    assert.match(readFileSync(t.s.at('projects', 'p', 'work', 'ABC-4', 'sandbox-stack-A', 'logs', 'broken.log'), 'utf8'), /no table/);
    assert.match(await page(roots[0]), /^signed in as dev/);
  } finally {
    for (const root of roots) await stopAll(root);
  }
});

test('AC2: a project with no stack declared — stack-up does nothing', async () => {
  const s = wsFixture();
  const r = await s.result('substrate:stack-up', 'p', 'ABC-3', 'A');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(last(r.out), { stack: false });
});
