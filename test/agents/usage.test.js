// sessionUsage (ASS-47): a Claude login's 5-hour session usage, read with its
// OAuth token from the usage endpoint. The keychain, the credentials file and
// the endpoint are all fakes here — no test reads a real token or calls out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionUsage, keychainService } from '../../src/agents/usage.js';

const NOW = Date.parse('2026-10-15T10:00:00Z');
const creds = (token = 'tok', expiresAt = NOW + 3600e3) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });
const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const LIVE = { five_hour: { utilization: 7.0, resets_at: '2026-10-15T13:00:00.274615+00:00' }, seven_day: { utilization: 89.0, resets_at: '2026-10-18T03:00:00.281143+00:00', limit_dollars: null } };

test('keychainService: Claude Code-credentials for ~/.claude, with the first 8 hex of sha256(config dir) for another', () => {
  assert.equal(keychainService(undefined), 'Claude Code-credentials');
  assert.equal(keychainService('/Volumes/Data/src/harness/data/projects/harness/.claude'), 'Claude Code-credentials-e6a48406');
  assert.equal(keychainService('/Volumes/Data/src/harness/data/projects/example/.claude'), 'Claude Code-credentials-579610d1');
});

test('sessionUsage on macOS: the keychain token, sent as a Bearer with the oauth beta header; the 5-hour window as { percent, resetsAt }, the 7-day one as weekly (ASS-65), resetsAt ISO UTC', async () => {
  const asked = [], sent = [];
  const got = await sessionUsage('/x/.claude', {
    platform: 'darwin', now: NOW,
    readKeychain: async service => { asked.push(service); return creds('secret'); },
    fetch: async (url, init) => { sent.push({ url, init }); return answer(200, LIVE)(); },
  });
  assert.deepEqual(got, { percent: 7, resetsAt: '2026-10-15T13:00:00Z', weekly: { percent: 89, resetsAt: '2026-10-18T03:00:00Z' } });
  assert.deepEqual(asked, [keychainService('/x/.claude')]);
  assert.equal(sent[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(sent[0].init.method ?? 'GET', 'GET');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(sent[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
});

test('sessionUsage elsewhere: the token from <config dir>/.credentials.json (~/.claude without one)', async () => {
  const read = [];
  const opts = { platform: 'linux', now: NOW, home: '/home/me', fetch: answer(200, LIVE), readFile: path => { read.push(path); return creds(); } };
  await sessionUsage('/x/.claude', opts);
  await sessionUsage(undefined, opts);
  assert.deepEqual(read, ['/x/.claude/.credentials.json', '/home/me/.claude/.credentials.json']);
});

test('sessionUsage fails, saying why, on no token, an expired token (never sent), a 401, or an endpoint it cannot reach', async () => {
  let called = 0;
  const fetch = async () => { called++; return answer(200, LIVE)(); };
  const darwin = keychain => ({ platform: 'darwin', now: NOW, readKeychain: async () => keychain, fetch });
  await assert.rejects(sessionUsage(undefined, darwin(null)), /no token/);
  await assert.rejects(sessionUsage(undefined, darwin('not json')), /no token/);
  await assert.rejects(sessionUsage(undefined, { platform: 'linux', now: NOW, home: '/h', fetch, readFile: () => null }), /no token/);
  await assert.rejects(sessionUsage(undefined, darwin(creds('tok', NOW - 1))), /expired/);
  assert.equal(called, 0);
  await assert.rejects(sessionUsage(undefined, { ...darwin(creds()), fetch: answer(401, {}) }), /refused \(401\)/);
  await assert.rejects(sessionUsage(undefined, { ...darwin(creds()), fetch: answer(500, {}) }), /unavailable \(500\)/);
  await assert.rejects(sessionUsage(undefined, { ...darwin(creds()), fetch: async () => { throw new TypeError('fetch failed'); } }), /unreachable/);
});

test('sessionUsage: a session window the endpoint leaves out reads as nulls', async () => {
  const got = await sessionUsage(undefined, { platform: 'darwin', now: NOW, readKeychain: async () => creds(), fetch: answer(200, { five_hour: null }) });
  assert.deepEqual(got, { percent: null, resetsAt: null, weekly: null });
});

test('sessionUsage: a response without seven_day, or with its resets_at null, is a plan with no weekly cap — weekly null, the session still read (ASS-65)', async () => {
  const read = body => sessionUsage(undefined, { platform: 'darwin', now: NOW, readKeychain: async () => creds(), fetch: answer(200, body) });
  const session = { percent: 7, resetsAt: '2026-10-15T13:00:00Z' };
  assert.deepEqual(await read({ five_hour: LIVE.five_hour }), { ...session, weekly: null });
  assert.deepEqual(await read({ five_hour: LIVE.five_hour, seven_day: null }), { ...session, weekly: null });
  assert.deepEqual(await read({ five_hour: LIVE.five_hour, seven_day: { utilization: 0, resets_at: null } }), { ...session, weekly: null });
});
