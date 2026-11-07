// Each project's Hindsight (ASS-62): control keeps the Hindsight of every
// project with `hindsight` in project.json running — memory:up when it does
// not answer, backed off while that fails — as it keeps each registry
// (registry.js). agent.sh is a recorder here (memory:up is tested in
// test/agent-cli/memory.test.js); "Hindsight" is an HTTP server on the
// project's port, or nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { controlFixture } from './control-fixture.js';
import { superviseMemory } from '../../src/control/memory.js';
import { tick } from '../../src/control/tick.js';

const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// p with a Hindsight on a free port; agent.sh calls recorded, each answered by answer(args) — an Error to throw, or its stdout.
async function memory(t, { answer = () => JSON.stringify({ provider: 'anthropic' }) } = {}) {
  const f = controlFixture();
  const port = await freePort();
  const file = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), hindsight: { port, 'llm-api-key': null } }, null, 4));
  let now = Date.parse('2026-10-25T12:00:00Z');
  f.ctx.now = () => new Date(now);
  const calls = [];
  f.ctx.cli = async args => { calls.push(args.join(' ')); const out = answer(args); if (out instanceof Error) throw out; return out ?? ''; };
  let server = null;
  t.after(() => server?.close());
  return {
    f, calls, port,
    later: ms => { now += ms; },
    pass: async () => { await superviseMemory(f.ctx, f.ctx.load()); await Promise.all([...f.ctx.memory.hindsight.values()].map(r => r.job)); },
    up: () => new Promise(resolve => { server = createServer((req, res) => res.end('{}')).listen(port, '127.0.0.1', resolve); }),
  };
}
const ups = m => m.calls.filter(c => c === 'memory:up p').length;

test('a project whose Hindsight does not answer gets memory:up, once while it runs, logged with the provider it runs on; one that answers gets none', async t => {
  const m = await memory(t);
  superviseMemory(m.f.ctx, m.f.ctx.load());
  await m.pass();                                                       // the first pass's job still running: not started twice
  assert.equal(ups(m), 1);
  assert.ok(m.f.lines.includes(`memory p: Hindsight was not answering on 127.0.0.1:${m.port}; started it (memory:up, provider anthropic)`), m.f.lines.join('\n'));
  await m.up();
  m.calls.length = 0;
  for (let i = 0; i < 3; i++) { m.later(2000); await m.pass(); }
  assert.deepEqual(m.calls, []);
});

test('with no llm-api-key, the log says Hindsight runs with provider none and where to put the key', async t => {
  const m = await memory(t, { answer: () => JSON.stringify({ provider: 'none' }) });
  await m.pass();
  assert.ok(m.f.lines.includes(`memory p: Hindsight was not answering on 127.0.0.1:${m.port}; started it (memory:up, provider none — no llm-api-key in p's project.json hindsight: retain and recall only, no reflect)`), m.f.lines.join('\n'));
});

test('a failing memory:up is backed off, 30 seconds doubling, each failure logged with its next try; agents still run (AC5)', async t => {
  const m = await memory(t, { answer: args => (args[0] === 'memory:up' ? new Error('memory:up: Hindsight needs Python 3.11 or newer as python3') : '') });
  await m.pass();
  assert.equal(ups(m), 1);
  assert.ok(m.f.lines.some(l => /^error memory p: Hindsight is not answering on 127\.0\.0\.1:\d+ and memory:up failed \(1 in a row; next try in 30s\): memory:up: Hindsight needs Python 3\.11/.test(l)), m.f.lines.join('\n'));
  m.later(29_000); await m.pass();
  assert.equal(ups(m), 1);
  m.later(1000); await m.pass();
  assert.equal(ups(m), 2);
});

test('a project without hindsight is left alone; the tick runs the phase, even under a rate limit', async t => {
  const m = await memory(t);
  const file = join(m.f.dir, 'projects', 'p', 'project.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...json, hindsight: undefined }));
  await m.pass();
  assert.deepEqual(m.calls, []);
  writeFileSync(file, JSON.stringify(json));
  writeFileSync(join(m.f.dir, 'projects', 'p', 'rate-limit.json'), JSON.stringify({ 'resets-at': '2026-10-25T13:00:00Z' }));
  await tick(m.f.ctx);
  await Promise.all([...m.f.ctx.memory.hindsight.values()].map(x => x.job));
  assert.ok(m.calls.includes('memory:up p'), m.calls.join('\n'));
});
