// ASS-578 AC3: vm:move-lima-home <project> <folder> [--dry-run] moves a project's golden image(s) and ticket VMs to
// another Lima folder and sets its project.json lima-home: the space checked first, each instance copied (or, on the
// same volume, renamed), checked with limactl list under the new folder, and only then the old copies deleted;
// refused while the harness runs or a VM of the project does. limactl is test/support/fake-limactl.js keeping its
// instances in the LIMA_HOME it runs with (FAKE_LIMA_BY_HOME); df the vm fixture's fake (the volume's free space
// less what the harness-wide folder holds). MOVE_LIMA_FORCE_COPY=1 takes the copy path although the folders are on
// one volume (the tests' /tmp); the real move across two volumes is in change-notes (AC3's real check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, statSync, openSync, ftruncateSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lima, edit } from './vm-fixture.js';
import { run, AGENT } from './harness-fixture.js';

// setup() — vm-fixture's project p: golden-p (a sparse 64 MiB disk with 8 KiB written, a lima.yaml, a stale socket
// name and pid file) and its ticket VM abc-3-a (in its inventory) in the harness-wide folder, both stopped; another
// project's VM xyz-1-a there too; Lima's _config with a key; a target folder to move to.
function setup() {
  const l = lima();
  const wide = l.v.instances;
  const sparse = (file, at) => { const fd = openSync(file, 'w'); ftruncateSync(fd, 64 * 2 ** 20); writeSync(fd, Buffer.alloc(8192, 7), 0, 8192, at); closeSync(fd); };
  sparse(join(wide, 'golden-p', 'disk'), 0);
  writeFileSync(join(wide, 'golden-p', 'golden-image.json'), JSON.stringify({ 'built-at': '2026-11-24T00:00:00Z' }));
  l.v.instance('abc-3-a', 'Stopped', '41234');
  sparse(join(wide, 'abc-3-a', 'disk'), 32 * 2 ** 20);
  writeFileSync(join(wide, 'abc-3-a', 'ha.pid'), '123');
  l.v.instance('xyz-1-a', 'Stopped');
  writeFileSync(join(l.f.dir, 'projects', 'p', 'vms.json'), JSON.stringify({ 'abc-3-a': { ticket: 'ABC-3', variation: 'A', state: 'Stopped', 'disk-bytes': 0, 'last-accessed': '2026-11-01T00:00:00Z' } }));
  mkdirSync(join(wide, '_config'));
  writeFileSync(join(wide, '_config', 'user'), 'PRIVATE KEY (fake)');
  writeFileSync(join(wide, '_config', 'user.pub'), 'ssh-ed25519 AAAA fake');
  writeFileSync(join(wide, '_config', 'networks.yaml'), 'networks: {}\n');
  const to = join(realpathSync(mkdtempSync(join(tmpdir(), 'new-lima-'))), 'lima');
  Object.assign(l.env, { FAKE_LIMA_BY_HOME: '1' });
  const move = (args = [], env = {}) => run(AGENT, ['vm:move-lima-home', 'p', to, ...args], { env: { ...l.env, ...env } });
  const projectJson = () => JSON.parse(readFileSync(join(l.f.dir, 'projects', 'p', 'project.json'), 'utf8'));
  return { ...l, wide, to, move, projectJson };
}

test('ASS-578 AC3: --dry-run says what would move — each instance, the space a copy needs and the target has — and moves nothing', async () => {
  const s = setup();
  const plan = JSON.parse((await s.move(['--dry-run'], { MOVE_LIMA_FORCE_COPY: '1' })).stdout);
  assert.equal(plan['dry-run'], true);
  assert.equal(plan.from, s.wide);
  assert.equal(plan.to, s.to);
  assert.deepEqual(plan.instances.map(i => i.name).sort(), ['abc-3-a', 'golden-p']);
  assert.equal(plan['need-bytes'], plan.instances.reduce((a, i) => a + i.bytes, 0));
  assert.ok(plan['need-bytes'] < 2 * 2 ** 20, `sparse: what is allocated, not 64 MiB each (${plan['need-bytes']})`);
  assert.equal(plan['same-volume'], false);
  assert.ok(existsSync(join(s.wide, 'golden-p')) && existsSync(join(s.wide, 'abc-3-a')));
  assert.ok(!existsSync(join(s.to, 'golden-p')));
  assert.equal(s.projectJson()['lima-home'], undefined);
});

test('ASS-578 AC3: copies each instance sparse-aware, checks it with limactl list under the new folder, sets lima-home, then deletes the old copies; another project\'s VM stays', async () => {
  const s = setup();
  const { stdout, stderr } = await s.move([], { MOVE_LIMA_FORCE_COPY: '1' });
  const out = JSON.parse(stdout);
  assert.equal(out['lima-home'], s.to);
  assert.equal(s.projectJson()['lima-home'], s.to);
  for (const name of ['golden-p', 'abc-3-a']) {
    assert.ok(existsSync(join(s.to, name, 'disk')), `${name} moved`);
    assert.ok(!existsSync(join(s.wide, name)), `the old ${name} deleted`);
    assert.equal(statSync(join(s.to, name, 'disk')).size, 64 * 2 ** 20, 'its size kept');
    assert.ok(statSync(join(s.to, name, 'disk')).blocks * 512 < 2 * 2 ** 20, 'still sparse');
  }
  assert.ok(readFileSync(join(s.to, 'abc-3-a', 'disk')).subarray(32 * 2 ** 20, 32 * 2 ** 20 + 8192).every(b => b === 7), 'its data');
  assert.equal(readFileSync(join(s.to, 'abc-3-a', 'lima.yaml'), 'utf8').includes('localPort: 41234'), true, 'its pinned ssh port kept');
  assert.ok(!existsSync(join(s.to, 'abc-3-a', 'ha.pid')), 'a pid file left behind');
  assert.ok(!existsSync(join(s.to, '_harness-move')), 'the staging folder gone');
  assert.ok(existsSync(join(s.wide, 'xyz-1-a')), 'another project\'s VM untouched');
  assert.equal(readFileSync(join(s.to, '_config', 'user'), 'utf8'), 'PRIVATE KEY (fake)', 'Lima\'s key, so the moved VMs accept SSH');
  assert.equal(readFileSync(join(s.to, '_config', 'networks.yaml'), 'utf8'), 'networks: {}\n');
  // Checked under the new folder before anything old was deleted.
  const calls = s.v.calls();
  const checks = calls.filter(c => c.argv[0] === 'list' && c.home === s.to).map(c => c.argv[1]);
  assert.deepEqual(checks.sort(), ['abc-3-a', 'golden-p']);
  assert.match(stderr, /copied golden-p to /);
  // From now on the project's VMs are there: vm:inventory reads its folder.
  const inventory = JSON.parse((await s.cli('vm:inventory', 'p')).stdout);
  assert.deepEqual(inventory.vms.map(v => v.name), ['abc-3-a']);
  assert.ok(inventory['golden-bytes'] > 0, 'its golden image found there');
});

test('ASS-578 AC3: on the same volume each instance is renamed into place (no space needed, clones kept); moving back to the harness-wide folder unsets lima-home', async () => {
  const s = setup();
  const out = JSON.parse((await s.move()).stdout);
  assert.equal(out['same-volume'], true);
  assert.equal(out['need-bytes'], 0);
  assert.ok(existsSync(join(s.to, 'golden-p')) && !existsSync(join(s.wide, 'golden-p')));
  const back = JSON.parse((await run(AGENT, ['vm:move-lima-home', 'p', s.wide], { env: s.env })).stdout);
  assert.equal(back['lima-home'], null);
  assert.equal(s.projectJson()['lima-home'], undefined, 'back on the harness-wide setting');
  assert.ok(existsSync(join(s.wide, 'golden-p')) && existsSync(join(s.wide, 'abc-3-a')));
});

test('ASS-578 AC3: refused, nothing moved, when the target\'s volume lacks the space (each instance whole, plus disk-free-hold-gb)', async () => {
  const s = setup();
  edit(join(s.f.dir, 'harness.json'), h => { h['disk-free-hold-gb'] = 0.000001; h['disk-free-warn-gb'] = 0.000002; });
  s.volume(Number(String(await run('du', ['-sk', s.wide]).then(r => r.stdout.split('\t')[0]))) + 8);   // 8 KiB free
  await assert.rejects(s.move([], { MOVE_LIMA_FORCE_COPY: '1' }), e => /the copies need .* GiB .* must stay free \(disk-free-hold-gb\); nothing moved/.test(e.stderr));
  const dry = await s.move(['--dry-run'], { MOVE_LIMA_FORCE_COPY: '1' }).catch(e => e);
  assert.equal(dry.code, 1, 'a dry run that would be refused exits 1');
  assert.ok(JSON.parse(dry.stdout)['need-bytes'] > 8 * 1024, 'with its plan');
  assert.ok(existsSync(join(s.wide, 'golden-p')) && !existsSync(join(s.to, 'golden-p')));
  assert.equal(s.projectJson()['lima-home'], undefined);
});

test('ASS-578 AC3: refused while a VM of the project runs, or the target holds one of its names', async () => {
  const s = setup();
  writeFileSync(join(s.wide, 'abc-3-a', 'status'), 'Running');
  await assert.rejects(s.move(), e => /abc-3-a is Running, not stopped: stop it first .*nothing moved/.test(e.stderr));
  writeFileSync(join(s.wide, 'abc-3-a', 'status'), 'Stopped');
  mkdirSync(join(s.to, 'golden-p'), { recursive: true });
  await assert.rejects(s.move(), e => /holds a golden-p already; nothing moved/.test(e.stderr));
  assert.ok(existsSync(join(s.wide, 'abc-3-a', 'disk')));
  assert.equal(s.projectJson()['lima-home'], undefined);
});

test('ASS-578 AC3: refused while the harness runs (a live pid file under HARNESS_HOME naming a harness process)', async () => {
  const s = setup();
  const dir = mkdtempSync(join(tmpdir(), 'fake-tui-'));
  mkdirSync(join(dir, 'tui'));
  writeFileSync(join(dir, 'tui', 'main.js'), 'setInterval(() => {}, 1000);\n');
  const fake = spawn(process.execPath, [join(dir, 'tui', 'main.js')], { stdio: 'ignore' });
  try {
    writeFileSync(join(s.env.HARNESS_HOME, 'run-tui.pid'), `${fake.pid}\n`);
    await assert.rejects(s.move(), e => /the harness is running \(run-tui\.pid names pid \d+\): stop it first; nothing moved/.test(e.stderr));
    assert.ok(existsSync(join(s.wide, 'golden-p')));
  } finally { fake.kill(); }
  // A stale pid file (its process gone) is no harness.
  await new Promise(resolve => fake.exitCode != null || fake.signalCode != null ? resolve() : fake.once('exit', resolve));
  const out = JSON.parse((await s.move()).stdout);
  assert.equal(out['lima-home'], s.to);
});

test('ASS-578 AC3: bad arguments are refused: no project, a relative folder', async () => {
  const s = setup();
  await assert.rejects(run(AGENT, ['vm:move-lima-home', 'nope', s.to], { env: s.env }), /no project 'nope'/);
  await assert.rejects(run(AGENT, ['vm:move-lima-home', 'p', 'relative/lima'], { env: s.env }), /must be an absolute path/);
  await assert.rejects(run(AGENT, ['vm:move-lima-home', 'p'], { env: s.env }), /usage: vm:move-lima-home <project> <folder> \[--dry-run\]/);
});
