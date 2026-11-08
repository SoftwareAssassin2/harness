// forge.js (ASS-307): the forge a repository url is on (providerOf, repoPath,
// commonOwner) and the account a project's VM token pushes as (pushAccount).
// The keychain is a fake `security` on PATH, pinned to the VMs' own argv
// (`find-generic-password -s <service> -w`, no -a), and each forge a stub
// server (GITHUB_API_URL / GITLAB_API_URL) — no test reads a real token or
// calls a real forge.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// By the namespace, so the suite runs (and fails) before forge.js is there.
const forge = await import('../../src/agents/forge.js').catch(() => ({}));

const TOKEN = 'ghp_FAKEPUSHTOKEN';

// A fake `security` that prints `value` for keychain item `service` read with
// exactly `-s <service> -w` (recording its argv), else exits 44 as the real
// one does for a missing item; value null, every read is missing.
function keychain(service, value = TOKEN) {
  const bin = mkdtempSync(join(tmpdir(), 'sec-'));
  const answer = value == null ? 'exit 44\n' : `printf '%b' '${value.replaceAll('\n', '\\n')}'\n`;
  writeFileSync(join(bin, 'security'), `#!/bin/sh\necho "$@" >> "$(dirname "$0")/argv"\n[ "$*" = "find-generic-password -s ${service} -w" ] || exit 44\n${answer}`);
  chmodSync(join(bin, 'security'), 0o755);
  return { bin, argv: () => (existsSync(join(bin, 'argv')) ? readFileSync(join(bin, 'argv'), 'utf8') : '') };
}

// A stub forge answering each request with the next of `answers`
// ({ status, body }), recording each request's url and headers.
const servers = [];
after(() => servers.forEach(s => s.close()));
async function stubForge(answers) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const { status = 200, body = {} } = answers.shift() ?? { status: 500 };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const envOf = (bin, extra) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, USER: 'me', ...extra });
const github = async (answers, value = TOKEN) => {
  const k = keychain('GitHub PAT', value), f = await stubForge(answers);
  return { ...k, ...f, ask: () => forge.pushAccount({ provider: 'GitHub', host: 'github.com', service: 'GitHub PAT', env: envOf(k.bin, { GITHUB_API_URL: f.url }) }) };
};
const gitlab = async (answers, value = TOKEN) => {
  const k = keychain('GitLab PAT', value), f = await stubForge(answers);
  return { ...k, ...f, ask: () => forge.pushAccount({ provider: 'GitLab', host: 'gitlab.com', service: 'GitLab PAT', env: envOf(k.bin, { GITLAB_API_URL: f.url }) }) };
};

// ===== AC1: the url arithmetic =====

test('ASS-307 AC1: providerOf — github.com is GitHub, gitlab.com (or any other host: a self-hosted GitLab) GitLab, with the host', () => {
  assert.deepEqual(forge.providerOf('https://github.com/SoftwareAssassin2/harness'), { provider: 'GitHub', host: 'github.com' });
  assert.deepEqual(forge.providerOf('https://gitlab.com/caselaw-group/api'), { provider: 'GitLab', host: 'gitlab.com' });
  assert.deepEqual(forge.providerOf('https://git.example.com/team/app'), { provider: 'GitLab', host: 'git.example.com' });
  assert.throws(() => forge.providerOf('not a url'));                       // its callers guard
});

test('ASS-307 AC1: repoPath — owner/name, without slashes or .git', () => {
  assert.equal(forge.repoPath('https://github.com/SoftwareAssassin2/harness'), 'SoftwareAssassin2/harness');
  assert.equal(forge.repoPath('https://gitlab.com/caselaw-group/api.git'), 'caselaw-group/api');
  assert.equal(forge.repoPath('https://gitlab.com/g/sub/app/'), 'g/sub/app');
});

test('ASS-307 AC1: commonOwner — the urls\' longest common group/owner path; nested groups g/sub; none, \'\'; one url its own owner; [] \'\'', () => {
  const caselaw = Array.from({ length: 26 }, (_, i) => `https://gitlab.com/caselaw-group/repo-${i}`);
  assert.equal(forge.commonOwner(caselaw), 'caselaw-group');
  assert.equal(forge.commonOwner(['https://gitlab.com/caselaw-group/a', 'https://gitlab.com/caselaw-group/b/c']), 'caselaw-group');
  assert.equal(forge.commonOwner(['https://gitlab.com/g/sub/a', 'https://gitlab.com/g/sub/b']), 'g/sub');
  assert.equal(forge.commonOwner(['https://gitlab.com/one/a', 'https://gitlab.com/two/b']), '');
  assert.equal(forge.commonOwner(['https://github.com/SoftwareAssassin2/harness']), 'SoftwareAssassin2');
  assert.equal(forge.commonOwner([]), '');
});

// ===== AC2: pushAccount, the one keychain read and the one forge call =====

test('ASS-307 AC2: pushAccount on GitHub — GET /user with the token as a Bearer, the account its login; security read as -s <service> -w only', async () => {
  const g = await github([{ body: { login: 'SoftwareAssassin2' } }]);
  assert.equal(await g.ask(), 'SoftwareAssassin2');
  assert.equal(g.requests.length, 1);
  assert.equal(new URL(g.requests[0].url, g.url).pathname, '/user');
  assert.equal(g.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(g.argv(), 'find-generic-password -s GitHub PAT -w\n');           // no -a: an item saved under any account is found, as the VMs find it
});

test('ASS-307 AC2: pushAccount on GitLab — GET /api/v4/user with Authorization: Bearer (not PRIVATE-TOKEN), the account its username', async () => {
  const g = await gitlab([{ body: { username: 'ada' } }]);
  assert.equal(await g.ask(), 'ada');
  assert.equal(g.requests.length, 1);
  assert.equal(new URL(g.requests[0].url, g.url).pathname, '/api/v4/user');
  assert.equal(g.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(g.requests[0].headers['private-token'], undefined);
});

test('ASS-307 AC2: pushAccount sends the token as read_tokens does, its whitespace stripped', async () => {
  const g = await github([{ body: { login: 'ada' } }], ` ${TOKEN}\n`);
  assert.equal(await g.ask(), 'ada');
  assert.equal(g.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('ASS-307 AC2: no item in the keychain, or an empty one, throws "no token in the keychain" without calling the forge', async () => {
  for (const value of [null, '', '  \n']) {
    const g = await github([{ body: { login: 'ada' } }], value);
    await assert.rejects(g.ask(), { message: 'no token in the keychain' }, JSON.stringify(value));
    assert.equal(g.requests.length, 0);
  }
});

test('ASS-307 AC2: a 401 throws "token rejected (401)"; any other failing status "the forge is unavailable (<status>)"; 200 without the field "the forge answered no account" — never with the token', async () => {
  const cases = [
    [{ status: 401, body: { message: TOKEN } }, 'token rejected (401)'],
    [{ status: 500, body: {} }, 'the forge is unavailable (500)'],
    [{ status: 403, body: {} }, 'the forge is unavailable (403)'],
    [{ status: 200, body: { name: 'Ada' } }, 'the forge answered no account'],
  ];
  for (const [answer, message] of cases) {
    for (const make of [github, gitlab]) {
      const g = await make([answer]);
      const error = await g.ask().then(() => null, e => e);
      assert.equal(error?.message, message, `${make.name} ${answer.status}`);
      assert.ok(!String(error?.stack).includes(TOKEN));
    }
  }
});

test('ASS-307 AC2: a forge that cannot be reached throws "the forge is unreachable"', async () => {
  const k = keychain('GitHub PAT');
  const closed = await stubForge([]);
  servers.pop().close();
  await new Promise(done => setTimeout(done, 50));
  await assert.rejects(forge.pushAccount({ provider: 'GitHub', host: 'github.com', service: 'GitHub PAT', env: envOf(k.bin, { GITHUB_API_URL: closed.url }) }), { message: 'the forge is unreachable' });
});

test('ASS-307 AC2: GITHUB_API_URL and GITLAB_API_URL each replace only their own forge\'s host', async () => {
  const hub = await stubForge([{ body: { login: 'hub' } }]), lab = await stubForge([{ body: { username: 'lab' } }]);
  const both = { GITHUB_API_URL: hub.url, GITLAB_API_URL: lab.url };
  assert.equal(await forge.pushAccount({ provider: 'GitHub', host: 'github.com', service: 'GitHub PAT', env: envOf(keychain('GitHub PAT').bin, both) }), 'hub');
  assert.equal(await forge.pushAccount({ provider: 'GitLab', host: 'gitlab.com', service: 'GitLab PAT', env: envOf(keychain('GitLab PAT').bin, both) }), 'lab');
  assert.deepEqual([hub.requests.length, lab.requests.length], [1, 1]);
});
