// The harness's disk (ASS-288): harness:check-disk-space reads df for the
// volume holding LIMA_HOME and the one holding the data folder, and records in
// disk-space.json whether the least free of them is below harness.json's
// disk-free-warn-gb (warn) or disk-free-hold-gb (hold) — a hold kept until it
// is back above the warn level; vm:reclaim-all deletes the deletable VMs of
// every project, least recently accessed first across all of them, until the
// volume holding LIMA_HOME is back above the warn level; vm:build-golden-start
// starts no build while the hold is on. df is a fake on the PATH: never the
// real volume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, run, AGENT, STAMP } from './harness-fixture.js';
import { lima, edit } from './vm-fixture.js';

const KB = 4096;
const read = file => JSON.parse(readFileSync(file, 'utf8'));

// The fixture with LIMA_HOME a folder of its own and a fake df: the volume
// holding LIMA_HOME has <d>/lima-k KiB free, mounted at <d>/lima-mount; any
// other path's (the data folder's) <d>/data-k, at <d>/data-mount; with
// <d>/fail, df fails. Thresholds in GB: warn 0.0001 (100000 bytes), hold
// 0.00003 (30000 bytes).
function disk({ thresholds = true } = {}) {
  const f = fixture();
  const d = mkdtempSync(join(tmpdir(), 'df-'));
  const limaHome = realpathSync(mkdtempSync(join(tmpdir(), 'lima-home-')));
  const bin = join(d, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'df'), `#!/usr/bin/env bash
[[ -e '${d}/fail' ]] && { echo 'df: fake failure' >&2; exit 1; }
p="\${@: -1}"
if [[ "$p" == '${limaHome}'* ]]; then k=$(cat '${d}/lima-k'); m=$(cat '${d}/lima-mount'); else k=$(cat '${d}/data-k'); m=$(cat '${d}/data-mount'); fi
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
echo "/dev/fake 999999999 1 $k 1% $m"
`);
  chmodSync(join(bin, 'df'), 0o755);
  const set = (name, value) => writeFileSync(join(d, name), String(value));
  set('lima-k', 1e9); set('data-k', 1e9); set('lima-mount', '/Volumes/Big'); set('data-mount', '/Volumes/Big');
  if (thresholds) edit(join(f.dir, 'harness.json'), h => { h['disk-free-warn-gb'] = 0.0001; h['disk-free-hold-gb'] = 0.00003; });
  const env = { ...f.env, PATH: `${bin}:${process.env.PATH}`, LIMA_HOME: limaHome, DISK_SPACE_FILE: join(f.dir, 'disk-space.json') };
  const check = async (...args) => JSON.parse((await run(AGENT, ['harness:check-disk-space', ...args], { env })).stdout);
  return { f, d, set, env, limaHome, check, file: () => read(join(f.dir, 'disk-space.json')), exists: () => existsSync(join(f.dir, 'disk-space.json')) };
}

test('ASS-288 AC1: harness.json sets disk-free-warn-gb 50 and disk-free-hold-gb 15', () => {
  const harness = read(join(import.meta.dirname, '..', '..', 'data', 'harness.json'));
  assert.equal(harness['disk-free-warn-gb'], 50);
  assert.equal(harness['disk-free-hold-gb'], 15);
});

test('ASS-288 AC1/AC6: harness:check-disk-space reads df for LIMA_HOME\'s volume and the data folder\'s, and records the least free against the thresholds: ok above warn, warn below it, hold below hold', async () => {
  const s = disk();
  const ok = await s.check();
  assert.match(ok['as-of'], STAMP);
  assert.deepEqual({ ...ok, 'as-of': null }, {
    'as-of': null, level: 'ok', 'free-bytes': 1e9 * 1024, 'warn-bytes': 100000, 'hold-bytes': 30000, 'held-since': null,
    volumes: [{ mount: '/Volumes/Big', 'free-bytes': 1e9 * 1024, paths: [s.limaHome, s.f.dir] }],
  });
  assert.deepEqual(s.file(), ok, 'recorded as printed');

  s.set('lima-k', 90);                                     // 92160 bytes: below warn, above hold
  const warn = await s.check();
  assert.equal(warn.level, 'warn');
  assert.equal(warn['free-bytes'], 90 * 1024);
  assert.equal(warn['held-since'], null);

  s.set('lima-k', 20);                                     // 20480 bytes: below hold
  const hold = await s.check();
  assert.equal(hold.level, 'hold');
  assert.match(hold['held-since'], STAMP);
  assert.equal(s.file().level, 'hold');
});

test('ASS-288 AC4/AC6: the hold is kept while the free space is between the hold and warn levels, and released by itself once it is back above the warn level', async () => {
  const s = disk();
  s.set('lima-k', 20);
  const held = await s.check();
  assert.equal(held.level, 'hold');
  s.set('lima-k', 50);                                     // 51200 bytes: above hold, below warn — still held
  const still = await s.check();
  assert.equal(still.level, 'hold');
  assert.equal(still['held-since'], held['held-since'], 'held since it began');
  s.set('lima-k', 98);                                     // 100352 bytes: back above warn — released
  const released = await s.check();
  assert.equal(released.level, 'ok');
  assert.equal(released['held-since'], null);
  s.set('lima-k', 50);                                     // below warn again, not below hold: a warning, not a hold
  assert.equal((await s.check()).level, 'warn');
});

test('ASS-288 AC1: two volumes are each read, and the less free decides; the data folder\'s volume alone below the levels warns and holds as well', async () => {
  const s = disk();
  s.set('data-mount', '/Volumes/Data'); s.set('data-k', 25);
  const out = await s.check();
  assert.equal(out.level, 'hold');
  assert.equal(out['free-bytes'], 25 * 1024);
  assert.deepEqual(out.volumes, [
    { mount: '/Volumes/Big', 'free-bytes': 1e9 * 1024, paths: [s.limaHome] },
    { mount: '/Volumes/Data', 'free-bytes': 25 * 1024, paths: [s.f.dir] },
  ]);
});

test('ASS-288 AC1: without the thresholds in harness.json, 50 GB and 15 GB; df failing fails the check and leaves the record as it was', async () => {
  const s = disk({ thresholds: false });
  const out = await s.check();
  assert.deepEqual([out['warn-bytes'], out['hold-bytes'], out.level], [50e9, 15e9, 'ok']);
  const before = readFileSync(join(s.f.dir, 'disk-space.json'), 'utf8');
  s.set('fail', '');
  await assert.rejects(s.check(), /harness:check-disk-space: could not read the free space on the volume holding/);
  assert.equal(readFileSync(join(s.f.dir, 'disk-space.json'), 'utf8'), before);
});

test('ASS-288 AC2: harness:check-disk-space --report <project> <run> (the health check) writes disk.md in the run\'s folder below the warn level — the free space and the levels; above it, nothing', async () => {
  const s = disk();
  const run = '0f0f0f0f-0000-4000-8000-000000000001';
  const report = join(s.f.dir, 'projects', 'p', 'work', `run-${run}`, 'disk.md');
  await s.check('--report', 'p', run);
  assert.equal(existsSync(report), false, 'nothing to report above the warn level');
  s.set('lima-k', 90);
  await s.check('--report', 'p', run);
  const text = readFileSync(report, 'utf8');
  assert.match(text, /below the warning level/);
  assert.match(text, /\/Volumes\/Big/);
  assert.match(text, /disk-free-warn-gb/);
  await assert.rejects(s.check('--report', 'p'), /usage: harness:check-disk-space \[--report <project> <run>\]/);
});

test('ASS-288 AC4: vm:build-golden-start starts no golden build while the disk hold is on', async () => {
  const s = disk();
  s.set('lima-k', 20);
  await s.check();
  await assert.rejects(run(AGENT, ['vm:build-golden-start', 'p'], { env: s.env }), /Disk nearly full — work held \(0\.0 GiB free\)/);
  assert.equal(existsSync(join(s.f.dir, 'projects', 'p', 'golden-build-run.json')), false);
});

// lima() (vm-fixture.js) with project q's inventory too: each step but done of the example engine runs a VM (vm: running),
// warn and hold thresholds of `warn` and `hold` GB. vm(name, blocks, status) makes a VM of that many blocks.
function reclaim({ warn, hold = 1e-9 }) {
  const l = lima();
  const at = (...rest) => join(l.f.dir, ...rest);
  edit(at('engines', 'example-development', 'state-engine.json'), e => { for (const step of e.steps) if (step.id !== 'done') step.vm = 'running'; });
  edit(at('harness.json'), h => { h['vm-disk-limit-gb'] = 1; h['disk-free-warn-gb'] = warn; h['disk-free-hold-gb'] = hold; });
  const vm = (name, blocks, status = 'Stopped') => {
    if (!existsSync(join(l.v.instances, name))) l.v.instance(name, status);
    writeFileSync(join(l.v.instances, name, 'disk'), randomBytes(blocks * KB));
    utimesSync(join(l.v.instances, name, 'disk'), new Date('2026-10-20T00:00:00Z'), new Date('2026-10-20T00:00:00Z'));
  };
  const record = (variation, name) => edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0].variations.find(x => x.name === variation).vm = { name, ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' };
  });
  const inventory = (project, rows) => writeFileSync(at('projects', project, 'vms.json'), JSON.stringify(Object.fromEntries(rows.map(([name, ticket, accessed, variation = 'A']) =>
    [name, { ticket, variation, state: 'Stopped', 'disk-bytes': 0, 'last-accessed': accessed }]))));
  const used = () => Number(execFileSync('du', ['-sk', l.v.instances], { encoding: 'utf8' }).split('\t')[0]);
  const exists = name => existsSync(join(l.v.instances, name));
  return { ...l, at, vm, record, inventory, used, exists, reclaimAll: (...args) => l.cli('vm:reclaim-all', ...args) };
}

test('ASS-288 AC3/AC6: vm:reclaim-all deletes the deletable VMs of every project, least recently accessed first across all of them, until the volume holding LIMA_HOME is back above the warn level; running and in-flight VMs are never touched; each deletion logged with VM, ticket and bytes freed', async () => {
  const r = reclaim({ warn: 0.0001 });                    // 100000 bytes
  r.vm('abc-0-a', 5, 'Running');                          // p's oldest, but running
  r.vm('abc-3-c', 5); r.record('C', 'abc-3-c');           // p's, in flight (local-testing)
  r.vm('abc-1-a', 5);                                     // p's, an ended sprint's: deletable
  r.vm('q-0-a', 5);                                       // q's: deletable
  r.vm('abc-2-a', 5);                                     // p's: deletable, the most recently accessed
  r.inventory('p', [['abc-0-a', 'ABC-0', '2026-09-01T00:00:00Z'], ['abc-3-c', 'ABC-3', '2026-09-02T00:00:00Z', 'C'], ['abc-1-a', 'ABC-1', '2026-10-01T00:00:00Z'], ['abc-2-a', 'ABC-2', '2026-10-03T00:00:00Z']]);
  r.inventory('q', [['q-0-a', 'Q-0', '2026-10-02T00:00:00Z']]);
  // 30 KiB short of the warn level: one 20 KiB VM is not enough, two are.
  r.volume(r.used() + Math.ceil(100000 / 1024) - 30);
  const { stdout, stderr } = await r.reclaimAll();
  const out = JSON.parse(stdout);
  assert.deepEqual(out.deleted.map(x => [x.project, x.name, x.ticket, x.variation, x['last-accessed'], x['disk-bytes']]), [
    ['p', 'abc-1-a', 'ABC-1', 'A', '2026-10-01T00:00:00Z', 5 * KB],
    ['q', 'q-0-a', 'Q-0', 'A', '2026-10-02T00:00:00Z', 5 * KB],
  ]);
  for (const x of out.deleted) assert.ok(x['freed-bytes'] > 0, JSON.stringify(x));
  assert.equal(out['warn-bytes'], 100000);
  assert.ok(out['free-bytes'] >= 100000 && out['free-bytes-before'] < 100000, JSON.stringify(out));
  assert.equal(out.short, false);
  assert.deepEqual(['abc-0-a', 'abc-3-c', 'abc-1-a', 'q-0-a', 'abc-2-a'].map(r.exists), [true, true, false, false, true]);
  assert.equal(read(r.at('projects', 'q', 'vms.json'))['q-0-a'], undefined);
  assert.match(stderr, /vm:reclaim-all: deleted abc-1-a \(p ABC-1 A, last accessed 2026-10-01T00:00:00Z\): \d+ bytes freed/);
  assert.match(stderr, /vm:reclaim-all: deleted q-0-a \(q Q-0 A, last accessed 2026-10-02T00:00:00Z\): \d+ bytes freed/);

  // Above the warn level: nothing deleted.
  const again = JSON.parse((await r.reclaimAll()).stdout);
  assert.deepEqual(again.deleted, []);
  assert.equal(r.exists('abc-2-a'), true);
});

test('ASS-288 AC3: vm:reclaim-all short of the warn level with every deletable VM gone deletes them all, says it is short, and leaves running and in-flight ones; --dry-run deletes nothing', async () => {
  const r = reclaim({ warn: 1000 });                       // 1 TB: never reached
  r.vm('abc-0-a', 5, 'Running');
  r.vm('abc-3-c', 5); r.record('C', 'abc-3-c');
  r.vm('abc-1-a', 5);
  r.vm('q-0-a', 5);
  r.inventory('p', [['abc-0-a', 'ABC-0', '2026-09-01T00:00:00Z'], ['abc-3-c', 'ABC-3', '2026-09-02T00:00:00Z', 'C'], ['abc-1-a', 'ABC-1', '2026-10-01T00:00:00Z']]);
  r.inventory('q', [['q-0-a', 'Q-0', '2026-10-02T00:00:00Z']]);
  r.volume(r.used() + 100);
  const dry = JSON.parse((await r.reclaimAll('--dry-run')).stdout);
  assert.deepEqual(dry.deleted.map(x => x.name), ['abc-1-a', 'q-0-a']);
  assert.equal(dry['dry-run'], true);
  assert.deepEqual(['abc-0-a', 'abc-3-c', 'abc-1-a', 'q-0-a'].map(r.exists), [true, true, true, true]);
  const out = JSON.parse((await r.reclaimAll()).stdout);
  assert.deepEqual(out.deleted.map(x => x.name), ['abc-1-a', 'q-0-a']);
  assert.equal(out.short, true);
  assert.deepEqual(['abc-0-a', 'abc-3-c', 'abc-1-a', 'q-0-a'].map(r.exists), [true, true, false, false]);
  await assert.rejects(r.reclaimAll('--now'), /usage: vm:reclaim-all \[--dry-run\]/);
});

test('ASS-288 AC3: a second vm:reclaim-all while one runs (another control\'s) does nothing and says so', async t => {
  const r = reclaim({ warn: 1000 });
  r.vm('abc-1-a', 5);
  r.inventory('p', [['abc-1-a', 'ABC-1', '2026-10-01T00:00:00Z']]);
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', r.at('vm-reclaim-all.lock')]);
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const out = JSON.parse((await r.reclaimAll()).stdout);
  assert.deepEqual(out, { skipped: 'another vm:reclaim-all is running' });
  assert.equal(r.exists('abc-1-a'), true);
});

// ASS-289 AC3/AC4: a failed golden build's VM left over (golden-<project>-build, stopped, no build in progress)
// goes first, before any ticket VM of any project, whatever its last access; one a build holds (golden-build.lock)
// or a running one is never touched.
test('ASS-289 AC3: vm:reclaim-all deletes a stopped leftover golden-p-build before any ticket VM, less recently accessed though they are; golden-q-build, stopped but its build in progress, and a running build are left', async t => {
  const r = reclaim({ warn: 0.0001 });                    // 100000 bytes
  r.vm('golden-p-build', 5);                              // a failed build, left over: its disk last written 2026-10-20
  r.vm('golden-q-build', 5);                              // stopped between its build's steps: in progress
  r.vm('abc-1-a', 5);                                     // p's, an ended sprint's: deletable, accessed before it
  r.vm('q-0-a', 5);                                       // q's: deletable
  r.inventory('p', [['abc-1-a', 'ABC-1', '2026-10-01T00:00:00Z']]);
  r.inventory('q', [['q-0-a', 'Q-0', '2026-10-02T00:00:00Z']]);
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', r.at('projects', 'q', 'golden-build.lock')]);
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  // 30 KiB short of the warn level: two 20 KiB VMs.
  r.volume(r.used() + Math.ceil(100000 / 1024) - 30);
  const dry = JSON.parse((await r.reclaimAll('--dry-run')).stdout);
  assert.deepEqual(dry.deleted.map(x => [x.project, x.name, x.kind]), [['p', 'golden-p-build', 'leftover-golden-build'], ['p', 'abc-1-a', 'ticket-vm']]);
  const { stdout, stderr } = await r.reclaimAll();
  const out = JSON.parse(stdout);
  assert.deepEqual(out.deleted.map(x => [x.project, x.name, x.kind, x.ticket, x['disk-bytes']]), [
    ['p', 'golden-p-build', 'leftover-golden-build', null, 5 * KB],
    ['p', 'abc-1-a', 'ticket-vm', 'ABC-1', 5 * KB],
  ]);
  assert.match(stderr, /vm:reclaim-all: deleted golden-p-build \(p's leftover golden image build, last accessed 2026-10-20T00:00:00Z\): \d+ bytes freed/);
  assert.deepEqual(['golden-p-build', 'golden-q-build', 'abc-1-a', 'q-0-a'].map(r.exists), [false, true, false, true]);
});

test('ASS-289 AC3: vm:reclaim-all never deletes a running golden build', async () => {
  const r = reclaim({ warn: 1000 });
  r.vm('golden-p-build', 5, 'Running');
  r.inventory('p', []);
  r.volume(r.used() + 100);
  const out = JSON.parse((await r.reclaimAll()).stdout);
  assert.deepEqual(out.deleted, []);
  assert.equal(r.exists('golden-p-build'), true);
});
