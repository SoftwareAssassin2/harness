// The disk watch (ASS-288): control reads the free space on the volumes
// holding LIMA_HOME and the data folder at most once a minute
// (harness:check-disk-space, recorded in disk-space.json); below
// disk-free-warn-gb it reclaims VMs harness-wide (vm:reclaim-all, beside the
// tick); below disk-free-hold-gb it starts nothing new — no agent, VM, clone
// or golden build — like a rate-limit hold, until the free space is back above
// the warn level. df and limactl are fakes on the PATH: never the real disk or
// a real VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { tick } from '../../src/control/tick.js';
import { fakeVm } from '../support/fake-vm.js';
import { until } from '../support/until.js';

const MINUTE = 60e3;
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

// The control fixture with the disk watch on: LIMA_HOME a folder of its own,
// a fake limactl (no VMs) and a fake df whose every volume has <v.dir>/k KiB
// free; thresholds warn 0.0001 GB (100000 bytes), hold 0.00003 GB (30000
// bytes). free(kib) sets it; later(ms) moves the clock.
function watching() {
  const f = controlFixture();
  const v = fakeVm(f.env);
  const limaHome = realpathSync(mkdtempSync(join(tmpdir(), 'lima-home-')));
  v.script('df', `echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'; echo "/dev/fake 999999999 1 $(cat '${v.dir}/k') 1% /Volumes/Big"`);
  const free = kib => writeFileSync(join(v.dir, 'k'), String(kib));
  free(1e9);
  edit(join(f.dir, 'harness.json'), h => { h['disk-free-warn-gb'] = 0.0001; h['disk-free-hold-gb'] = 0.00003; });
  f.ctx.env = { ...v.env, LIMA_HOME: limaHome, DISK_SPACE_DISABLED: '0' };
  let now = Date.parse('2026-11-07T12:00:00Z');
  f.ctx.now = () => new Date(now);
  const cli = f.ctx.cli, calls = [];
  f.ctx.cli = (args, env) => { calls.push(args.join(' ')); return cli(args, env); };
  const disk = () => JSON.parse(readFileSync(f.env.DISK_SPACE_FILE, 'utf8'));
  const reclaimed = () => f.ctx.memory.disk?.reclaim ?? Promise.resolve();
  return { f, v, free, calls, disk, reclaimed, later: ms => { now += ms; } };
}
const checks = calls => calls.filter(c => c === 'harness:check-disk-space').length;
const dispatched = f => f.assignments().assignments.filter(a => a['work-item'] === 'ABC-3');

test('ASS-288 AC1: control reads the disk at most once a minute, recording it in disk-space.json; above the warn level it says nothing and reclaims nothing', async () => {
  const w = watching();
  await tick(w.f.ctx);
  await tick(w.f.ctx);
  w.later(MINUTE - 1000);
  await tick(w.f.ctx);
  assert.equal(checks(w.calls), 1, w.calls.join('\n'));
  assert.equal(w.disk().level, 'ok');
  w.later(1000);
  await tick(w.f.ctx);
  assert.equal(checks(w.calls), 2);
  assert.ok(!w.calls.some(c => c.startsWith('vm:reclaim-all')), w.calls.join('\n'));
  assert.ok(!w.f.lines.some(l => /^(disk|hold) /.test(l)), w.f.lines.join('\n'));
  assert.equal(dispatched(w.f).length, 1, 'work goes on');
});

test('ASS-288 AC3: below the warn level control logs it once and runs vm:reclaim-all beside the tick, logging what it deleted and when nothing more can be; agents are still dispatched', async () => {
  const w = watching();
  w.free(90);                                                   // 92160 bytes: below warn, above hold
  await tick(w.f.ctx);
  await w.reclaimed();
  assert.ok(w.calls.includes('vm:reclaim-all'), w.calls.join('\n'));
  assert.ok(w.f.lines.includes('disk Disk low: 0.0 GiB free, below the 0.0001 GB warning level — deleting stopped VMs no ticket needs, least recently accessed first, across every project'), w.f.lines.join('\n'));
  assert.ok(w.f.lines.some(l => /^disk nothing more to delete: /.test(l)), w.f.lines.join('\n'));
  assert.equal(dispatched(w.f).length, 1, 'a warning holds nothing');
  await tick(w.f.ctx);                                          // within the minute: no second check, no second reclaim
  assert.equal(w.calls.filter(c => c === 'vm:reclaim-all').length, 1);
  assert.equal(w.f.lines.filter(l => /^disk Disk low/.test(l)).length, 1);
});

test('ASS-288 AC4/AC6: below the hold level control starts no agent and runs no step that makes a VM or golden image, logging the hold once; running agents finish their turn; once the free space is back above the warn level — not before — the hold releases itself and work goes on', async () => {
  const w = watching();
  await tick(w.f.ctx);                                          // the plan agent is dispatched
  assert.equal(dispatched(w.f).length, 1);
  const running = [...w.f.ctx.agents.keys()];
  w.free(20);                                                   // 20480 bytes: below hold
  w.later(MINUTE);
  // ABC-4 at a step that makes its VM: held, never run.
  edit(join(w.f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e.steps.find(s => s.id === 'build').action.command = './agent.sh vm:create {project} {ticket} {variation}';
  });
  edit(join(w.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': hs('build'), 'state-changes': [] }] });
  });
  await tick(w.f.ctx);
  await w.reclaimed();
  assert.equal(w.disk().level, 'hold');
  const hold = 'hold Disk nearly full — work held (0.0 GiB free): no agent, VM, clone or golden build starts until 0.0001 GB is free; running agents finish their turns';
  assert.ok(w.f.lines.includes(hold), w.f.lines.join('\n'));
  assert.ok(!w.f.lines.some(l => /^script .*vm:create/.test(l)), w.f.lines.join('\n'));
  assert.ok(w.f.lines.some(l => l === 'steps ABC-4 A build: waits: the disk is nearly full'), w.f.lines.join('\n'));
  assert.deepEqual([...w.f.ctx.agents.keys()], running, 'the running agent is not stopped');
  assert.ok(await until(() => [...w.f.ctx.agents.values()].every(a => a.result)), 'its turn ends');
  // Its turn finished, the step moves on as usual; no new agent while held.
  for (let i = 0; i < 3; i++) await tick(w.f.ctx);
  assert.deepEqual(dispatched(w.f), [], w.f.lines.join('\n'));
  assert.equal(w.f.lines.filter(l => l === hold).length, 1, 'logged once');

  w.free(50);                                                   // 51200 bytes: above hold, below warn — still held
  w.later(MINUTE);
  await tick(w.f.ctx);
  await w.reclaimed();
  assert.equal(w.disk().level, 'hold');
  assert.deepEqual(dispatched(w.f), []);

  w.free(200);                                                  // back above warn: released
  w.later(MINUTE);
  await tick(w.f.ctx);
  assert.equal(w.disk().level, 'ok');
  assert.ok(w.f.lines.includes('hold disk space back above 0.0001 GB (0.0 GiB free): work resumes'), w.f.lines.join('\n'));
  assert.ok(w.f.lines.some(l => /^script \S*agent\.sh vm:create p ABC-4 A$/.test(l)), `the held step runs:\n${w.f.lines.join('\n')}`);
});

test('ASS-288 AC1: a failing check is logged once per failure streak; the last record stands', async () => {
  const w = watching();
  await tick(w.f.ctx);
  w.v.script('df', 'exit 1');
  for (let i = 0; i < 3; i++) { w.later(MINUTE); await tick(w.f.ctx); }
  assert.equal(w.f.lines.filter(l => /^error disk: .*could not read the free space/.test(l)).length, 1, w.f.lines.join('\n'));
  assert.equal(w.disk().level, 'ok');
});
