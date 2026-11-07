// The Claude usage check (ASS-47): for every project, control reads its
// login's session and weekly usage (ASS-65) every 2 minutes (ctx.usage — a fake here, never the
// real endpoint or keychain) and its account (claude auth status — the fake
// agent's), kept in the project's claude-usage.json by project:set-claude-usage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { checkUsage } from '../../src/control/usage.js';
import { tick, createContext } from '../../src/control/tick.js';

const usageFile = f => join(f.dir, 'projects', 'p', 'claude-usage.json');
const usage = f => existsSync(usageFile(f)) ? JSON.parse(readFileSync(usageFile(f), 'utf8')) : undefined;
const WEEK = { percent: 89, resetsAt: '2026-10-18T03:00:00Z' };
const reading = (percent, resetsAt, weekly = WEEK) => async () => ({ percent, resetsAt, weekly });
const refused = async () => { throw new Error('the token was refused (401)'); };
const noToken = async () => { throw new Error('no token'); };

function checking(answers) {
  const f = controlFixture();
  let now = Date.parse('2026-10-15T10:00:00Z');
  f.ctx.now = () => new Date(now);
  const asked = [];
  f.ctx.usage = async dir => { asked.push(dir); return (answers.shift() ?? reading(1, '2026-10-15T13:00:00Z'))(); };
  const calls = [];
  const cli = f.ctx.cli;
  f.ctx.cli = args => { calls.push(args.join(' ')); return cli(args); };
  return { f, asked, calls, later: ms => { now += ms; } };
}

test('checkUsage: a reading — both windows — is recorded with the login\'s email, asked at most every 2 minutes and refreshed after', async () => {
  const { f, asked, calls, later } = checking([reading(7, '2026-10-15T13:00:00Z'), reading(12.5, '2026-10-15T13:00:00Z')]);
  await checkUsage(f.ctx, f.ctx.load());
  assert.deepEqual(calls, ['project:set-claude-usage p fake@example.com 7 2026-10-15T13:00:00Z 89 2026-10-18T03:00:00Z claude.ai Fake Org']);
  assert.deepEqual({ ...usage(f), 'as-of': 'x' }, { email: 'fake@example.com', session: { percent: 7, 'resets-at': '2026-10-15T13:00:00Z' }, weekly: { percent: 89, 'resets-at': '2026-10-18T03:00:00Z' }, 'auth-method': 'claude.ai', org: 'Fake Org', 'as-of': 'x' });
  later(60_000);
  await checkUsage(f.ctx, f.ctx.load());
  assert.equal(asked.length, 1);                                         // not yet two minutes
  later(60_000);
  await checkUsage(f.ctx, f.ctx.load());
  assert.equal(asked.length, 2);
  assert.equal(usage(f).session.percent, 12.5);
  assert.deepEqual(usage(f).weekly, { percent: 89, 'resets-at': '2026-10-18T03:00:00Z' });
  assert.equal(asked[0], undefined);                                     // no projects/p/.claude: the shared ~/.claude
});

test('checkUsage: reads the project\'s own login when it has a projects/<id>/.claude', async () => {
  const { f, asked } = checking([]);
  mkdirSync(join(f.dir, 'projects', 'p', '.claude'));
  await checkUsage(f.ctx, f.ctx.load());
  assert.equal(realpathSync(asked[0]), realpathSync(join(f.dir, 'projects', 'p', '.claude')));
});

test('checkUsage: a reading with no weekly window (a plan with no weekly cap) records weekly null beside the session (ASS-65)', async () => {
  const { f, calls } = checking([reading(7, '2026-10-15T13:00:00Z', null)]);
  writeFileSync(usageFile(f), JSON.stringify({ email: 'fake@example.com', session: { percent: 1, 'resets-at': '2026-10-15T13:00:00Z' }, weekly: { percent: 50, 'resets-at': '2026-10-18T03:00:00Z' }, 'as-of': '2026-10-15T09:58:00Z' }));
  await checkUsage(f.ctx, f.ctx.load());
  assert.deepEqual(calls, ['project:set-claude-usage p fake@example.com 7 2026-10-15T13:00:00Z - - claude.ai Fake Org']);
  assert.equal(usage(f).weekly, null);
});

test('checkUsage: a refused (401) reading leaves the last claude-usage as it was, logged once per cause; the check goes on', async () => {
  const { f, calls, later } = checking([reading(7, '2026-10-15T13:00:00Z'), refused, refused, noToken]);
  await checkUsage(f.ctx, f.ctx.load());
  const kept = usage(f);
  later(120_000);
  await checkUsage(f.ctx, f.ctx.load());
  later(120_000);
  await checkUsage(f.ctx, f.ctx.load());
  assert.deepEqual(usage(f), kept);                                      // as-of too: nothing rewritten
  assert.equal(calls.length, 1);
  assert.equal(f.lines.filter(l => l === 'usage p: the Claude session usage cannot be read (the token was refused (401)); the last reading stays').length, 1, f.lines.join('\n'));
  later(120_000);
  await checkUsage(f.ctx, f.ctx.load());
  assert.equal(f.lines.filter(l => /^usage p: .*\(no token\)/.test(l)).length, 1, f.lines.join('\n'));   // a new cause, logged
});

test('checkUsage: a project with no token and no reading yet gets its email, the session left null', async () => {
  const { f, calls } = checking([noToken]);
  await checkUsage(f.ctx, f.ctx.load());
  assert.deepEqual(calls, ['project:set-claude-usage p fake@example.com - - - - claude.ai Fake Org']);
  assert.deepEqual(usage(f).session, { percent: null, 'resets-at': null });
  assert.equal(usage(f).weekly, null);
});

test('checkUsage: a failed reading under a new email writes the email and passes the last session and weekly back', async () => {
  const { f, calls } = checking([refused]);
  writeFileSync(usageFile(f), JSON.stringify({ email: 'old@example.com', session: { percent: 42, 'resets-at': '2026-10-15T13:00:00Z' }, weekly: { percent: 89, 'resets-at': '2026-10-18T03:00:00Z' }, 'as-of': '2026-10-15T09:58:00Z' }));
  await checkUsage(f.ctx, f.ctx.load());
  assert.deepEqual(calls, ['project:set-claude-usage p fake@example.com 42 2026-10-15T13:00:00Z 89 2026-10-18T03:00:00Z claude.ai Fake Org']);
  const g = checking([refused]);                                         // one recorded before ASS-65: no weekly, passed back as -
  writeFileSync(usageFile(g.f), JSON.stringify({ email: 'old@example.com', session: { percent: 42, 'resets-at': '2026-10-15T13:00:00Z' }, 'as-of': '2026-10-15T09:58:00Z' }));
  await checkUsage(g.f.ctx, g.f.ctx.load());
  assert.deepEqual(g.calls, ['project:set-claude-usage p fake@example.com 42 2026-10-15T13:00:00Z - - claude.ai Fake Org']);
});

test('checkUsage: a login that is not logged in gets email and session null, the endpoint never asked', async () => {
  const { f, asked, calls } = checking([]);
  f.ctx.env = { ...f.ctx.env, FAKE_AUTH: 'logged-out' };
  writeFileSync(usageFile(f), JSON.stringify({ email: 'old@example.com', session: { percent: 42, 'resets-at': '2026-10-15T13:00:00Z' }, 'as-of': '2026-10-15T09:58:00Z' }));
  await checkUsage(f.ctx, f.ctx.load());
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, ['project:set-claude-usage p - - - - - - -']);
});

test('ASS-221 AC1: an api_key login (FAKE_AUTH=api-key) records its auth method and org, session and weekly -, its usage never asked; a broken auth status keeps the last auth method and org', async () => {
  const { f, asked, calls, later } = checking([]);
  f.ctx.env = { ...f.ctx.env, FAKE_AUTH: 'api-key' };
  await checkUsage(f.ctx, f.ctx.load());
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, ['project:set-claude-usage p fake@example.com - - - - api_key Fake Org']);
  assert.deepEqual({ ...usage(f), 'as-of': 'x' }, { email: 'fake@example.com', session: { percent: null, 'resets-at': null }, weekly: null, 'auth-method': 'api_key', org: 'Fake Org', 'as-of': 'x' });
  f.ctx.env = { ...f.ctx.env, FAKE_AUTH: 'broken' };
  later(120_000);
  await checkUsage(f.ctx, f.ctx.load());
  assert.deepEqual(asked, []);                                           // still billed to its API key
  assert.deepEqual(calls, [calls[0], calls[0]]);                         // the last email, auth method and org kept
});

test('checkUsage runs in every tick; a context made with CLAUDE_USAGE_DISABLED=1 (the fixtures\' env) has no usage, and nothing is read', async () => {
  const { f, asked } = checking([]);
  await tick(f.ctx);
  assert.equal(asked.length, 1);
  assert.equal(usage(f).email, 'fake@example.com');
  const off = createContext({ root: '/nowhere', env: { CLAUDE_USAGE_DISABLED: '1' } });
  assert.equal(off.usage, null);
  await checkUsage(off, { projects: [{ id: 'p', json: {} }] });       // returns without asking anything
  assert.equal(typeof createContext({ root: '/nowhere', env: {} }).usage, 'function');
});
