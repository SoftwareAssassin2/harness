// The gcloud login check (ASS-28): for a project with check-for-expired-gcloud-auth,
// control asks every 2 minutes whether the user's gcloud login is live
// (gcloud auth print-access-token) and keeps the project's
// gcloud-requires-reauthentication file to it (ASS-58), never project.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { checkGcloud } from '../../src/control/triggers.js';

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
