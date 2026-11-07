// The Anthropic API cost check (ASS-153): control reads the API
// organization's month-to-date spend about hourly (ctx.apiCost — a fake here,
// or monthCost against a fake `security` and a stub endpoint; never the real
// keychain or API), kept in data/api-cost.json by harness:set-api-cost.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { controlFixture } from './control-fixture.js';
import { checkApiCost } from '../../src/control/api-cost.js';
import { tick, createContext } from '../../src/control/tick.js';
import { monthCost } from '../../src/agents/api-cost.js';

const HOUR = 3600e3;
const costFile = f => f.env.API_COST_FILE;
const cost = f => (existsSync(costFile(f)) ? JSON.parse(readFileSync(costFile(f), 'utf8')) : undefined);
const reading = (month, usd) => async () => ({ month, usd });
const failing = message => async () => { throw new Error(message); };

function checking(answers) {
  const f = controlFixture();
  let now = Date.parse('2026-10-26T13:00:00Z');
  f.ctx.now = () => new Date(now);
  const asked = [];
  f.ctx.apiCost = async (at, service) => { asked.push(service ? `${at.toISOString()} ${service}` : at.toISOString()); return (answers.shift() ?? reading('2026-10', 1))(); };
  const calls = [];
  const cli = f.ctx.cli;
  f.ctx.cli = args => { calls.push(args.join(' ')); return cli(args); };
  return { f, asked, calls, later: ms => { now += ms; } };
}

test('checkApiCost: a reading is recorded in api-cost.json, asked at most hourly and refreshed after', async () => {
  const { f, asked, calls, later } = checking([reading('2026-10', 12.34), reading('2026-10', 15)]);
  await checkApiCost(f.ctx, f.ctx.load());
  assert.deepEqual(calls, ['harness:set-api-cost 2026-10 12.34']);
  assert.deepEqual({ ...cost(f), 'as-of': 'x' }, { month: '2026-10', usd: 12.34, 'as-of': 'x' });
  later(HOUR - 1000);
  await checkApiCost(f.ctx, f.ctx.load());
  assert.equal(asked.length, 1);                                          // not yet an hour
  later(1000);
  await checkApiCost(f.ctx, f.ctx.load());
  assert.deepEqual(asked, ['2026-10-26T13:00:00.000Z', '2026-10-26T14:00:00.000Z']);
  assert.equal(cost(f).usd, 15);
});

test('checkApiCost: a failed reading keeps the last value, logged once per failure streak; a success ends the streak', async () => {
  const { f, calls, later } = checking([reading('2026-10', 12.34), failing('the cost endpoint is unavailable (500)'), failing('the cost endpoint is unreachable'), reading('2026-10', 13), failing('no admin key in the keychain')]);
  await checkApiCost(f.ctx, f.ctx.load());
  const kept = cost(f);
  for (let i = 0; i < 4; i++) { later(HOUR); await checkApiCost(f.ctx, f.ctx.load()); }
  assert.deepEqual(calls, ['harness:set-api-cost 2026-10 12.34', 'harness:set-api-cost 2026-10 13']);
  const logged = f.lines.filter(l => l.startsWith('api-cost '));
  assert.deepEqual(logged, [
    'api-cost the Anthropic API cost cannot be read (the cost endpoint is unavailable (500)); the last value stays',
    'api-cost the Anthropic API cost cannot be read (no admin key in the keychain); the last value stays',
  ]);
  assert.equal(kept.usd, 12.34);
  assert.equal(cost(f).usd, 13);                                           // the failure after it left 13
});

test('checkApiCost: a control of one project reads it only for the harness project; the all-projects control always', async () => {
  const { f, asked } = checking([]);
  f.ctx.project = 'p';
  await checkApiCost(f.ctx, f.ctx.load());
  assert.equal(asked.length, 0);
  writeFileSync(join(f.dir, 'harness.json'), JSON.stringify({ ...f.harness(), 'harness-project': 'p' }));
  await checkApiCost(f.ctx, f.ctx.load());
  assert.equal(asked.length, 1);
});

// A project naming its own org's admin key (ASS-221): api-cost-admin-keychain-service in its project.json.
const projectFile = f => join(f.dir, 'projects', 'p', 'project.json');
const ownKey = (f, service = 'example-admin-key') => writeFileSync(projectFile(f), JSON.stringify({ ...JSON.parse(readFileSync(projectFile(f), 'utf8')), 'api-cost-admin-keychain-service': service }));
const projectCost = f => { const file = join(f.dir, 'projects', 'p', 'api-cost.json'); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined; };

test('ASS-221 AC2: a project with api-cost-admin-keychain-service is read with that key, hourly, into its own api-cost.json; one without is never read for it', async () => {
  const { f, asked, calls, later } = checking([reading('2026-10', 1), reading('2026-10', 7.5), reading('2026-10', 2), reading('2026-10', 8)]);
  f.ctx.project = 'p';                                                     // a control of one project, not the harness project
  await checkApiCost(f.ctx, f.ctx.load());
  assert.deepEqual(asked, []);                                             // no admin key of its own: nothing borrowed
  ownKey(f);
  await checkApiCost(f.ctx, f.ctx.load());
  assert.deepEqual(asked, ['2026-10-26T13:00:00.000Z example-admin-key']);
  assert.deepEqual(calls, ['project:set-api-cost p 2026-10 1']);
  assert.deepEqual({ ...projectCost(f), 'as-of': 'x' }, { month: '2026-10', usd: 1, 'as-of': 'x' });
  assert.equal(cost(f), undefined);                                        // the harness org's file untouched
  later(HOUR - 1000);
  await checkApiCost(f.ctx, f.ctx.load());
  assert.equal(asked.length, 1);                                           // not yet an hour
  later(1000);
  await checkApiCost(f.ctx, f.ctx.load());
  assert.equal(projectCost(f).usd, 7.5);
  // The all-projects control reads the harness org's and each keyed project's, each with its own key.
  const g = checking([reading('2026-10', 3), reading('2026-10', 4)]);
  ownKey(g.f);
  await checkApiCost(g.f.ctx, g.f.ctx.load());
  assert.deepEqual(g.asked, ['2026-10-26T13:00:00.000Z', '2026-10-26T13:00:00.000Z example-admin-key']);
  assert.deepEqual(g.calls, ['harness:set-api-cost 2026-10 3', 'project:set-api-cost p 2026-10 4']);
});

test('ASS-221 AC2: a project\'s failed reading keeps its last value, logged once per streak, apart from the harness org\'s', async () => {
  const { f, calls, later } = checking([reading('2026-10', 5), failing('the admin key was refused (401)'), failing('the admin key was refused (401)')]);
  f.ctx.project = 'p';
  ownKey(f);
  await checkApiCost(f.ctx, f.ctx.load());
  for (let i = 0; i < 2; i++) { later(HOUR); await checkApiCost(f.ctx, f.ctx.load()); }
  assert.deepEqual(calls, ['project:set-api-cost p 2026-10 5']);
  assert.equal(projectCost(f).usd, 5);
  assert.deepEqual(f.lines.filter(l => l.startsWith('api-cost ')), ['api-cost p: the Anthropic API cost cannot be read (the admin key was refused (401)); the last value stays']);
});

test('checkApiCost runs in every tick; a context made with ANTHROPIC_API_COST_DISABLED=1 (the fixtures\' env) has no apiCost, and nothing is read', async () => {
  const { f, asked } = checking([reading('2026-10', 2)]);
  await tick(f.ctx);
  assert.equal(asked.length, 1);
  assert.equal(cost(f).usd, 2);
  assert.equal(controlFixture().ctx.apiCost, null);
  const off = createContext({ root: '/nowhere', env: { ANTHROPIC_API_COST_DISABLED: '1' } });
  assert.equal(off.apiCost, null);
  await checkApiCost(off, { projects: [{ id: 'p', json: { 'api-cost-admin-keychain-service': 'k' } }], harness: {} });                 // returns without asking anything
  assert.equal(typeof createContext({ root: '/nowhere', env: {} }).apiCost, 'function');
});

// End to end with the real monthCost: a fake `security` holding a key and a
// stub endpoint answering, then failing; the key reaches no file the check
// writes and no line it logs.
const servers = [];
after(() => servers.forEach(s => s.close()));
test('checkApiCost with monthCost: the admin key is never written to a file or logged, through a success and a failure', async () => {
  const KEY = 'sk-ant-admin01-NEVERWRITTEN';
  const bin = mkdtempSync(join(tmpdir(), 'sec-'));
  writeFileSync(join(bin, 'security'), `#!/bin/sh\necho '${KEY}'\n`);
  chmodSync(join(bin, 'security'), 0o755);
  const answers = [{ status: 200, body: { data: [{ starting_at: '2026-10-01T00:00:00Z', results: [{ amount: '1234' }] }], has_more: false } }, { status: 401, body: { error: KEY } }];
  const server = createServer((req, res) => { const { status, body } = answers.shift(); res.writeHead(status); res.end(JSON.stringify(body)); });
  servers.push(server);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const f = controlFixture();
  let now = Date.parse('2026-10-26T13:00:00Z');
  f.ctx.now = () => new Date(now);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, USER: 'me', ANTHROPIC_ADMIN_API_URL: `http://127.0.0.1:${server.address().port}` };
  f.ctx.apiCost = at => monthCost({ now: at, env });
  await checkApiCost(f.ctx, f.ctx.load());
  now += HOUR;
  await checkApiCost(f.ctx, f.ctx.load());
  assert.equal(cost(f).usd, 12.34);
  assert.equal(f.lines.filter(l => l.startsWith('api-cost ')).length, 1);
  assert.ok(!f.lines.join('\n').includes(KEY));
  const files = dir => readdirSync(dir).flatMap(name => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
  for (const file of files(f.dir)) assert.ok(!readFileSync(file, 'utf8').includes(KEY), file);
});

test('ASS-221 AC3: a project\'s admin key, read from the keychain item it names at check time, is never written to a file or logged', async () => {
  const KEY = 'sk-ant-admin01-PROJECTNEVERWRITTEN';
  const bin = mkdtempSync(join(tmpdir(), 'sec-'));
  writeFileSync(join(bin, 'security'), `#!/bin/sh\n[ "$*" = "find-generic-password -s example-admin-key -a me -w" ] || exit 44\necho '${KEY}'\n`);
  chmodSync(join(bin, 'security'), 0o755);
  const answers = [{ status: 200, body: { data: [{ starting_at: '2026-10-01T00:00:00Z', results: [{ amount: '392' }] }], has_more: false } }, { status: 401, body: { error: KEY } }];
  const server = createServer((req, res) => { const { status, body } = answers.shift(); res.writeHead(status); res.end(JSON.stringify(body)); });
  servers.push(server);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const f = controlFixture();
  f.ctx.project = 'p';
  ownKey(f);
  let now = Date.parse('2026-10-26T13:00:00Z');
  f.ctx.now = () => new Date(now);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, USER: 'me', ANTHROPIC_ADMIN_API_URL: `http://127.0.0.1:${server.address().port}` };
  f.ctx.apiCost = (at, service) => monthCost({ now: at, env, service });
  await checkApiCost(f.ctx, f.ctx.load());
  now += HOUR;
  await checkApiCost(f.ctx, f.ctx.load());
  assert.equal(projectCost(f).usd, 3.92);
  assert.equal(f.lines.filter(l => l.startsWith('api-cost ')).length, 1);
  assert.ok(!f.lines.join('\n').includes(KEY));
  const files = dir => readdirSync(dir).flatMap(name => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
  for (const file of files(f.dir)) assert.ok(!readFileSync(file, 'utf8').includes(KEY), file);
});
