// The gcloud login check (ASS-28): for a project with check-for-expired-gcloud-auth,
// control asks every 2 minutes whether the user's gcloud login is live
// (gcloud auth print-access-token) and keeps the project's
// gcloud-requires-reauthentication file to it (ASS-58), never project.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { controlFixture } from './control-fixture.js';
import { checkGcloud } from '../../src/control/triggers.js';
import { createContext } from '../../src/control/tick.js';

const project = f => join(f.dir, 'projects', 'p', 'project.json');
const read = f => JSON.parse(readFileSync(project(f), 'utf8'));
const edit = (f, change) => { const p = read(f); change(p); writeFileSync(project(f), JSON.stringify(p, null, 4)); };
const flagFile = f => join(f.dir, 'projects', 'p', 'gcloud-requires-reauthentication');
const flag = f => existsSync(flagFile(f)) ? readFileSync(flagFile(f), 'utf8') : undefined;

function checking(answers, on = true) {
  const f = controlFixture();
  edit(f, p => { if (on != null) p['check-for-expired-gcloud-auth'] = on; });
  let now = Date.parse('2026-10-14T12:00:00Z');
  f.ctx.now = () => new Date(now);
  const asked = [];
  f.ctx.gcloud = async () => { asked.push(now); return answers.shift() ?? 'live'; };
  return { f, asked, later: ms => { now += ms; } };
}

test('checkGcloud: expired sets the flag, live clears it, asked at most every 2 minutes; each change logged', async () => {
  const { f, asked, later } = checking(['expired', 'live']);
  await checkGcloud(f.ctx, f.ctx.load());
  assert.equal(flag(f), 'true');
  later(60_000);
  await checkGcloud(f.ctx, f.ctx.load());
  assert.equal(asked.length, 1);                                         // not yet two minutes
  later(60_000);
  await checkGcloud(f.ctx, f.ctx.load());
  assert.equal(asked.length, 2);
  assert.equal(flag(f), 'false');
  assert.equal(read(f)['gcloud-requires-reauthentication'], undefined);         // never written into project.json
  assert.ok(f.lines.some(l => /^gcloud p: the gcloud login has expired; run 'gcloud auth login'$/.test(l)), f.lines.join('\n'));
  assert.ok(f.lines.some(l => /^gcloud p: the gcloud login is live again$/.test(l)), f.lines.join('\n'));
});

test('checkGcloud: a check that cannot run leaves the flag as it is, logged once', async () => {
  const { f, later } = checking(['unavailable', 'unavailable']);
  writeFileSync(flagFile(f), 'true');
  await checkGcloud(f.ctx, f.ctx.load());
  later(120_000);
  await checkGcloud(f.ctx, f.ctx.load());
  assert.equal(flag(f), 'true');
  assert.equal(f.lines.filter(l => /gcloud p: gcloud cannot be run/.test(l)).length, 1, f.lines.join('\n'));
});

test('checkGcloud: a project with check-for-expired-gcloud-auth false or absent is never checked', async () => {
  for (const on of [false, null]) {
    const { f, asked } = checking(['expired'], on);
    await checkGcloud(f.ctx, f.ctx.load());
    assert.deepEqual(asked, []);
    assert.equal(flag(f), undefined);
  }
});

test('checkGcloud: compares against the file — no write while it already matches the login', async () => {
  const { f, later } = checking(['expired', 'live']);
  writeFileSync(flagFile(f), 'true');
  const calls = [];
  const cli = f.ctx.cli;
  f.ctx.cli = args => { calls.push(args.join(' ')); return cli(args); };
  await checkGcloud(f.ctx, f.ctx.load());
  assert.deepEqual(calls, []);                                           // expired, and the file already says so
  later(120_000);
  await checkGcloud(f.ctx, f.ctx.load());
  assert.deepEqual(calls, ['project:set-gcloud-reauthentication p false']);
  assert.equal(flag(f), 'false');
});

// gcloud's stderr as seen on the operator's Mac (ASS-429).
const REAUTH = 'ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.\nPlease run:\n\n  $ gcloud auth login\n\nto obtain new credentials.';
const OFFLINE = "ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded with url: /token (Caused by NameResolutionError(\"<urllib3.connection.HTTPSConnection object at 0x10>: Failed to resolve 'oauth2.googleapis.com' ([Errno 8] nodename nor servname provided, or not known)\"))";
const STRANGE = 'ERROR: (gcloud.auth.print-access-token) Something new went wrong.';

test('ASS-429 AC1/AC2/AC5: live, expired, offline: offline leaves the flag as it was either way, logged once as a network problem, never "run gcloud auth login"', async () => {
  const offline = { login: 'offline', output: 'Failed to resolve oauth2.googleapis.com' };
  const { f, later } = checking(['live', offline, offline, { login: 'expired', output: 'Reauthentication failed.' }, offline, 'live']);
  const step = async () => { await checkGcloud(f.ctx, f.ctx.load()); later(120_000); return flag(f); };
  assert.equal(await step(), undefined);                                 // live, and nothing to change
  assert.equal(await step(), undefined);                                 // offline: no file written, nothing held
  assert.equal(await step(), undefined);
  assert.equal(await step(), 'true');                                    // gcloud says it expired
  assert.equal(await step(), 'true');                                    // offline keeps it
  assert.equal(await step(), 'false');
  const network = f.lines.filter(l => /^gcloud p: gcloud could not reach Google, a network problem, not an expired login; the warning stays as it is \(Failed to resolve oauth2\.googleapis\.com\)$/.test(l));
  assert.equal(network.length, 2, f.lines.join('\n'));                   // once per streak
  assert.equal(f.lines.filter(l => /run 'gcloud auth login'/.test(l)).length, 1, f.lines.join('\n'));
});

test('ASS-429 AC3/AC5: an unknown failure is logged with its output and counted as expired; logged again only when the output changes', async () => {
  const { f, later } = checking([{ login: 'unknown', output: 'Something new went wrong.' }, { login: 'unknown', output: 'Something new went wrong.' }, { login: 'unknown', output: 'Another thing.' }]);
  for (let i = 0; i < 3; i++) { await checkGcloud(f.ctx, f.ctx.load()); later(120_000); }
  assert.equal(flag(f), 'true');
  assert.equal(f.lines.filter(l => l === "gcloud p: the gcloud login has expired; run 'gcloud auth login'").length, 1, f.lines.join('\n'));
  assert.deepEqual(f.lines.filter(l => /does not say/.test(l)), [
    'gcloud p: gcloud failed for a reason it does not say is an expiry or a network problem; counted as expired: Something new went wrong.',
    'gcloud p: gcloud failed for a reason it does not say is an expiry or a network problem; counted as expired: Another thing.',
  ]);
});

test('ASS-429 AC5: gcloud() reads print-access-token\'s failure: exit 0 live (the token never returned), the reauthentication message expired, a name that did not resolve offline, anything else unknown with its stderr', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'gcloud-'));
  writeFileSync(join(bin, 'gcloud'), `#!/bin/sh\n[ "$*" = 'auth print-access-token' ] || exit 9\nif [ -e '${bin}/stderr' ]; then cat '${bin}/stderr' >&2; exit 1; fi\necho ya29.secret-token-value\n`);
  chmodSync(join(bin, 'gcloud'), 0o755);
  const ctx = createContext({ root: '/nowhere' });
  const path = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${path}`;
    assert.equal(await ctx.gcloud(), 'live');
    writeFileSync(join(bin, 'stderr'), REAUTH);
    assert.equal((await ctx.gcloud()).login, 'expired');
    writeFileSync(join(bin, 'stderr'), OFFLINE);
    assert.equal((await ctx.gcloud()).login, 'offline');
    writeFileSync(join(bin, 'stderr'), `${STRANGE}\n  token ya29.leaked-token-value\n`);
    assert.deepEqual(await ctx.gcloud(), { login: 'unknown', output: 'ERROR: (gcloud.auth.print-access-token) Something new went wrong. token [token]' });
  } finally { process.env.PATH = path; }
});
