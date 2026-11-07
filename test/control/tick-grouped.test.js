// The grouped engines through control (ASS-68): a project switched onto
// example-development-grouped (project:set-execution-engine, AC6) moves a
// ticket from the backlog into Setup, whose first step finds the variation's
// VM set up already and leaves at once (AC7), and on into Plan at its first
// step — the real engines and Setup's real scripts, limactl a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { fakeVm } from '../support/fake-vm.js';
import { engineDir, engineNames } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

test('tick: on example-development-grouped a ticket leaves the backlog for Setup, which its VM\'s setup-complete marker ends at once, and enters Plan at Extract Acceptance Criteria', async () => {
  const f = controlFixture();
  const at = (...rest) => join(f.dir, ...rest);
  for (const name of engineNames()) if (!existsSync(at('engines', name)) && existsSync(join(engineDir(name), 'state-engine.json'))) cpSync(engineDir(name), at('engines', name), { recursive: true });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0].vm = { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' }; });
  await f.agent('project:set-execution-engine', 'p', 'example-development-grouped');
  const v = fakeVm(f.env);
  v.instance('abc-3-a', 'Running');
  mkdirSync(join(v.root, 'repos'));
  writeFileSync(join(v.root, 'repos', '.setup-complete'), '');
  f.ctx.env = v.env;
  try {
    // Each tick's VM work awaited, as the ticks' interval allows live: Setup's steps wait until control has seen the VM running (ASS-133).
    for (let i = 0; i < 6 && f.variation()['harness-status'].state !== 'plan'; i++) { await tick(f.ctx); await Promise.all([...(f.ctx.memory.vms?.values() ?? [])].map(r => r.job)); }
    const variation = f.variation();
    assert.deepEqual(variation['harness-status'], { state: 'plan', 'state-engine': 'example-development-grouped', 'sub-status': { state: 'enrich-ac', 'state-engine': 'grouped-plan' } }, f.lines.join('\n'));
    assert.deepEqual(variation['state-changes'].filter(c => !c['sub-state-change']).map(c => c['to-state']), ['committed', 'setup', 'plan']);
    assert.deepEqual(variation['state-changes'].filter(c => c['to-state'] === 'setup' && c['sub-state-change']).map(c => c['sub-state-change']['to-state']), ['check-setup-complete', 'done']);   // every other setup step skipped
    assert.ok(v.calls().some(c => c.vm === 'abc-3-a' && c.argv.join(' ').includes('/repos/.setup-complete')), 'the marker was looked for in the VM');
    assert.equal(f.ticket()['ticket-system-status'], 'In Progress');   // the group step's pairing
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: Create VM that cannot fit within the project\'s VM disk limit (ASS-75) sends the ticket to Blocked for Human, vm:create\'s reason recorded as its ai-feedback', async () => {
  const f = controlFixture();
  const at = (...rest) => join(f.dir, ...rest);
  for (const name of engineNames()) if (!existsSync(at('engines', name)) && existsSync(join(engineDir(name), 'state-engine.json'))) cpSync(engineDir(name), at('engines', name), { recursive: true });
  await f.agent('project:set-execution-engine', 'p', 'example-development-grouped');
  edit(at('harness.json'), h => { h['vm-disk-limit-gb'] = 4096 / 1e9; });   // one block; golden-p's disk is two
  const v = fakeVm(f.env);
  v.instance('golden-p');
  writeFileSync(join(v.instances, 'golden-p', 'disk'), randomBytes(8192));
  f.ctx.env = { ...v.env, HARNESS_HOME: join(v.dir, 'harness-home') };
  try {
    for (let i = 0; i < 10 && f.variation()['harness-status'].state !== 'blocked-for-human'; i++) await tick(f.ctx);
    const variation = f.variation();
    assert.equal(variation['harness-status'].state, 'blocked-for-human', f.lines.join('\n'));
    assert.equal(variation['ai-feedback-short'], 'VM disk limit reached');
    assert.match(variation['ai-feedback-long'], /^p's VMs use [\d.]+ GB of its [\d.]+ GB VM disk limit \(vm-disk-limit-gb\), and abc-3-a needs [\d.]+ GB \(golden-p's size\)/);
    assert.ok(!existsSync(join(v.instances, 'abc-3-a')), 'nothing cloned');
  } finally {
    f.ctx.stopAgents();
  }
});
