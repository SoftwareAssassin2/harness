// The glab login check (ASS-61): for a project with check-for-expired-glab-auth,
// control asks every 2 minutes whether glab is authenticated (glab auth status)
// and keeps the project's glab-requires-reauthentication file to it (ASS-58),
// never project.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { controlFixture } from './control-fixture.js';
import { checkGlab, checkGcloud } from '../../src/control/triggers.js';
import { tick, createContext } from '../../src/control/tick.js';

const project = f => join(f.dir, 'projects', 'p', 'project.json');
const read = f => JSON.parse(readFileSync(project(f), 'utf8'));
const edit = (f, change) => { const p = read(f); change(p); writeFileSync(project(f), JSON.stringify(p, null, 4)); };
const flagFile = f => join(f.dir, 'projects', 'p', 'glab-requires-reauthentication');
const flag = f => existsSync(flagFile(f)) ? readFileSync(flagFile(f), 'utf8') : undefined;

function checking(answers, on = true) {
  const f = controlFixture();
  edit(f, p => { if (on != null) p['check-for-expired-glab-auth'] = on; });
  let now = Date.parse('2026-10-14T12:00:00Z');
  f.ctx.now = () => new Date(now);
  const asked = [];
  f.ctx.glab = async () => { asked.push(now); return answers.shift() ?? 'live'; };
  return { f, asked, later: ms => { now += ms; } };
}

test('checkGlab: expired sets the flag, live clears it, asked at most every 2 minutes; each change logged', async () => {
  const { f, asked, later } = checking(['expired', 'live']);
  await checkGlab(f.ctx, f.ctx.load());
  assert.equal(flag(f), 'true');
  later(60_000);
  await checkGlab(f.ctx, f.ctx.load());
  assert.equal(asked.length, 1);                                         // not yet two minutes
  later(60_000);
  await checkGlab(f.ctx, f.ctx.load());
  assert.equal(asked.length, 2);
  assert.equal(flag(f), 'false');
  assert.equal(read(f)['glab-requires-reauthentication'], undefined);         // never written into project.json
  assert.ok(f.lines.some(l => /^glab p: the glab login has expired; run 'glab auth login'$/.test(l)), f.lines.join('\n'));
  assert.ok(f.lines.some(l => /^glab p: the glab login is live again$/.test(l)), f.lines.join('\n'));
});

test('checkGlab: a check that cannot run leaves the flag as it is, logged once', async () => {
  const { f, later } = checking(['unavailable', 'unavailable']);
  writeFileSync(flagFile(f), 'true');
  await checkGlab(f.ctx, f.ctx.load());
  later(120_000);
  await checkGlab(f.ctx, f.ctx.load());
  assert.equal(flag(f), 'true');
  assert.equal(f.lines.filter(l => /glab p: glab cannot be run/.test(l)).length, 1, f.lines.join('\n'));
});

test('checkGlab: a project with check-for-expired-glab-auth false or absent is never checked', async () => {
  for (const on of [false, null]) {
    const { f, asked } = checking(['expired'], on);
    await checkGlab(f.ctx, f.ctx.load());
    assert.deepEqual(asked, []);
    assert.equal(flag(f), undefined);
  }
});

test('checkGlab and the gcloud check keep their own clocks: one asked does not hold off the other', async () => {
  const { f, asked } = checking(['expired']);
  edit(f, p => { p['check-for-expired-gcloud-auth'] = true; });
  f.ctx.gcloud = async () => 'live';
  await checkGcloud(f.ctx, f.ctx.load());
  await checkGlab(f.ctx, f.ctx.load());
  assert.equal(asked.length, 1);
});

test('a tick runs the glab check', async () => {
  const { f, asked } = checking(['expired']);
  try {
    await f.agent('assignments:pause', 'all', 'human');                 // nothing dispatched
    await tick(f.ctx);
    assert.equal(asked.length, 1);
    assert.equal(flag(f), 'true');
  } finally {
    f.ctx.stopAgents();
  }
});

test('glab() asks glab auth status, read-only: exit 0 is live, any other exit expired, no glab unavailable', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'glab-'));
  const calls = join(bin, 'calls');
  writeFileSync(join(bin, 'glab'), `#!/bin/sh\necho "$*" >> '${calls}'\nexit "$(cat '${bin}/exit')"\n`);
  chmodSync(join(bin, 'glab'), 0o755);
  const ctx = createContext({ root: '/nowhere' });
  const path = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${path}`;
    writeFileSync(join(bin, 'exit'), '0');
    assert.equal(await ctx.glab(), 'live');
    writeFileSync(join(bin, 'exit'), '1');
    assert.equal(await ctx.glab(), 'expired');
    assert.equal(readFileSync(calls, 'utf8'), 'auth status\nauth status\n');
    process.env.PATH = mkdtempSync(join(tmpdir(), 'empty-'));
    assert.equal(await ctx.glab(), 'unavailable');
  } finally { process.env.PATH = path; }
});

