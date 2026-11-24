// ASS-571: control keeps each project's Claude usage token fresh. A login's token lapsed unseen when no agent ran
// Claude Code on the Mac for that config dir, and its usage stopped updating for days. Now, when the token expires
// within 10 minutes or has expired, control has Claude Code renew it (one minimal `claude -p` with that config dir,
// src/agents/usage.js refreshLogin) and the reading goes on; a renewal that fails is recorded and listed by
// project:credentials-status as a warning. Everything here is fake: the keychain (a JSON file of service → item), the
// `claude` that renews (it rewrites the item, as Claude Code does), and the OAuth usage endpoint (a fetch that accepts
// only the current token). No token may show in a log line, a CLI call or any file but the fake keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { controlFixture } from './control-fixture.js';
import { checkUsage } from '../../src/control/usage.js';
import { sessionUsage, loginExpiry, refreshLogin, keychainService } from '../../src/agents/usage.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const OLD = 'fake-old-access-token-0001', NEW = 'fake-new-access-token-0002', REFRESH = 'fake-refresh-token-0003';

// A fake `claude`: with -p it records its arguments and environment, then — FAKE_RENEW=yes — renews the login as
// Claude Code does: the keychain item for its CLAUDE_CONFIG_DIR gets a new access token, expiring in 8 hours.
// FAKE_RENEW=no runs without renewing; FAKE_RENEW=fail exits 1 with a reason.
function fakes() {
  const dir = mkdtempSync(join(tmpdir(), 'usage-refresh-'));
  const keychain = join(dir, 'keychain.json'), calls = join(dir, 'claude-calls.jsonl');
  const claude = join(dir, 'fake-claude.mjs');
  writeFileSync(claude, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const env = process.env;
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), configDir: env.CLAUDE_CONFIG_DIR ?? null,
  apiKey: env.ANTHROPIC_API_KEY ?? null, oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? null, cwd: process.cwd() }) + '\\n');
if (env.FAKE_RENEW === 'fail') { process.stderr.write('OAuth token refresh failed: invalid_grant\\n'); process.exit(1); }
if (env.FAKE_RENEW === 'yes') {
  const service = 'Claude Code-credentials' + (env.CLAUDE_CONFIG_DIR ? '-' + createHash('sha256').update(env.CLAUDE_CONFIG_DIR).digest('hex').slice(0, 8) : '');
  const items = JSON.parse(readFileSync(${JSON.stringify(keychain)}, 'utf8'));
  const item = JSON.parse(items[service]);
  item.claudeAiOauth.accessToken = ${JSON.stringify(NEW)};
  item.claudeAiOauth.expiresAt = Number(env.FAKE_NOW) + 8 * 3600e3;
  items[service] = JSON.stringify(item);
  writeFileSync(${JSON.stringify(keychain)}, JSON.stringify(items));
}
process.stdout.write(JSON.stringify({ type: 'result', result: 'OK' }) + '\\n');
`);
  const save = (configDir, expiresAt) => writeFileSync(keychain, JSON.stringify({
    [keychainService(configDir)]: JSON.stringify({ claudeAiOauth: { accessToken: OLD, refreshToken: REFRESH, expiresAt, scopes: ['user:inference'], subscriptionType: 'max' } }),
  }));
  const readKeychain = async service => JSON.parse(readFileSync(keychain, 'utf8'))[service] ?? null;
  const asked = [];
  // The fake OAuth usage endpoint: only the current access token is accepted.
  const fetch = async (url, { headers }) => {
    asked.push(url);
    const current = JSON.parse(JSON.parse(readFileSync(keychain, 'utf8'))[Object.keys(JSON.parse(readFileSync(keychain, 'utf8')))[0]]).claudeAiOauth.accessToken;
    if (headers.Authorization !== `Bearer ${current}`) return { status: 401, ok: false };
    return { status: 200, ok: true, json: async () => ({ five_hour: { utilization: 12, resets_at: '2026-10-15T13:00:00Z' }, seven_day: { utilization: 40, resets_at: '2026-10-18T03:00:00Z' } }) };
  };
  const claudeCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  return { dir, keychain, claude, save, readKeychain, fetch, asked, claudeCalls };
}

// The control fixture with ctx's usage, loginExpiry and refreshLogin on the fakes, as tick.js wires the real ones.
function control(renew, { expiresIn }) {
  const f = controlFixture();
  const k = fakes();
  let now = Date.parse('2026-10-15T10:00:00Z');
  f.ctx.now = () => new Date(now);
  const config = join(f.dir, 'projects', 'p', '.claude');
  mkdirSync(config);
  k.save(config, now + expiresIn);
  const opts = () => ({ platform: 'darwin', now, readKeychain: k.readKeychain, fetch: k.fetch });
  f.ctx.usage = dir => sessionUsage(dir, opts());
  f.ctx.loginExpiry = dir => loginExpiry(dir, opts());
  f.ctx.refreshLogin = dir => refreshLogin(dir, { command: ['node', k.claude], env: { ...process.env, ...renew(), FAKE_NOW: String(now), ANTHROPIC_API_KEY: 'fake-env-api-key', CLAUDE_CODE_OAUTH_TOKEN: 'fake-env-oauth-token' } });
  const calls = [];
  const cli = f.ctx.cli;
  f.ctx.cli = args => { calls.push(args.join(' ')); return cli(args); };
  return { f, k, calls, config, later: ms => { now += ms; } };
}

const usageOf = f => JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'claude-usage.json'), 'utf8'));
// Every file under dir but those skipped (the fake keychain, and the fake Claude Code that renews it), as text.
function everyFile(dir, ...skip) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip.includes(path)) continue;
    if (statSync(path).isDirectory()) out.push(...everyFile(path, ...skip));
    else out.push([path, readFileSync(path, 'utf8')]);
  }
  return out;
}
function noTokenAnywhere({ f, k, calls }) {
  for (const secret of [OLD, NEW, REFRESH]) {
    for (const line of f.lines) assert.ok(!line.includes(secret), `a token in the log: ${line}`);
    for (const call of calls) assert.ok(!call.includes(secret), `a token in a CLI call: ${call}`);
    for (const [path, text] of [...everyFile(f.dir), ...everyFile(k.dir, k.keychain, k.claude)]) assert.ok(!text.includes(secret), `a token in ${path}`);
  }
}

test('ASS-571 AC1: an expired usage token is renewed by Claude Code (claude -p, the project\'s config dir, no env credentials) and the reading succeeds; logged once; no token outside the keychain', async () => {
  const c = control(() => ({ FAKE_RENEW: 'yes' }), { expiresIn: -3 * 864e5 });
  await checkUsage(c.f.ctx, c.f.ctx.load());
  const [call] = c.k.claudeCalls();
  assert.equal(c.k.claudeCalls().length, 1);
  assert.equal(call.configDir, c.config);
  assert.equal(call.apiKey, null, 'ANTHROPIC_API_KEY would take precedence over the saved login');
  assert.equal(call.oauthToken, null, 'CLAUDE_CODE_OAUTH_TOKEN would take precedence over the saved login');
  assert.deepEqual(call.args.slice(0, 4), ['-p', 'Reply with OK.', '--model', 'haiku']);
  for (const flag of ['--tools', '--strict-mcp-config', '--no-session-persistence']) assert.ok(call.args.includes(flag), flag);
  assert.ok(!call.cwd.startsWith(c.f.dir), 'run from a neutral folder');
  assert.deepEqual(c.f.lines.filter(l => /refreshed/.test(l)), ['usage p: refreshed its Claude login token (expired 2026-10-12T10:00:00Z)']);
  assert.deepEqual(c.calls, ['project:set-claude-usage p fake@example.com 12 2026-10-15T13:00:00Z 40 2026-10-18T03:00:00Z claude.ai Fake Org']);
  assert.equal(usageOf(c.f).failure, undefined);
  assert.equal(JSON.parse(JSON.parse(readFileSync(c.k.keychain, 'utf8'))[keychainService(c.config)]).claudeAiOauth.accessToken, NEW, 'written back to the same item');
  c.later(120_000);
  await checkUsage(c.f.ctx, c.f.ctx.load());
  assert.equal(c.k.claudeCalls().length, 1, 'fresh now: not renewed again');
  noTokenAnywhere(c);
});

test('ASS-571 AC1: a token expiring within 10 minutes is renewed ahead; one further off is never touched', async () => {
  const soon = control(() => ({ FAKE_RENEW: 'yes' }), { expiresIn: 5 * 60e3 });
  await checkUsage(soon.f.ctx, soon.f.ctx.load());
  assert.equal(soon.k.claudeCalls().length, 1);
  assert.deepEqual(soon.f.lines.filter(l => /refreshed/.test(l)), ['usage p: refreshed its Claude login token (expiring 2026-10-15T10:05:00Z)']);
  noTokenAnywhere(soon);
  const later = control(() => ({ FAKE_RENEW: 'yes' }), { expiresIn: 60 * 60e3 });
  await checkUsage(later.f.ctx, later.f.ctx.load());
  assert.equal(later.k.claudeCalls().length, 0);
  assert.equal(usageOf(later.f).session.percent, 12);
});

test('ASS-571 AC2: a renewal that fails is recorded as the failure (figures kept), listed by credentials-status as a warning, not a hold; tried again after 30 minutes; cleared by the next good reading', async () => {
  let renew = 'fail';
  const c = control(() => ({ FAKE_RENEW: renew }), { expiresIn: -60e3 });
  writeFileSync(join(c.f.dir, 'projects', 'p', 'claude-usage.json'), JSON.stringify({ email: 'fake@example.com', session: { percent: 21, 'resets-at': '2026-10-13T13:00:00Z' }, weekly: { percent: 90, 'resets-at': '2026-10-18T03:00:00Z' }, 'auth-method': 'claude.ai', org: 'Fake Org', 'as-of': '2026-10-13T09:00:00Z' }));
  await checkUsage(c.f.ctx, c.f.ctx.load());
  const recorded = usageOf(c.f);
  assert.equal(recorded.failure.why, 'the token has expired; Claude Code could not refresh it (claude -p failed: OAuth token refresh failed: invalid_grant)');
  assert.equal(recorded['as-of'], '2026-10-13T09:00:00Z');
  assert.equal(recorded.session.percent, 21);
  assert.equal(c.f.lines.filter(l => /could not refresh/.test(l) && /^usage p: its Claude login token expired/.test(l)).length, 1, c.f.lines.join('\n'));
  const { stdout } = await run(AGENT, ['project:credentials-status', 'p'], { env: { ...process.env, PROJECTS_DIR: join(c.f.dir, 'projects') } });
  const status = JSON.parse(stdout);
  assert.equal(status.held, false);
  assert.deepEqual(status.problems, []);
  assert.equal(status.warnings.length, 1);
  assert.equal(status.warnings[0].credential, 'the Claude usage token');
  assert.match(status.warnings[0].problem, /could not refresh it/);
  assert.match(status.warnings[0].problem, /last read 2026-10-13T09:00:00Z/);
  assert.match(status.warnings[0].fix, new RegExp(`^CLAUDE_CONFIG_DIR=\\S*projects/p/\\.claude claude .*/login`));
  // Not tried again for that token for 30 minutes; the failure isn't rewritten meanwhile.
  c.later(120_000);
  await checkUsage(c.f.ctx, c.f.ctx.load());
  assert.equal(c.k.claudeCalls().length, 1);
  assert.deepEqual(usageOf(c.f), recorded);
  renew = 'yes';
  c.later(30 * 60e3);
  await checkUsage(c.f.ctx, c.f.ctx.load());
  assert.equal(c.k.claudeCalls().length, 2);
  assert.equal(usageOf(c.f).failure, undefined);
  assert.equal(usageOf(c.f).session.percent, 12);
  const { stdout: after } = await run(AGENT, ['project:credentials-status', 'p'], { env: { ...process.env, PROJECTS_DIR: join(c.f.dir, 'projects') } });
  assert.equal(JSON.parse(after).warnings, undefined);
  noTokenAnywhere(c);
});

test('ASS-571 AC2: Claude Code running but not renewing (the login has ended) records why: sign in again', async () => {
  const c = control(() => ({ FAKE_RENEW: 'no' }), { expiresIn: -60e3 });
  await checkUsage(c.f.ctx, c.f.ctx.load());
  assert.equal(usageOf(c.f).failure.why, 'the token has expired; Claude Code could not refresh it (the token was not renewed: sign in again)');
  noTokenAnywhere(c);
});
