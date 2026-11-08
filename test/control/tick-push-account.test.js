// The push-account check (ASS-307): control asks, at start and then at most
// hourly per project, which account the project's VM token for its
// repositories' forge pushes as (ctx.pushAccount — a fake here, or
// forge.js's pushAccount against a fake `security` and stub forges; never the
// real keychain or a real forge), recorded by project:set-push-account in the
// project's push-account.json for the control box.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { controlFixture } from './control-fixture.js';
import { tick, createContext } from '../../src/control/tick.js';
// By the namespace, so the suite runs (and fails) before the modules are there.
const { checkPushAccount } = await import('../../src/control/push-account.js').catch(() => ({}));
const { declaredCredentials } = await import('../../src/control/vm-credentials.js').catch(() => ({}));
const { pushAccount } = await import('../../src/agents/forge.js').catch(() => ({}));

const HOUR = 3600e3;
const HUB = 'https://github.com/SoftwareAssassin2/harness';
const LAB = name => `https://gitlab.com/caselaw-group/${name}`;
const write = (file, json) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(json, null, 4)); };
const projectFile = (f, id) => join(f.dir, 'projects', id, 'project.json');
// Project `id` (p is the fixture's own; another is added) with these repositories (undefined: none declared).
const withRepositories = (f, id, urls) => {
  const json = existsSync(projectFile(f, id)) ? JSON.parse(readFileSync(projectFile(f, id), 'utf8')) : { name: id.toUpperCase() };
  write(projectFile(f, id), { ...json, repositories: urls?.map(url => ({ url })) });
};
const recorded = (f, id) => { const file = join(f.dir, 'projects', id, 'push-account.json'); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined; };
const GITHUB = { github: { 'keychain-service': 'GitHub PAT' } };
const GITLAB = { gitlab: { 'keychain-service': 'GitLab PAT', host: 'gitlab.com' } };

// The fixture with its own HARNESS_HOME holding vm-credentials.json
// (`credentials`, null: no file), p on GitHub, a fake pushAccount
// answering each ask with the next of `answers` (a login, or an Error thrown),
// and every cli call recorded.
function checking({ credentials = { p: GITHUB }, answers = [] } = {}) {
  const f = controlFixture();
  const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
  if (credentials) write(join(home, 'vm-credentials.json'), credentials);
  f.ctx.env = { ...f.env, HARNESS_HOME: home };
  withRepositories(f, 'p', [HUB]);
  let now = Date.parse('2026-11-08T13:00:00Z');
  f.ctx.now = () => new Date(now);
  const asked = [];
  f.ctx.pushAccount = async ({ provider, host, service }) => {
    asked.push({ provider, host, service });
    const answer = answers.shift() ?? 'ada';
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const calls = [];
  const cli = f.ctx.cli;
  f.ctx.cli = args => { calls.push(args.join(' ')); return cli(args); };
  return { f, home, asked, calls, later: ms => { now += ms; }, check: () => checkPushAccount(f.ctx, f.ctx.load()) };
}

test('ASS-307 AC2: checkPushAccount asks at start, then at most hourly per project, each project\'s cadence its own', async () => {
  const { f, asked, later, check } = checking({ credentials: { p: GITHUB, r: GITLAB } });
  await check();
  assert.deepEqual(asked.map(a => a.provider), ['GitHub']);               // the first tick at once; r has no repositories yet
  later(HOUR / 2);
  withRepositories(f, 'r', [LAB('a'), LAB('b')]);
  await check();
  assert.deepEqual(asked.map(a => a.provider), ['GitHub', 'GitLab']);     // r's first check; p's hour not up
  later(HOUR / 2 - 1000);
  await check();
  assert.equal(asked.length, 2);                                          // not yet an hour for either
  later(1000);
  await check();
  assert.deepEqual(asked.map(a => a.provider), ['GitHub', 'GitLab', 'GitHub']);   // p's hour, not r's
  later(HOUR / 2);
  await check();
  assert.deepEqual(asked.map(a => a.provider), ['GitHub', 'GitLab', 'GitHub', 'GitLab']);
});

test('ASS-307 AC2: an account is recorded as project:set-push-account <id> <provider> <account> -; a failure as <id> <provider> - <reason>', async () => {
  const { f, calls, later, check } = checking({ answers: ['SoftwareAssassin2', new Error('token rejected (401)')] });
  await check();
  later(HOUR);
  await check();
  assert.deepEqual(calls.filter(c => c.startsWith('project:set-push-account')), [
    'project:set-push-account p GitHub SoftwareAssassin2 -',
    'project:set-push-account p GitHub - token rejected (401)',
  ]);
  assert.deepEqual(calls.filter(c => !c.startsWith('project:set-push-account')), []);   // its only cli call
  assert.deepEqual({ ...recorded(f, 'p'), 'checked-at': 'x' }, { project: 'p', provider: 'GitHub', account: null, error: 'token rejected (401)', 'checked-at': 'x' });
});

test('ASS-307 AC2: a GitHub project is asked with its github token\'s service, a GitLab project with its gitlab one\'s and its host — never the other\'s', async () => {
  const { f, asked, check } = checking({ credentials: { p: { ...GITHUB, ...GITLAB }, r: { ...GITHUB, gitlab: { 'keychain-service': 'Self-hosted PAT', host: 'git.example.com' } } } });
  withRepositories(f, 'r', ['https://git.example.com/team/app']);
  await check();
  assert.deepEqual(asked, [
    { provider: 'GitHub', host: 'github.com', service: 'GitHub PAT' },
    { provider: 'GitLab', host: 'git.example.com', service: 'Self-hosted PAT' },
  ]);
});

test('ASS-307 AC2: no token declared for the project\'s forge — no vm-credentials.json, no entry for the project, or only the other forge\'s — is recorded as "no token declared", nothing asked', async () => {
  for (const credentials of [null, { other: GITHUB }, { p: GITLAB }, { p: {} }]) {
    const { f, asked, calls, check } = checking({ credentials });
    await check();
    assert.deepEqual(asked, [], JSON.stringify(credentials));
    assert.deepEqual(calls, ['project:set-push-account p GitHub - no token declared'], JSON.stringify(credentials));
    assert.equal(recorded(f, 'p')?.error, 'no token declared');
  }
});

test('ASS-307 AC2: a project with no repositories, an empty list, or none whose url parses is never asked and nothing is written for it', async () => {
  for (const urls of [undefined, [], ['not a url']]) {
    const { f, asked, calls, check } = checking();
    withRepositories(f, 'p', urls);
    await check();
    assert.deepEqual(asked, [], JSON.stringify(urls));
    assert.deepEqual(calls, [], JSON.stringify(urls));
    assert.equal(recorded(f, 'p'), undefined, JSON.stringify(urls));
  }
});

test('ASS-307 AC2: a control of one project checks only that project; the all-projects control every one', async () => {
  const { f, asked, check } = checking({ credentials: { p: GITHUB, r: GITLAB } });
  withRepositories(f, 'r', [LAB('a')]);
  f.ctx.project = 'r';
  await check();
  assert.deepEqual(asked.map(a => a.provider), ['GitLab']);
  const all = checking({ credentials: { p: GITHUB, r: GITLAB } });
  withRepositories(all.f, 'r', [LAB('a')]);
  await all.check();
  assert.deepEqual(all.asked.map(a => a.provider).toSorted(), ['GitHub', 'GitLab']);
});

test('ASS-307 AC2: one project\'s failing record leaves the rest of the phase to run, logged under error', async () => {
  const { f, calls, check } = checking({ credentials: { p: GITHUB, r: GITLAB } });
  withRepositories(f, 'r', [LAB('a')]);
  const cli = f.ctx.cli;
  f.ctx.cli = args => (args[1] === 'p' ? Promise.reject(new Error('boom')) : cli(args));
  await check();
  assert.ok(calls.includes('project:set-push-account r GitLab ada -'), calls.join('\n'));
  assert.equal(recorded(f, 'r')?.account, 'ada');
  assert.ok(f.lines.some(l => l.startsWith('error push-account') && l.includes('boom')), f.lines.join('\n'));
});

test('ASS-307 AC2: checkPushAccount runs in every tick; a context made with PUSH_ACCOUNT_DISABLED=1 (the fixtures\' env) has no pushAccount, and nothing is asked', async () => {
  const { f, asked } = checking();
  await tick(f.ctx);
  assert.equal(asked.length, 1);
  assert.equal(recorded(f, 'p')?.account, 'ada');
  assert.equal(controlFixture().ctx.pushAccount, null);
  const off = createContext({ root: '/nowhere', env: { PUSH_ACCOUNT_DISABLED: '1' } });
  assert.equal(off.pushAccount, null);
  const calls = [];
  off.cli = args => { calls.push(args); };
  await checkPushAccount(off, { projects: [{ id: 'p', json: { repositories: [{ url: HUB }] } }], harness: {} });   // returns without asking or writing
  assert.deepEqual(calls, []);
  assert.equal(typeof createContext({ root: '/nowhere', env: {} }).pushAccount, 'function');
});

test('ASS-307 AC2: declaredCredentials(env, id) — the project\'s object in $HARNESS_HOME/vm-credentials.json; null with no file, unreadable JSON or no entry', () => {
  const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
  const env = { HARNESS_HOME: home };
  assert.equal(declaredCredentials(env, 'p'), null);
  writeFileSync(join(home, 'vm-credentials.json'), '{ not json');
  assert.equal(declaredCredentials(env, 'p'), null);
  write(join(home, 'vm-credentials.json'), { p: { ...GITHUB, ...GITLAB }, q: GITLAB });
  assert.deepEqual(declaredCredentials(env, 'p'), { ...GITHUB, ...GITLAB });
  assert.deepEqual(declaredCredentials(env, 'q'), GITLAB);
  assert.equal(declaredCredentials(env, 'r'), null);
});

// End to end with the real pushAccount: a fake `security` answering only the
// VMs' exact argv for each service (recording every read), and a stub GitHub
// and GitLab; p declares both kinds (read_tokens would read both) but its
// repositories are on GitHub.
const servers = [];
after(() => servers.forEach(s => s.close()));
async function stubForge(body) {
  const requests = [];
  const server = createServer((req, res) => { requests.push({ url: req.url, authorization: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
  servers.push(server);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('ASS-307 AC2: with the real pushAccount a GitHub project never reads the GitLab token nor calls GitLab, and the reverse; no token reaches a file or a logged line', async () => {
  const HUB_TOKEN = 'ghp_NEVERWRITTENHUB', LAB_TOKEN = 'glpat-NEVERWRITTENLAB';
  const bin = mkdtempSync(join(tmpdir(), 'sec-'));
  writeFileSync(join(bin, 'security'), [
    '#!/bin/sh', 'echo "$@" >> "$(dirname "$0")/argv"',
    `[ "$*" = "find-generic-password -s GitHub PAT -w" ] && { echo '${HUB_TOKEN}'; exit 0; }`,
    `[ "$*" = "find-generic-password -s GitLab PAT -w" ] && { echo '${LAB_TOKEN}'; exit 0; }`,
    'exit 44', '',
  ].join('\n'));
  chmodSync(join(bin, 'security'), 0o755);
  const reads = () => (existsSync(join(bin, 'argv')) ? readFileSync(join(bin, 'argv'), 'utf8').trim().split('\n') : []);
  const hub = await stubForge({ login: 'SoftwareAssassin2' }), lab = await stubForge({ username: 'caselaw-bot' });
  const { f, home, check } = checking({ credentials: { p: { ...GITHUB, ...GITLAB }, r: GITLAB } });
  withRepositories(f, 'r', [LAB('a'), LAB('b')]);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, USER: 'me', HARNESS_HOME: home, GITHUB_API_URL: hub.url, GITLAB_API_URL: lab.url };
  f.ctx.env = { ...f.ctx.env, HARNESS_HOME: home };
  f.ctx.pushAccount = args => pushAccount({ ...args, env });
  f.ctx.project = 'p';
  await check();
  assert.deepEqual(reads(), ['find-generic-password -s GitHub PAT -w']);
  assert.deepEqual([hub.requests.length, lab.requests.length], [1, 0]);
  assert.equal(hub.requests[0].authorization, `Bearer ${HUB_TOKEN}`);
  assert.equal(recorded(f, 'p')?.account, 'SoftwareAssassin2');
  f.ctx.project = 'r';
  await check();
  assert.deepEqual(reads(), ['find-generic-password -s GitHub PAT -w', 'find-generic-password -s GitLab PAT -w']);
  assert.deepEqual([hub.requests.length, lab.requests.length], [1, 1]);
  assert.equal(recorded(f, 'r')?.account, 'caselaw-bot');
  assert.equal(recorded(f, 'r')?.provider, 'GitLab');
  assert.equal(recorded(f, 'p')?.provider, 'GitHub');
  for (const token of [HUB_TOKEN, LAB_TOKEN]) {
    assert.ok(!f.lines.join('\n').includes(token));
    const files = dir => readdirSync(dir).flatMap(name => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
    for (const file of [...files(f.dir), ...files(home)]) assert.ok(!readFileSync(file, 'utf8').includes(token), file);
  }
});
