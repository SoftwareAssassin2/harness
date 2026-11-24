// ASS-538: what a project's sandboxes may reach (AC3) and what the egress gateway puts into their requests (AC1) —
// src/substrate/egress.js's allowlist, rules, policy and placeholders, and its settings' validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { allowlist, credentialRules, egressPolicy, egressErrors, hostOf, injections, placeholderScript, policyHash, validHost, EGRESS_SETS, PLACEHOLDERS, SECRETS } from '../../src/substrate/egress.js';
import { substrateErrors } from '../../src/control/substrate-config.js';

const decl = {
  claude: { 'keychain-service': 'Claude Token (Test)' },
  gitlab: { 'keychain-service': 'GitLab PAT (Test)', host: 'gitlab.example.com', 'npm-registries': { '@acme': '123' } },
  git: { 'user-name': 'Ada Example', 'user-email': 'ada@example.com' },
};
const json = (extra = {}) => ({ repositories: [{ url: 'git@gitlab.example.com:acme/shop.git' }, { url: 'https://github.com/acme/ui.git' }], ...extra });

test('AC3: the allowlist defaults to what the repositories and credentials need — each forge (SSH remotes too), GitHub\'s hosts behind it, the model API, the declared GitLab with its npm registries, the npm registry — plus the project\'s own additions', () => {
  assert.deepEqual(allowlist(json(), decl).map(a => a.host), ['*.githubusercontent.com', 'api.anthropic.com', 'api.github.com', 'codeload.github.com', 'github.com', 'gitlab.example.com', 'registry.npmjs.org']);
  assert.match(allowlist(json(), decl).find(a => a.host === 'gitlab.example.com').why, /a repository, the gitlab credential and its npm registries/);
  // Nothing declared, no repositories: the model API and the npm registry only.
  assert.deepEqual(allowlist({}, null).map(a => a.host), ['api.anthropic.com', 'registry.npmjs.org']);
  // A github credential brings GitHub's hosts; gitlab's default host is gitlab.com.
  assert.deepEqual(allowlist({}, { github: { 'keychain-service': 'G' }, gitlab: { 'keychain-service': 'L' } }).map(a => a.host),
    ['*.githubusercontent.com', 'api.anthropic.com', 'api.github.com', 'codeload.github.com', 'github.com', 'gitlab.com', 'registry.npmjs.org']);
  // The project's additions.
  const extra = json({ 'dev-environments': { substrate: { egress: { allow: ['pypi.org', '*.pythonhosted.org'] } } } });
  assert.deepEqual(allowlist(extra, decl).filter(a => a.why.includes('egress.allow')).map(a => a.host), ['*.pythonhosted.org', 'pypi.org']);
  assert.deepEqual([hostOf('ssh://git@Gitlab.Example.com:2222/a/b.git'), hostOf('git@host.example:a/b'), hostOf('https://u:p@h.example/x'), hostOf('/local/path'), hostOf('')], ['gitlab.example.com', 'host.example', 'h.example', null, null]);
});

test('AC3: dev-environments.substrate.egress is validated by field, as part of the substrate settings', () => {
  assert.deepEqual(egressErrors({}), []);
  assert.deepEqual(egressErrors({ 'dev-environments': { substrate: { egress: { allow: ['pypi.org', '*.example.com'] } } } }), []);
  const bad = { 'dev-environments': { substrate: { egress: { allow: ['https://x.com', 'X.com', '*', 'a.*.com', 3], deny: [] } } } };
  assert.deepEqual(egressErrors(bad), [
    'dev-environments.substrate.egress.allow[0] "https://x.com" is not a host name (lower case, no scheme, port or path; "*." only as its first label)',
    'dev-environments.substrate.egress.allow[1] "X.com" is not a host name (lower case, no scheme, port or path; "*." only as its first label)',
    'dev-environments.substrate.egress.allow[2] "*" is not a host name (lower case, no scheme, port or path; "*." only as its first label)',
    'dev-environments.substrate.egress.allow[3] "a.*.com" is not a host name (lower case, no scheme, port or path; "*." only as its first label)',
    'dev-environments.substrate.egress.allow[4] 3 is not a host name (lower case, no scheme, port or path; "*." only as its first label)',
    'dev-environments.substrate.egress.deny is not an egress setting (allow)',
  ]);
  assert.deepEqual(egressErrors({ 'dev-environments': { substrate: { egress: [] } } }), ['dev-environments.substrate.egress is not an object']);
  // The Mac's names are ASS-536's `mac` set's, never this list's (two sets tying on a host and port are refused).
  assert.deepEqual(egressErrors({ 'dev-environments': { substrate: { egress: { allow: ['host.docker.internal', 'harness-mac.harness-p.svc.cluster.local'] } } } }), [
    'dev-environments.substrate.egress.allow[0] "host.docker.internal" is the Mac\'s, which the sandbox reaches through its own rule set (ASS-536\'s "mac"), never this list',
    'dev-environments.substrate.egress.allow[1] "harness-mac.harness-p.svc.cluster.local" is the Mac\'s, which the sandbox reaches through its own rule set (ASS-536\'s "mac"), never this list',
  ]);
  assert.deepEqual(substrateErrors({ 'dev-environments': { substrate: { clusters: [{ machine: 'mac' }], egress: { allow: 'x' } } } }), ['dev-environments.substrate.egress.allow is not a list']);
  assert.ok(validHost('a-b.example.com') && validHost('*.example.com') && !validHost('example.com.') && !validHost('-a.com'));
});

test('AC1: each declared credential is injected at the gateway into the header its client sends, from its Secret in the project\'s namespace — Claude\'s Bearer and Anthropic\'s x-api-key on the model API, git\'s Basic (pre-encoded) and PRIVATE-TOKEN on GitLab, Basic on github.com and Bearer on api.github.com', () => {
  const both = { ...decl, anthropic: { 'keychain-service': 'A' }, github: { 'keychain-service': 'H' } };
  const inj = injections(both, 'harness-p');
  assert.deepEqual(inj.get('api.anthropic.com'), [
    { header: 'x-api-key', credentialUri: 'ate-secret://k8s.io/default/harness-p/harness-credential-anthropic/key' },
    { header: 'Authorization', prefix: 'Bearer ', credentialUri: 'ate-secret://k8s.io/default/harness-p/harness-credential-claude/token' },
  ]);
  assert.deepEqual(inj.get('gitlab.example.com'), [
    { header: 'Authorization', prefix: 'Basic ', credentialUri: 'ate-secret://k8s.io/default/harness-p/harness-credential-gitlab/basic' },
    { header: 'PRIVATE-TOKEN', credentialUri: 'ate-secret://k8s.io/default/harness-p/harness-credential-gitlab/token' },
  ]);
  assert.deepEqual(inj.get('github.com'), [{ header: 'Authorization', prefix: 'Basic ', credentialUri: 'ate-secret://k8s.io/default/harness-p/harness-credential-github/basic' }]);
  assert.deepEqual(inj.get('api.github.com'), [{ header: 'Authorization', prefix: 'Bearer ', credentialUri: 'ate-secret://k8s.io/default/harness-p/harness-credential-github/token' }]);
  assert.deepEqual([SECRETS.gitlab.user, SECRETS.github.user], ['oauth2', 'x-access-token']);
  // Rules: https on 443, one rule per set of injections; every allowed host in exactly one rule; no credential declared, no effects.
  const rules = credentialRules(json(), both, 'harness-p');
  assert.ok(rules.every(r => r.https && r.https.ports.numbers.join() === '443'));
  const hosts = rules.flatMap(r => r.https.hostnames);
  assert.deepEqual([...hosts].sort(), allowlist(json(), both).map(a => a.host));
  assert.equal(new Set(hosts).size, hosts.length);
  assert.ok(credentialRules(json(), null, 'harness-p').every(r => !r.https.effects));
});

test('AC3: the policy is made of named rule sets (another ticket\'s beside this one\'s `credentials`); two sets deciding one host and port are refused before Substrate would; its hash follows the allowlist and the declaration', () => {
  assert.deepEqual(Object.keys(EGRESS_SETS), ['credentials']);
  const forwarder = () => [{ http: { hostnames: ['host.docker.internal'], ports: { numbers: [18099] } } }];
  const p = egressPolicy(json(), decl, 'harness-p', { ...EGRESS_SETS, forwarder });
  assert.deepEqual(p.rules.at(-1), forwarder()[0]);
  const clash = () => [{ https: { hostnames: ['api.anthropic.com'] } }];
  assert.throws(() => egressPolicy(json(), decl, 'harness-p', { ...EGRESS_SETS, clash }), /egress rule sets credentials and clash both decide api\.anthropic\.com:443/);
  const h = policyHash(egressPolicy(json(), decl, 'harness-p'));
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.notEqual(policyHash(egressPolicy(json({ 'dev-environments': { substrate: { egress: { allow: ['pypi.org'] } } } }), decl, 'harness-p')), h);
  assert.notEqual(policyHash(egressPolicy(json(), { ...decl, anthropic: { 'keychain-service': 'A' } }, 'harness-p')), h);
  assert.equal(policyHash(egressPolicy(json(), { ...decl, atlassian: { 'keychain-service': 'J', site: 's', email: 'e' } }, 'harness-p')), h, 'atlassian never goes through');
});

test('AC1: the sandbox gets placeholders only — the env Claude Code, gh, glab and npm read, a git helper with a placeholder password per forge (so git sends Basic over HTTPS), SSH remotes rewritten to HTTPS, the trust bundle — and no token', () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-root-'));
  const script = placeholderScript(json(), { ...decl, anthropic: { 'keychain-service': 'A' } });
  execFileSync('bash', ['-c', script], { env: { ...process.env, HARNESS_VM_ROOT: root } });
  execFileSync('bash', ['-c', script], { env: { ...process.env, HARNESS_VM_ROOT: root } });   // idempotent
  const env = readFileSync(join(root, 'etc', 'profile.d', 'harness-credentials.sh'), 'utf8');
  for (const line of [`export CLAUDE_CODE_OAUTH_TOKEN=${PLACEHOLDERS.claude}`, `export ANTHROPIC_API_KEY=${PLACEHOLDERS.anthropic}`, `export GITLAB_TOKEN=${PLACEHOLDERS.gitlab}`,
    'export GITLAB_HOST=gitlab.example.com', 'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', '  export NODE_EXTRA_CA_CERTS=/run/ate/egress-trust-bundle/trust-bundle.pem',
    '  export GIT_SSL_CAINFO=/run/ate/egress-trust-bundle/trust-bundle.pem']) assert.ok(env.split('\n').includes(line), `${line} in\n${env}`);
  assert.doesNotMatch(env, /GH_TOKEN/, 'no github declared');
  const gitconfig = join(root, 'etc', 'harness', 'gitconfig');
  const cfg = args => execFileSync('git', ['config', '--file', gitconfig, ...args], { encoding: 'utf8' }).trim();
  assert.equal(cfg(['user.name']), 'Ada Example');
  assert.equal(cfg(['--get-all', 'url.https://gitlab.example.com/.insteadOf']), 'git@gitlab.example.com:\nssh://git@gitlab.example.com/');
  assert.equal(cfg(['--get-all', 'url.https://github.com/.insteadOf']), 'git@github.com:\nssh://git@github.com/');
  // The helper answers a placeholder: git's Basic is base64(oauth2:placeholder), which the gateway replaces.
  const helper = cfg(['credential.https://gitlab.example.com.helper']);
  const said = execFileSync('bash', ['-c', `${helper.slice(1)} get`], { encoding: 'utf8' });
  assert.equal(said, `username=oauth2\npassword=${PLACEHOLDERS.gitlab}\n`);
  assert.equal(readFileSync(join(root, 'etc', 'gitconfig'), 'utf8'), '[include]\n\tpath = /etc/harness/gitconfig\n', 'included once');
  assert.equal(readFileSync(join(root, 'etc', 'harness', 'npmrc'), 'utf8'),
    `@acme:registry=https://gitlab.example.com/api/v4/projects/123/packages/npm/\n//gitlab.example.com/api/v4/projects/123/packages/npm/:_auth=${Buffer.from(`oauth2:${PLACEHOLDERS.gitlab}`).toString('base64')}\n`);
  // No file holds anything but placeholders: the script is made from the declaration alone, which holds no token.
  const all = []; const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else all.push(readFileSync(p, 'utf8')); } };
  walk(root);
  assert.ok(all.every(t => !/glpat-(?!harness-placeholder)|sk-ant-(?!oat01-harness|api03-harness)/.test(t)));
});
