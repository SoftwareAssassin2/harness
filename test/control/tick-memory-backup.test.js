// Each project's memory backed up daily by control (ASS-148): memory:backup
// (tested in test/agent-cli/memory-backup.test.js) run once a day per
// project with a Hindsight, against the stub Hindsight
// (test/support/fake-hindsight.js); the backups land in the fixture's own
// folder (its HINDSIGHT_DIR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { backupMemory } from '../../src/control/memory-backup.js';
import { fakeHindsight } from '../support/fake-hindsight.js';

const HOUR = 3600e3;

// The control fixture with p's Hindsight the stub, its bank p one memory; the clock `now`.
async function setup(t) {
  const f = controlFixture();
  const h = await fakeHindsight();
  t.after(() => h.close());
  h.banks.set('p', [{ id: 'u', text: 'a lesson', document_id: 'd', metadata: {} }]);
  const file = join(f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), hindsight: { port: h.port, 'llm-api-key': null } }));
  let now = Date.parse('2026-10-26T12:00:00Z');
  f.ctx.now = () => new Date(now);
  const folder = join(f.dir, 'hindsight-install', 'hindsight-backups', 'p');
  return {
    f, h, folder,
    later: ms => { now += ms; },
    exports: () => h.requests.filter(r => r.path === '/v1/default/banks/p/transfer/export').length,
    // One phase, its backups awaited.
    pass: async () => { backupMemory(f.ctx, f.ctx.load()); await Promise.all(f.ctx.memory.backups?.values() ?? []); },
    archives: () => readdirSync(folder).filter(n => /^\d{8}T\d{6}Z\.zip$/.test(n)).sort(),
  };
}

test('AC1: control backs each project\'s bank up through memory:backup at once when it has none, then daily, keeping the last 14; the tick runs the phase, even under a rate limit', async t => {
  const s = await setup(t);
  writeFileSync(join(s.f.dir, 'projects', 'p', 'rate-limit.json'), JSON.stringify({ 'resets-at': '2026-10-26T13:00:00Z' }));
  mkdirSync(s.folder, { recursive: true });
  const old = Array.from({ length: 14 }, (_, i) => `202610${String(i + 1).padStart(2, '0')}T030000Z.zip`);
  for (const name of old) writeFileSync(join(s.folder, name), 'old');
  await tick(s.f.ctx);
  await Promise.all(s.f.ctx.memory.backups.values());
  assert.equal(s.exports(), 1);
  assert.equal(s.archives().length, 14);
  assert.ok(!s.archives().includes(old[0]));
  assert.ok(s.f.lines.some(l => /^memory p: backed up its memory to .*hindsight-backups\/p\/\d{8}T\d{6}Z\.zip; removed 1 older backup$/.test(l)), s.f.lines.join('\n'));
  s.later(23 * HOUR); await s.pass();
  assert.equal(s.exports(), 1);
  s.later(HOUR); await s.pass();
  assert.equal(s.exports(), 2);
});

test('a control that starts counts the day from the latest backup on disk, not from its own start', async t => {
  const s = await setup(t);
  mkdirSync(s.folder, { recursive: true });
  writeFileSync(join(s.folder, '20261026T110000Z.zip'), 'an hour ago');
  writeFileSync(join(s.folder, 'pre-restore-20261026T115900Z.zip'), 'not a daily backup');
  await s.pass();
  assert.equal(s.exports(), 0);
  s.later(22 * HOUR); await s.pass();
  assert.equal(s.exports(), 0);
  s.later(HOUR); await s.pass();
  assert.equal(s.exports(), 1);
});

test('a project whose Hindsight is down is skipped and logged, and tried at the next run, a day later', async t => {
  const s = await setup(t);
  await s.h.down();
  await s.pass();
  assert.ok(s.f.lines.includes(`memory p: Hindsight is not answering on 127.0.0.1:${s.h.port}; its daily memory backup is skipped, tried again in 24h`), s.f.lines.join('\n'));
  await s.h.up();
  s.later(HOUR); await s.pass();
  assert.equal(s.exports(), 0);
  s.later(23 * HOUR); await s.pass();
  assert.equal(s.exports(), 1);
});

test('a failing memory:backup is logged as an error, tried again in 24h; a project without hindsight is never backed up', async t => {
  const s = await setup(t);
  s.h.banks.delete('p');
  await s.pass();
  assert.ok(s.f.lines.some(l => /^error memory p: the daily memory backup failed, tried again in 24h: agent\.sh memory:backup p: memory:backup: p's Hindsight on 127\.0\.0\.1:\d+ has no bank p/.test(l)), s.f.lines.join('\n'));
  const file = join(s.f.dir, 'projects', 'p', 'project.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), hindsight: undefined }));
  s.later(48 * HOUR); await s.pass();
  assert.equal(s.exports(), 1);
});
