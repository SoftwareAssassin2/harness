// ASS-538 AC1–AC5: sandboxes get their credentials through Substrate's egress gateway. On a fake Mac cluster
// (fake-substrate.js: Secrets, the credential provider's namespace policy, each actor's egress policy) with a fake
// keychain (`security`: an item's value and modification time from files), substrate:credentials turns the declared
// keychain items into Secrets, sandbox-up gives the sandbox its egress policy and placeholders only, and a stand-in
// for the gateway (fake-gateway.js, following Substrate's documented behaviour) shows what an upstream would get:
// the token injected (AC1, AC5), a host off the allowlist refused and the gateway's refusal logged (AC3, AC5), a
// re-saved key reaching the next request with no sandbox restart, through control's own check (AC2, AC5). And
// project:credentials-status reports the provider, its namespace policy and each Secret (AC4). Dummy tokens only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wsFixture, closeAll, edit, git } from './workstation-fixture.js';
import { fakeSubstrateMachine, putKit } from '../support/fake-substrate.js';
import { fakeGateway } from '../support/fake-gateway.js';
import { keepCredentials } from '../../src/control/substrate-credentials.js';
import { CREDENTIAL_STAMP_INTERVAL } from '../../src/control/vm-lifecycle.js';
import { PLACEHOLDERS } from '../../src/substrate/egress.js';

after(closeAll);
const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const MACHINE_BASH = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'machine.bash');
const last = out => { try { return JSON.parse(String(out ?? '').trim().split('\n').pop()); } catch { return null; } };
const DIGEST = `sha256:${'d'.repeat(64)}`;
// Dummy tokens: never a real one (the brief's rule), shaped as the real ones are.
const CLAUDE = 'sk-ant-oat01-DUMMY-claude-not-a-real-token-1';
const GITLAB = 'glpat-DUMMY-gitlab-not-a-real-token-1';
const b64 = s => Buffer.from(s).toString('base64');
let base = 22000 + Math.floor(Math.random() * 400) * 50;

// A fake keychain: <kc>/<service> holds the token, <service>.mdat its modification time.
const SECURITY = kc => `#!/bin/bash
[[ "$1 $2" == "find-generic-password -s" ]] || { echo "unexpected security call: $*" >&2; exit 2; }
f="${kc}/$3"; [[ -e "$f" ]] || exit 44
if [[ "\${4:-}" == -w ]]; then cat "$f"; else m="$(cat "$f.mdat" 2>/dev/null || echo 20261101000000Z)"; printf '%s\\n' 'keychain: "login.keychain-db"' '    "mdat"<timedate>=0x00  "'"$m"'\\000"' '    "svce"<blob>="'"$3"'"'; fi
`;

async function cluster() {
  const s = wsFixture();
  const kc = mkdtempSync(join(tmpdir(), 'keychain-'));
  writeFileSync(join(kc, 'Claude Token (Test)'), CLAUDE);
  writeFileSync(join(kc, 'GitLab PAT (Test)'), GITLAB);
  writeFileSync(join(s.w.bin, 'security'), SECURITY(kc), { mode: 0o755 });
  const declaration = { p: { claude: { 'keychain-service': 'Claude Token (Test)' }, gitlab: { 'keychain-service': 'GitLab PAT (Test)', host: 'gitlab.example.com', 'npm-registries': { '@acme': '123' } }, git: { 'user-name': 'Ada', 'user-email': 'ada@example.com' } } };
  writeFileSync(join(s.env.HOME, '.harness', 'vm-credentials.json'), JSON.stringify(declaration));
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  edit(s.at('projects', 'p', 'project.json'), p => {
    p['dev-environments'].substrate = { clusters: [{ machine: 'mac' }] };
    p.registry = { 'storage-path': 'projects/p/registry', 'max-size-gb': 20, port: 9 };
    p['golden-image'] = { folder: 'projects/p/golden-image' };
  });
  mkdirSync(s.at('projects', 'p', 'golden-image'), { recursive: true });
  writeFileSync(s.at('projects', 'p', 'golden-image', 'template.yaml'), 'vmType: vz\n');
  writeFileSync(s.at('projects', 'p', 'golden-image', 'provision.sh'), '#!/bin/bash\n');
  writeFileSync(s.at('projects', 'p', `sandbox-image-${arch}.json`), JSON.stringify({ project: 'p', arch, digest: DIGEST, repository: '0local/sandbox/p', tag: `${arch}-dddddddddddd` }));
  writeFileSync(s.at('projects', 'p', 'sandbox-deliveries.json'), JSON.stringify({ mac: { arch, digest: DIGEST, ref: `sandbox/p@${DIGEST}` } }));
  const image = mkdtempSync(join(tmpdir(), 'image-'));
  for (const [name, url] of Object.entries(s.origins)) execFileSync('git', ['clone', '-q', url, join(image, 'repos', name)]);
  const dir = mkdtempSync(join(tmpdir(), 'mac-'));
  const m = fakeSubstrateMachine(dir, { memory: 38 * 1024 ** 3 });
  putKit(join(s.env.HOME, '.harness', 'substrate'));
  base += 50;
  Object.assign(s.env, m.env, {
    PATH: `${m.bin}:${s.env.PATH}`, HARNESS_SUBSTRATE_GRACE: '0', FAKE_SUBSTRATE_LOG: join(dir, 'substrate.log'),
    FAKE_COMMAND_SERVER: join(import.meta.dirname, '..', 'support', 'fake-command-server.js'), FAKE_SANDBOX_IMAGE: image,
    HARNESS_SANDBOX_PORTS: `${base}-${base + 49}`, HARNESS_SUBSTRATE_TEMPLATE_WAIT: '4', HARNESS_SUBSTRATE_RESUME_WAIT: '10', HARNESS_SANDBOX_REACH_MS: '3000',
  });
  const up = await s.result('substrate:up', 'p', 'mac');
  assert.equal(up.code, 0, up.err);
  const call = (...args) => s.result(...args).then(r => ({ ...r, json: last(r.out) }));
  const k8s = () => m.k8s();
  const secret = kind => { const f = join(k8s(), 'ns', 'harness-p', `secret-harness-credential-${kind}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
  const record = () => JSON.parse(readFileSync(s.at('projects', 'p', 'substrate.json'), 'utf8')).mac;
  const restarts = () => (existsSync(join(k8s(), 'provider-restarts')) ? readFileSync(join(k8s(), 'provider-restarts'), 'utf8').trim().split('\n').length : 0);
  const policy = actor => JSON.parse(readFileSync(join(k8s(), `egress-harness-p-${actor}.json`), 'utf8'));
  const root = actor => join(k8s(), 'sandboxes', 'harness-p', actor, 'root');
  const calls = () => readFileSync(s.env.FAKE_SUBSTRATE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const resave = (service, value, mdat) => { writeFileSync(join(kc, service), value); writeFileSync(join(kc, `${service}.mdat`), mdat); };
  // control's side: a ctx running the real commands, project p as state.js loads it.
  const logs = [];
  const ctx = {
    memory: { warned: new Set() }, env: { ...s.env, HARNESS_HOME: join(s.env.HOME, '.harness') }, t: Date.parse('2026-11-22T12:00:00Z'),
    log: (phase, line) => logs.push(`${phase} ${line}`), now: () => new Date(ctx.t),
    cli: async args => (await run(AGENT, args, { env: s.env })).stdout,
  };
  const control = () => keepCredentials(ctx, { harness: {} }, { id: 'p', json: JSON.parse(readFileSync(s.at('projects', 'p', 'project.json'), 'utf8')), substrate: { mac: record() } }, { machine: 'mac', host: 'mac' });
  return { s, m, kc, call, k8s, secret, record, restarts, policy, root, calls, resave, ctx, logs, control, gateway: () => fakeGateway(k8s(), 'harness-p') };
}

// Every file under a folder, as text.
const texts = dir => { const out = []; const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); const st = statSync(p, { throwIfNoEntry: false }); if (!st) continue; if (st.isDirectory()) walk(p); else if (st.isFile()) out.push([p, readFileSync(p, 'latin1')]); } }; walk(dir); return out; };

test('AC1, AC5: the declared keychain items become Kubernetes Secrets the gateway injects from (git\'s Basic pre-encoded); the sandbox holds placeholders only, and its requests reach the upstream with the token — never seen in a command line, an output or a record', async () => {
  const t = await cluster();
  const sync = await t.call('substrate:credentials', 'p', 'mac');
  assert.equal(sync.code, 0, sync.err);
  assert.deepEqual([sync.json.ok, sync.json.secrets, sync.json.kinds], [true, ['harness-credential-claude', 'harness-credential-gitlab'], ['claude', 'gitlab']]);
  // The Secrets: the same keychain items vm:credentials reads; GitLab's Basic value pre-encoded (oauth2:<token>).
  assert.deepEqual(t.secret('claude').stringData, { token: CLAUDE });
  assert.deepEqual(t.secret('gitlab').stringData, { token: GITLAB, basic: b64(`oauth2:${GITLAB}`) });
  assert.equal(t.secret('gitlab').metadata.labels['harness.dev/credential'], 'gitlab');
  // The provider's namespace policy grants the project's atespace its own namespace; the provider restarted for it, once.
  const cm = JSON.parse(readFileSync(join(t.k8s(), 'configmaps', 'ate-system-k8s-credential-provider-namespace-policy.json'), 'utf8'));
  assert.deepEqual(JSON.parse(cm.data['namespace-policy.yaml'].split('\n').filter(l => l && !l.startsWith('#')).join('\n')), { policies: [{ atespace: 'harness-p', allowedNamespaces: ['harness-p'] }] });
  assert.equal(t.restarts(), 1);
  const again = await t.call('substrate:credentials', 'p', 'mac');
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(again.json.did, [], 'nothing changed: nothing done');
  assert.equal(t.restarts(), 1, 'not restarted again');
  assert.deepEqual([t.record().credentials.ok, t.record().credentials.kinds, Object.keys(t.record().credentials.stamps)], [true, ['claude', 'gitlab'], ['claude', 'gitlab']]);

  // The sandbox: its egress policy is the project's; it holds no token anywhere, only placeholders.
  const up = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(up.code, 0, up.err);
  // Its policy is the union of its rule sets: this ticket's `credentials` (https, the gateway's hosts) beside ASS-536's `mac`.
  const rules = t.policy('abc-3-a').rules;
  assert.deepEqual(rules.filter(r => r.https).flatMap(r => r.https.hostnames).sort(), ['api.anthropic.com', 'gitlab.example.com', 'registry.npmjs.org']);
  assert.ok(rules.some(r => r.http?.hostnames.includes('host.docker.internal')), 'the mac set kept');
  const files = texts(t.root('abc-3-a'));
  assert.ok(files.length > 3);
  for (const [f, text] of files) assert.ok(!text.includes(CLAUDE) && !text.includes(GITLAB) && !text.includes(b64(`oauth2:${GITLAB}`)), `${f} holds a token`);
  const env = readFileSync(join(t.root('abc-3-a'), 'etc', 'profile.d', 'harness-credentials.sh'), 'utf8');
  assert.match(env, new RegExp(`^export CLAUDE_CODE_OAUTH_TOKEN=${PLACEHOLDERS.claude}$`, 'm'));
  assert.match(env, new RegExp(`^export GITLAB_TOKEN=${PLACEHOLDERS.gitlab}$`, 'm'));
  // And the template projects the gateway's trust bundle, which https injection needs.
  const template = JSON.parse(readFileSync(join(t.k8s(), 'templates-harness-p.json'), 'utf8')).actorTemplates[0];
  assert.deepEqual(template.volumes[0].systemInfo.dataSources[0].trustBundle.names, ['egress-mitm.ate.dev', 'system-roots.ate.dev']);
  assert.equal(template.containers[0].volumeMounts[0].mountPath, '/run/ate/egress-trust-bundle');

  // Injection: what the sandbox's tools send (git's Basic from its helper's placeholder, Claude Code's Bearer, glab's
  // PRIVATE-TOKEN) reaches the upstream with the real token; a request without the header goes out untouched.
  const gw = t.gateway();
  const gitBasic = `Basic ${b64(`oauth2:${PLACEHOLDERS.gitlab}`)}`;
  assert.deepEqual(gw.request('abc-3-a', { host: 'gitlab.example.com', headers: { authorization: gitBasic } }), { status: 200, headers: { Authorization: `Basic ${b64(`oauth2:${GITLAB}`)}` } });
  assert.deepEqual(gw.request('abc-3-a', { host: 'gitlab.example.com', headers: { 'PRIVATE-TOKEN': PLACEHOLDERS.gitlab } }).headers, { 'PRIVATE-TOKEN': GITLAB });
  assert.deepEqual(gw.request('abc-3-a', { host: 'api.anthropic.com', headers: { Authorization: `Bearer ${PLACEHOLDERS.claude}`, 'anthropic-version': '2023-06-01' } }).headers, { 'anthropic-version': '2023-06-01', Authorization: `Bearer ${CLAUDE}` });
  assert.deepEqual(gw.request('abc-3-a', { host: 'registry.npmjs.org', headers: { accept: 'application/json' } }).headers, { accept: 'application/json' });

  // No token on any command line (every kit call's argv is logged), in any output, or in a record.
  const argv = JSON.stringify(t.calls());
  for (const token of [CLAUDE, GITLAB, b64(`oauth2:${GITLAB}`)]) {
    assert.ok(!argv.includes(token), 'not in a kit call\'s argv');
    for (const out of [sync.out, sync.err, up.out, up.err, readFileSync(t.s.at('projects', 'p', 'substrate.json'), 'utf8'), readFileSync(t.s.at('projects', 'p', 'sprints', readdirSync(t.s.at('projects', 'p', 'sprints'))[0], 'sprint.json'), 'utf8')]) assert.ok(!out.includes(token));
  }
});

test('AC3, AC5: a host off the allowlist is refused (no rule: the DNS relay answers NXDOMAIN, which Substrate does not log); a listed host on another port is refused by the gateway, which logs it — substrate:health records the refusal and control logs it once', async () => {
  const t = await cluster();
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  const gw = t.gateway();
  const off = gw.request('abc-3-a', { host: 'example.com', headers: { authorization: `Bearer ${PLACEHOLDERS.claude}` } });
  assert.equal(off.status, 0);
  assert.match(off.denied, /NXDOMAIN/);
  const port = gw.request('abc-3-a', { host: 'gitlab.example.com', port: 22 });
  assert.equal(port.status, 403);
  const health = await t.call('substrate:health', 'p', 'mac');
  assert.equal(health.code, 0, health.err);
  assert.equal(health.json.egress.denied.length, 1);
  assert.match(health.json.egress.denied[0].line, /^egress denied: no rule allows the destination \(sandbox abc-3-a, gitlab\.example\.com, port 22\)$/);
  assert.deepEqual([health.json.egress.provider.ready, health.json.egress.policy.granted, health.json.egress.secrets], [true, true, ['harness-credential-claude', 'harness-credential-gitlab']]);
  await t.control();
  await t.control();
  assert.equal(t.logs.filter(l => /^substrate p mac: egress refused: egress denied: no rule allows the destination \(sandbox abc-3-a, gitlab\.example\.com, port 22\)$/.test(l)).length, 1, t.logs.join('\n'));
});

test('AC2, AC5: a re-saved keychain item reaches the gateway through control\'s own check — its stamps read at most every 5 minutes, as for VMs — and the next request carries the new token, with no sandbox made again, resumed or restarted', async () => {
  const t = await cluster();
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  assert.equal((await t.call('substrate:health', 'p', 'mac')).code, 0);
  // In step: control's first pass reads the stamps (cached for the interval) and syncs nothing.
  await t.control();
  assert.ok(!t.logs.some(l => /credentials synced/.test(l)), t.logs.join('\n'));
  const before = t.calls().length;
  const actor = readFileSync(join(t.k8s(), 'actors-harness-p.json'), 'utf8'), version = t.policy('abc-3-a').metadata.version;
  const ROTATED = 'sk-ant-oat01-DUMMY-claude-not-a-real-token-2';
  t.resave('Claude Token (Test)', ROTATED, '20261122120500Z');
  await t.control();
  assert.ok(!t.logs.some(l => /credentials synced/.test(l)), 'the cached stamps stand until the interval has passed');
  assert.equal(CREDENTIAL_STAMP_INTERVAL, 300);
  t.ctx.t += CREDENTIAL_STAMP_INTERVAL * 1000;
  await t.control();
  assert.ok(t.logs.some(l => /^substrate p mac: credentials synced into the egress gateway \(claude key changed in the keychain\): harness-credential-claude, harness-credential-gitlab; egress policy of abc-3-a$/.test(l)), t.logs.join('\n'));
  assert.equal(t.secret('claude').stringData.token, ROTATED);
  assert.equal(t.record().credentials.stamps.claude, '20261122120500Z');
  assert.deepEqual(t.gateway().request('abc-3-a', { host: 'api.anthropic.com', headers: { authorization: `Bearer ${PLACEHOLDERS.claude}` } }).headers, { Authorization: `Bearer ${ROTATED}` });
  // The sandbox untouched: the same actor, never created, resumed, suspended or deleted since; its policy unchanged.
  assert.equal(readFileSync(join(t.k8s(), 'actors-harness-p.json'), 'utf8'), actor);
  assert.ok(!t.calls().slice(before).some(c => /^(create|resume|suspend|delete)$/.test(c.argv.find(a => !a.startsWith('-') && !a.includes('/')) ?? '') && c.argv.includes('actor')), 'no actor call');
  assert.equal(t.policy('abc-3-a').metadata.version, version, 'its egress policy untouched');
  // In step again: nothing more.
  const synced = t.logs.filter(l => /credentials synced/.test(l)).length;
  t.ctx.t += CREDENTIAL_STAMP_INTERVAL * 1000;
  await t.control();
  assert.equal(t.logs.filter(l => /credentials synced/.test(l)).length, synced);
});

test('AC3: the allowlist follows the project — an added host and a dropped credential reach the running sandbox\'s egress policy through control (the Secret of a kind no longer declared deleted, its host refused from then on)', async () => {
  const t = await cluster();
  assert.equal((await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac')).code, 0);
  assert.equal((await t.call('substrate:health', 'p', 'mac')).code, 0);
  const version = Number(t.policy('abc-3-a').metadata.version);
  edit(t.s.at('projects', 'p', 'project.json'), p => { p['dev-environments'].substrate.egress = { allow: ['pypi.org'] }; });
  edit(join(t.s.env.HOME, '.harness', 'vm-credentials.json'), d => { delete d.p.gitlab; });
  await t.control();
  assert.ok(t.logs.some(l => /credentials synced into the egress gateway \(its allowlist or declared credentials changed\): harness-credential-claude; egress policy of abc-3-a$/.test(l)), t.logs.join('\n'));
  assert.equal(t.secret('gitlab'), null);
  assert.equal(t.policy('abc-3-a').metadata.version, String(version + 1), 'updated in place, once');
  assert.ok(t.policy('abc-3-a').rules.some(r => r.http?.hostnames.includes('host.docker.internal')), 'ASS-536\'s mac set kept');
  const gw = t.gateway();
  assert.equal(gw.request('abc-3-a', { host: 'pypi.org' }).status, 200);
  assert.match(gw.request('abc-3-a', { host: 'gitlab.example.com' }).denied, /NXDOMAIN/);
  // A wrong addition is named by field and syncs nothing.
  edit(t.s.at('projects', 'p', 'project.json'), p => { p['dev-environments'].substrate.egress = { allow: ['https://x'] }; });
  const bad = await t.call('substrate:credentials', 'p', 'mac');
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /dev-environments\.substrate\.egress\.allow\[0\] "https:\/\/x" is not a host name/);
});

test('AC4: project:credentials-status covers the gateway\'s credentials — the provider pod, its namespace policy and each declared Secret — with the command that fixes each, holding nothing', async () => {
  const t = await cluster();
  assert.equal((await t.call('substrate:credentials', 'p', 'mac')).code, 0);
  assert.equal((await t.call('substrate:health', 'p', 'mac')).code, 0);
  const env = { ...t.s.env, GH_DISABLED: '1', GLAB_DISABLED: '1' };
  const status = async () => JSON.parse((await run(AGENT, ['project:check-credentials', 'p'], { env })).stdout);
  let out = await status();
  assert.equal(out.held, false);
  assert.deepEqual(out.substrate.problems, []);
  // The provider not ready, the namespace policy no longer granting the project, a Secret gone.
  t.m.broken('provider');
  rmSync(join(t.k8s(), 'ns', 'harness-p', 'secret-harness-credential-gitlab.json'));
  writeFileSync(join(t.k8s(), 'configmaps', 'ate-system-k8s-credential-provider-namespace-policy.json'), JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'k8s-credential-provider-namespace-policy', namespace: 'ate-system' }, data: { 'namespace-policy.yaml': 'policies: []\n' } }));
  assert.equal((await t.call('substrate:health', 'p', 'mac')).code, 0);
  out = await status();
  assert.equal(out.held, false, 'a cluster\'s trouble holds no VM work');
  assert.deepEqual(out.substrate.problems.map(p => [p.machine, p.credential, p.problem, p.fix]), [
    ['mac', 'the egress gateway\'s credential provider', 'not ready: 0 of 1 ready', 'HARNESS_SUBSTRATE_REPAIR=1 ./agent.sh substrate:up p mac'],
    ['mac', 'the credential provider\'s namespace policy', 'does not grant the atespace harness-p its own namespace\'s Secrets', './agent.sh substrate:credentials p mac'],
    ['mac', 'Secret harness-credential-gitlab (gitlab)', 'missing from the cluster: the gateway cannot inject p\'s gitlab credential', './agent.sh substrate:credentials p mac'],
  ]);
  assert.deepEqual((JSON.parse((await run(AGENT, ['project:credentials-status', 'p'], { env })).stdout)).substrate.problems.length, 3);
  // A failed sync is reported too (a keychain item gone: also the usual hold, for VMs).
  rmSync(join(t.kc, 'Claude Token (Test)'));
  const failed = await t.call('substrate:credentials', 'p', 'mac');
  assert.notEqual(failed.code, 0);
  assert.match(failed.err, /claude: "Claude Token \(Test\)" is missing/);
  out = await status();
  assert.ok(out.substrate.problems.some(p => p.credential === 'the egress gateway\'s credentials' && /the last sync failed/.test(p.problem) && p.fix === './agent.sh substrate:credentials p mac'), JSON.stringify(out.substrate.problems));
});

test('ASS-537: hibernating a sandbox keeps its `credentials` rule set (beside `mac`) and the namespace\'s credential Secrets; resuming it changes neither, and only deleting it removes its rules', async () => {
  const t = await cluster();
  assert.equal((await t.call('substrate:credentials', 'p', 'mac')).code, 0);
  const up = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(up.code, 0, up.err);
  const rules = JSON.stringify(t.policy('abc-3-a').rules), secrets = [t.secret('claude'), t.secret('gitlab')];
  assert.ok(t.policy('abc-3-a').rules.some(r => r.https) && t.policy('abc-3-a').rules.some(r => r.http), 'both sets');
  const stop = await t.call('substrate:sandbox-stop', 'p', 'ABC-3', 'A');
  assert.equal(stop.code, 0, stop.err);
  assert.equal(JSON.stringify(t.policy('abc-3-a').rules), rules, 'its policy kept while hibernated');
  assert.deepEqual([t.secret('claude'), t.secret('gitlab')], secrets, 'the Secrets kept');
  const again = await t.call('substrate:sandbox-up', 'p', 'ABC-3', 'A', 'mac');
  assert.equal(again.code, 0, again.err);
  assert.equal(again.json.created, false);
  assert.equal(JSON.stringify(t.policy('abc-3-a').rules), rules, 'the same rules after the resume');
  assert.deepEqual([t.secret('claude'), t.secret('gitlab')], secrets);
  assert.equal((await t.call('substrate:sandbox-delete', 'p', 'ABC-3', 'A')).code, 0);
  assert.ok(!existsSync(join(t.k8s(), 'egress-harness-p-abc-3-a.json')), 'deleting removes its rules');
  assert.ok(t.secret('claude'), 'the namespace\'s Secrets are the project\'s, not the sandbox\'s');
});
