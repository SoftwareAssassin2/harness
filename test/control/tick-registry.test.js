// Each project's image registry (ASS-70): control keeps the zot of every
// project with a `registry` in project.json running — registry:up when it does
// not answer, backed off while that fails — and runs registry:refresh-credentials
// and registry:sweep every 30 minutes. agent.sh is a recorder here (the
// registry commands are tested in test/agent-cli/registry.test.js); "zot" is
// an HTTP server on the project's port, or nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { controlFixture } from './control-fixture.js';
import { superviseRegistries } from '../../src/control/registry.js';
import { tick } from '../../src/control/tick.js';

const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// p with a registry on a free port; agent.sh calls recorded, each answered by fail(args) (an error message) or ''.
async function registry(t, { fail = () => null } = {}) {
  const f = controlFixture();
  const port = await freePort();
  const file = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), registry: { 'storage-path': 'projects/p/registry', 'max-size-gb': 20, port } }, null, 4));
  let now = Date.parse('2026-10-20T12:00:00Z');
  f.ctx.now = () => new Date(now);
  const calls = [];
  f.ctx.cli = async args => { calls.push(args.join(' ')); const error = fail(args); if (error) throw new Error(error); return ''; };
  let zot = null;
  t.after(() => zot?.close());
  return {
    f, calls,
    later: ms => { now += ms; },
    // One pass of the phase, its work awaited.
    pass: async () => { await superviseRegistries(f.ctx, f.ctx.load()); await Promise.all([...f.ctx.memory.registry.values()].map(r => r.job)); },
    zotUp: () => new Promise(resolve => { zot = createServer((req, res) => res.end('{}')).listen(port, '127.0.0.1', resolve); }),
    port,
  };
}

test('a project whose zot does not answer gets registry:up, once while it runs; one that answers gets none', async t => {
  const r = await registry(t);
  superviseRegistries(r.f.ctx, r.f.ctx.load());
  await r.pass();                                                        // the first pass's job still running: not started twice
  assert.deepEqual(r.calls.filter(c => c.startsWith('registry:up')), ['registry:up p']);
  assert.ok(r.f.lines.some(l => l === `registry p: zot was not answering on 127.0.0.1:${r.port}; started it (registry:up)`), r.f.lines.join('\n'));

  await r.zotUp();
  r.calls.length = 0;
  for (let i = 0; i < 3; i++) { r.later(2000); await r.pass(); }
  assert.deepEqual(r.calls, []);
});

test('a failing registry:up is backed off, 30 seconds doubling, each failure logged with its next try', async t => {
  const r = await registry(t, { fail: args => args[0] === 'registry:up' && 'zot did not answer on 127.0.0.1' });
  const ups = () => r.calls.filter(c => c.startsWith('registry:up')).length;
  await r.pass();
  assert.equal(ups(), 1);
  assert.ok(r.f.lines.some(l => /^error registry p: zot is not answering on 127\.0\.0\.1:\d+ and registry:up failed \(1 in a row; next try in 30s\): zot did not answer/.test(l)), r.f.lines.join('\n'));
  r.later(29_000); await r.pass();
  assert.equal(ups(), 1);
  r.later(1000); await r.pass();
  assert.equal(ups(), 2);
  assert.ok(r.f.lines.some(l => /\(2 in a row; next try in 60s\)/.test(l)), r.f.lines.join('\n'));
  r.later(59_000); await r.pass();
  assert.equal(ups(), 2);
  // zot back (started by hand, say): the failures are forgotten.
  await r.zotUp();
  r.later(1000); await r.pass();
  assert.equal(ups(), 2);
  assert.equal(r.f.ctx.memory.registry.get('p').failures, 0);
});

test('registry:refresh-credentials then registry:sweep run on the first pass and every 30 minutes after', async t => {
  const r = await registry(t);
  await r.zotUp();
  const maintenance = () => r.calls.filter(c => /^registry:(refresh-credentials|sweep) p$/.test(c));
  await r.pass();
  assert.deepEqual(maintenance(), ['registry:refresh-credentials p', 'registry:sweep p']);
  r.later(29 * 60e3); await r.pass();
  assert.equal(maintenance().length, 2);
  r.later(60e3); await r.pass();
  assert.equal(maintenance().length, 4);
});

test('a failed credential refresh (gcloud logged out) is logged, and the sweep still runs', async t => {
  const r = await registry(t, { fail: args => args[0] === 'registry:refresh-credentials' && 'registry:refresh-credentials: gcloud is not logged in on this Mac' });
  await r.zotUp();
  await r.pass();
  assert.ok(r.f.lines.some(l => l === 'error registry p registry:refresh-credentials: registry:refresh-credentials: gcloud is not logged in on this Mac'), r.f.lines.join('\n'));
  assert.ok(r.calls.includes('registry:sweep p'));
});

test('a project without a registry is left alone; the tick runs the phase, even under a rate limit', async t => {
  const r = await registry(t);
  const file = join(r.f.dir, 'projects', 'p', 'project.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...json, registry: undefined }));
  await r.pass();
  assert.deepEqual(r.calls, []);
  writeFileSync(file, JSON.stringify(json));                            // the registry back
  writeFileSync(join(r.f.dir, 'projects', 'p', 'rate-limit.json'), JSON.stringify({ 'resets-at': '2026-10-20T13:00:00Z' }));
  await tick(r.f.ctx);
  await Promise.all([...r.f.ctx.memory.registry.values()].map(x => x.job));
  assert.ok(r.calls.includes('registry:up p'), r.calls.join('\n'));
});
