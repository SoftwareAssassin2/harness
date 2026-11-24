// ASS-575: control records each remote machine's boot wait (ASS-553 AC7, seats.js bootWaits) per project in
// boot-waits.json, each tick it changes, and the dashboard reads it back into control's own shape (project.bootWaitOver).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assignSeats } from '../../src/control/seats.js';
import { loadBootWaits, bootWaitOverOf, bootWaitOf, BOOT_WAITS_FILE } from '../../src/control/boot-waits.js';
import { loadWorkstations } from '../../src/control/workstation-connection.js';
import { controlFixture } from './control-fixture.js';

const T0 = Date.parse('2026-11-23T10:00:00Z');
const STOPPED = { state: 'stopped', connected: false };
const UP = { state: 'running', connected: true, 'connected-at': '2026-11-23T10:05:00Z', setup: { ok: true, 'checked-at': '2026-11-23T10:09:00Z', home: '/home/u' } };

// world(live, harness) — pool-choice.test.js's bootWorld: p on [workstation-worktree, local-worktree] with workstation
// ada-dev (live entry `live`), ABC-3 A at build; `phase(s)` runs the seats phase s seconds after T0 and returns the state.
function world(live, harness = {}) {
  const c = controlFixture();
  const at = (...rest) => join(c.dir, ...rest);
  const edit = (file, change) => { const j = JSON.parse(readFileSync(file, 'utf8')); change(j); writeFileSync(file, JSON.stringify(j)); };
  edit(at('engines', 'example-development', 'workflow.yaml'), e => { e.steps.find(s => s.id === 'build')['run-location'] = 'vm'; });
  edit(at('projects', 'p', 'project.json'), p => { p['dev-environments'] = { 'run-targets': ['workstation-worktree', 'local-worktree'], workstations: [{ id: 'ada-dev', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' }] }; });
  edit(at('harness.json'), h => Object.assign(h, harness));
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => {
    sp.features = [{ key: 'ABC-3', 'manual-priority': 1, 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'example-development' }, 'state-changes': [] }] }];
  });
  writeFileSync(at('projects', 'p', 'seat-budget.json'), JSON.stringify({ seats: 3 }));
  const setLive = entry => writeFileSync(at('projects', 'p', 'workstations.json'), JSON.stringify({ 'ada-dev': entry }));
  setLive(live);
  let now = T0;
  c.ctx.now = () => new Date(now);
  const dir = at('projects', 'p');
  return { c, dir, setLive, file: join(dir, BOOT_WAITS_FILE), phase: async seconds => { now = T0 + seconds * 1000; const state = c.ctx.load(); await assignSeats(c.ctx, state); return state; } };
}

test('ASS-575 AC1: control records each remote machine\'s boot wait in boot-waits.json each tick it changes, and removes it once nothing waits', async () => {
  const w = world(STOPPED, { 'remote-boot-wait-seconds': 300 });
  await w.phase(0);
  assert.deepEqual(JSON.parse(readFileSync(w.file, 'utf8')), { 'wait-seconds': 300, machines: { 'ada-dev': { since: '2026-11-23T10:00:00.000Z', 'ends-at': '2026-11-23T10:05:00.000Z', over: false } } });
  const before = readFileSync(w.file, 'utf8');
  const mtime = statSync(w.file).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 20));   // (so a rewrite would show in the mtime)
  await w.phase(120);
  assert.equal(readFileSync(w.file, 'utf8'), before);
  assert.equal(statSync(w.file).mtimeMs, mtime, 'a tick that changes nothing leaves the file as it is');
  const state = await w.phase(301);
  const file = loadBootWaits(w.dir);
  assert.equal(file.machines['ada-dev'].over, true, 'over once the wait ran out');
  // AC2: the dashboard's reading is control's own bootWaitOver, word for word.
  const project = state.projects.find(p => p.id === 'p');
  assert.deepEqual(project.bootWaitOver, { 'ada-dev': 'it did not come up within 300 s (remote-boot-wait-seconds)' });
  assert.deepEqual(bootWaitOverOf(file, loadWorkstations(w.dir), T0 + 301e3), project.bootWaitOver);
  w.setLive(UP);
  await w.phase(400);
  assert.ok(!existsSync(w.file), 'removed once the machine is up');
});

test('ASS-575 AC1: a control starting afresh takes the recorded waits up again — a restart gives a late machine no new full wait', async () => {
  const w = world(STOPPED, { 'remote-boot-wait-seconds': 300 });
  await w.phase(0);
  delete w.c.ctx.memory.bootWaits;   // a new control process: nothing of the wait in memory
  const state = await w.phase(301);
  assert.deepEqual(state.projects.find(p => p.id === 'p').bootWaitOver, { 'ada-dev': 'it did not come up within 300 s (remote-boot-wait-seconds)' }, w.c.lines.join('\n'));
});

test('ASS-575 AC2: bootWaitOf — within the wait, past it by time before control\'s next tick, and nothing for a machine up or lost otherwise', () => {
  const file = { 'wait-seconds': 900, machines: { m: { since: '2026-11-23T10:00:00Z', 'ends-at': '2026-11-23T10:15:00Z', over: false } } };
  assert.deepEqual(bootWaitOf(file, STOPPED, 'm', T0 + 5 * 60e3), { since: T0, endsAt: T0 + 900e3, seconds: 900, waited: 300, over: false });
  assert.equal(bootWaitOf(file, STOPPED, 'm', T0 + 901e3).over, true);
  assert.equal(bootWaitOf(file, UP, 'm', T0 + 901e3), null);
  assert.equal(bootWaitOf(file, { connected: false, setup: { ok: false, error: 'x' } }, 'm', T0), null);
  assert.equal(bootWaitOf(file, STOPPED, 'other', T0), null);
  assert.deepEqual(bootWaitOverOf(null, {}, T0), {});
});
