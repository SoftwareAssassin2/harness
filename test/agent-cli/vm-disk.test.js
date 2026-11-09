// A project's VMs and their disk (ASS-75): the inventory, projects/<p>/vms.json,
// reconciled with limactl list and the sprint; the disk limit
// (vm-disk-limit-gb: harness.json's the default and ceiling); vm:create
// deleting the least recently accessed stopped VMs no variation in flight
// needs until a new one fits, else failing for Blocked for Human; vm:stop.
// limactl is test/support/fake-limactl.js, each VM's disk a real file in its
// folder (measured as a real one is: its APFS private size).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, utimesSync, appendFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { lima, edit } from './vm-fixture.js';

const KB = 4096;   // APFS's block: a file of whole blocks of random bytes allocates exactly its size
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

// lima() (vm-fixture.js), its engine's generate-solution and local-testing steps where a VM runs (vm: running);
// harness.json's limit `limit` GB; golden-p's disk 4 blocks. vm(name, blocks, status, accessed) makes a VM with a
// disk of that many blocks, last written at `accessed`; record(variation, vm) records it on ABC-3's variation.
function disk({ limit = 1 } = {}) {
  const l = lima();
  const at = (...rest) => join(l.f.dir, ...rest);
  edit(at('engines', 'example-development', 'state-engine.json'), e => { for (const s of e.steps) if (s.id !== 'done') s.vm = 'running'; });
  edit(at('harness.json'), h => { h['vm-disk-limit-gb'] = limit; });
  const vm = (name, blocks, status = 'Stopped', accessed = '2026-10-20T00:00:00Z') => {
    if (!existsSync(join(l.v.instances, name))) l.v.instance(name, status);
    const file = join(l.v.instances, name, 'disk');
    writeFileSync(file, randomBytes(blocks * KB));
    utimesSync(file, new Date(accessed), new Date(accessed));
  };
  vm('golden-p', 4);
  const record = (variation, name) => edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0].variations.find(x => x.name === variation).vm = { name, ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' };
  });
  const vms = () => JSON.parse(readFileSync(at('projects', 'p', 'vms.json'), 'utf8'));
  const exists = name => existsSync(join(l.v.instances, name));
  return { ...l, at, vm, record, vms, exists, inventory: async () => JSON.parse((await l.cli('vm:inventory', 'p')).stdout) };
}

test('vm:inventory p reconciles vms.json with limactl list and the sprint, and lists each VM oldest access first: its disk use, and whether it may be deleted', async () => {
  const d = disk();
  d.vm('abc-3-a', 1, 'Running', '2026-10-22T00:00:00Z'); d.record('A', 'abc-3-a');   // in flight, running
  d.vm('abc-3-c', 2, 'Stopped', '2026-10-10T00:00:00Z'); d.record('C', 'abc-3-c');   // in flight (local-testing), stopped
  d.vm('abc-3-d', 1, 'Stopped', '2026-10-11T00:00:00Z');                             // D was set aside (is-deleted)
  d.record('D', 'abc-3-d');
  d.vm('abc-1-a', 3);                                                                 // an ended sprint's: known from vms.json alone
  d.vm('xyz-1-a', 5);                                                                 // nobody's: not p's
  writeFileSync(d.at('projects', 'p', 'vms.json'), JSON.stringify({
    'abc-1-a': { ticket: 'ABC-1', variation: 'A', state: 'Stopped', 'disk-bytes': 0, 'last-accessed': '2026-10-01T00:00:00Z' },
    'abc-9-a': { ticket: 'ABC-9', variation: 'A', state: 'Stopped', 'disk-bytes': 0, 'last-accessed': '2026-10-02T00:00:00Z' },   // deleted outside the harness
  }));
  const inventory = await d.inventory();
  assert.deepEqual(inventory, {
    project: 'p', 'limit-bytes': 1e9, 'use-bytes': 7 * KB, 'golden-bytes': 4 * KB, 'golden-built-at': null, 'golden-build': null,
    vms: [
      { name: 'abc-1-a', ticket: 'ABC-1', variation: 'A', state: 'Stopped', 'disk-bytes': 3 * KB, 'last-accessed': '2026-10-01T00:00:00Z', deletable: true, 'golden-built-at': null, 'old-generation': false },
      { name: 'abc-3-c', ticket: 'ABC-3', variation: 'C', state: 'Stopped', 'disk-bytes': 2 * KB, 'last-accessed': '2026-10-10T00:00:00Z', deletable: false, 'golden-built-at': null, 'old-generation': false },
      { name: 'abc-3-d', ticket: 'ABC-3', variation: 'D', state: 'Stopped', 'disk-bytes': 1 * KB, 'last-accessed': '2026-10-11T00:00:00Z', deletable: true, 'golden-built-at': null, 'old-generation': false },
      { name: 'abc-3-a', ticket: 'ABC-3', variation: 'A', state: 'Running', 'disk-bytes': 1 * KB, 'last-accessed': '2026-10-22T00:00:00Z', deletable: false, 'golden-built-at': null, 'old-generation': false },
    ],
  });
  assert.deepEqual(Object.keys(d.vms()).sort(), ['abc-1-a', 'abc-3-a', 'abc-3-c', 'abc-3-d']);
  assert.equal(d.vms()['abc-3-c']['disk-bytes'], 2 * KB);
});

// ASS-240 AC3: limactl reports every VM "Broken" where it cannot read the Mac's boot session (sysctl
// kern.bootsessionuuid), as inside an agent's sandbox — the cause of example's vms.json all "Broken". There
// vm:inventory keeps each VM's recorded state; where it can, it writes lima's, a really broken VM's too.
test('ASS-240 AC3: vm:inventory blind to the boot session (an agent\'s sandbox) keeps each recorded state, not lima\'s false "Broken"; seeing it, lima\'s state is written', async () => {
  const d = disk();
  d.vm('abc-3-a', 1, 'Broken'); d.record('A', 'abc-3-a');
  d.vm('abc-3-c', 1, 'Broken'); d.record('C', 'abc-3-c');
  writeFileSync(d.at('projects', 'p', 'vms.json'), JSON.stringify({ 'abc-3-a': { ticket: 'ABC-3', variation: 'A', state: 'Running', 'disk-bytes': 0, 'last-accessed': '2026-10-01T00:00:00Z' } }));
  d.v.script('sysctl', 'echo "sysctl: kern.bootsessionuuid: Operation not permitted" >&2; exit 1');
  await d.inventory();
  assert.equal(d.vms()['abc-3-a'].state, 'Running', 'its recorded state kept');
  assert.equal(d.vms()['abc-3-c'].state, 'Broken', 'none recorded: lima\'s, the only one there is');
  d.v.script('sysctl', 'echo 0D4B2B56-0000-4000-8000-000000000000');
  await d.inventory();
  assert.equal(d.vms()['abc-3-a'].state, 'Broken', 'seen from outside the sandbox: lima\'s own');
});

test('the limit is project.json\'s vm-disk-limit-gb within harness.json\'s, the default and ceiling: above it, held to it with a warning; none in harness.json fails', async () => {
  const d = disk({ limit: 2 });
  assert.equal((await d.inventory())['limit-bytes'], 2e9, 'the harness default');
  edit(d.at('projects', 'p', 'project.json'), p => { p['vm-disk-limit-gb'] = 0.5; });
  assert.equal((await d.inventory())['limit-bytes'], 5e8);
  edit(d.at('projects', 'p', 'project.json'), p => { p['vm-disk-limit-gb'] = 3; });
  const { stdout, stderr } = await d.cli('vm:inventory', 'p');
  assert.equal(JSON.parse(stdout)['limit-bytes'], 2e9);
  assert.match(stderr, /p's vm-disk-limit-gb \(3\) is above harness\.json's \(2\); 2 is used/);
  edit(d.at('harness.json'), h => { delete h['vm-disk-limit-gb']; });
  await assert.rejects(d.cli('vm:inventory', 'p'), /harness\.json has no vm-disk-limit-gb/);
});

// 15.5 blocks: room for 15 (the limit is GB, so a fraction of one here), golden-p's 4 among them (ASS-287 AC3).
const ROOM = 15.5 * KB / 1e9;

test('vm:create deletes the least recently accessed stopped VMs no variation in flight needs, oldest first, until the new one fits — charged golden-p\'s size — and records it', async () => {
  const d = disk({ limit: ROOM });
  d.mount();
  d.vm('abc-3-c', 3, 'Stopped', '2026-09-01T00:00:00Z'); d.record('C', 'abc-3-c');   // the oldest, but C is in flight (local-testing)
  d.vm('abc-3-b', 1, 'Running', '2026-09-02T00:00:00Z'); d.record('B', 'abc-3-b');   // running
  d.vm('abc-1-a', 2, 'Stopped', '2026-10-01T00:00:00Z');                             // an ended sprint's
  d.vm('abc-3-d', 2, 'Stopped', '2026-10-05T00:00:00Z'); d.record('D', 'abc-3-d');   // set aside
  writeFileSync(d.at('projects', 'p', 'vms.json'), JSON.stringify({ 'abc-1-a': { ticket: 'ABC-1', variation: 'A', state: 'Stopped', 'disk-bytes': 0, 'last-accessed': '2026-10-01T00:00:00Z' } }));
  // 8 blocks used, golden-p's 4, 4 needed: one deletion (abc-1-a's 2) brings it to 14 of 15.
  const { stdout, stderr } = await d.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(JSON.parse(stdout).created, true);
  assert.match(stderr, /vm:create: deleted abc-1-a \(ABC-1 A, last accessed 2026-10-01T00:00:00Z, [\d.]+ GB\) to make room within p's VM disk limit/);
  assert.deepEqual(['abc-1-a', 'abc-3-b', 'abc-3-c', 'abc-3-d', 'abc-3-a'].map(d.exists), [false, true, true, true, true]);
  assert.deepEqual(Object.keys(d.vms()).sort(), ['abc-3-a', 'abc-3-b', 'abc-3-c', 'abc-3-d']);
  const entry = d.vms()['abc-3-a'];
  assert.deepEqual({ ...entry, 'last-accessed': undefined }, { ticket: 'ABC-3', variation: 'A', state: 'Running', 'disk-bytes': 0, 'last-accessed': undefined, 'credential-kind': 'claude' });   // ASS-215: vm:start records the fixture's declared kind
  assert.match(entry['last-accessed'], STAMP);
});

test('vm:create that cannot fit without deleting a running or in-flight VM deletes nothing, clones nothing and exits 3, naming the project, its limit, its use and the need — for the variation\'s ai-feedback', async () => {
  const d = disk({ limit: ROOM });
  d.mount();
  d.vm('abc-3-c', 6, 'Stopped', '2026-09-01T00:00:00Z'); d.record('C', 'abc-3-c');   // in flight
  d.vm('abc-3-b', 2, 'Running', '2026-09-02T00:00:00Z'); d.record('B', 'abc-3-b');   // running
  d.vm('abc-3-d', 1, 'Stopped', '2026-10-05T00:00:00Z'); d.record('D', 'abc-3-d');   // set aside: deletable, but 9 - 1 + 4 + 4 is still over
  const error = await d.cli('vm:create', 'p', 'ABC-3', 'A').then(() => null, e => e);
  assert.equal(error?.code, 3, error?.stderr);
  assert.match(error.stderr, /vm:create: p's VMs use [\d.]+ GB of its [\d.]+ GB VM disk limit \(vm-disk-limit-gb\), and abc-3-a needs [\d.]+ GB \(golden-p's size\); its golden images take [\d.]+ GB of it; nothing more may be deleted/);
  const feedback = JSON.parse(error.stdout);
  assert.equal(feedback['ai-feedback-short'], 'VM disk limit reached');
  assert.match(feedback['ai-feedback-long'], /^p's VMs use .* raise vm-disk-limit-gb\.$/);
  assert.deepEqual(['abc-3-d', 'abc-3-a'].map(d.exists), [true, false]);
  assert.equal(d.f.variation('A').vm, undefined);
});

test('vm:create for a variation whose VM was deleted recreates it from the golden image and records on the variation that it was', async () => {
  const d = disk();
  d.mount();
  d.record('A', 'abc-3-a');   // recorded, but deleted since
  const { stderr } = await d.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.match(stderr, /vm:create: abc-3-a was deleted; it is recreated from golden-p, and whatever was only on its old disk is lost/);
  assert.ok(d.exists('abc-3-a'));
  const vm = d.f.variation('A').vm;
  assert.match(vm['recreated-at'], STAMP);
  assert.equal(vm['created-at'], vm['recreated-at']);
});

test('vm:stop p <vm> stops one of p\'s VMs and records it accessed now; another\'s, or a golden image, it refuses', async () => {
  const d = disk();
  d.vm('abc-3-d', 1, 'Running'); d.record('D', 'abc-3-d');   // set aside, still running
  d.vm('xyz-1-a', 1, 'Running');
  await d.cli('vm:stop', 'p', 'abc-3-d');
  assert.equal(readFileSync(join(d.v.instances, 'abc-3-d', 'status'), 'utf8'), 'Stopped');
  assert.equal(d.vms()['abc-3-d'].state, 'Stopped');
  assert.ok(Date.now() - Date.parse(d.vms()['abc-3-d']['last-accessed']) < 60_000);
  await d.cli('vm:stop', 'p', 'abc-3-d');   // stopped already: nothing to do
  await assert.rejects(d.cli('vm:stop', 'p', 'xyz-1-a'), /vm:stop: xyz-1-a is not one of p's VMs/);
  await assert.rejects(d.cli('vm:stop', 'p', 'golden-p'), /vm:stop: golden-p is not one of p's VMs/);
  assert.equal(readFileSync(join(d.v.instances, 'xyz-1-a', 'status'), 'utf8'), 'Running');
});

// ASS-325: control deletes a VM whose variation reached a `vm: released` step (QA, say) through vm:delete, as make_room
// deletes one; a released variation is not in flight, so its stopped VM is deletable to make_room and vm:reclaim-all too.
test('ASS-325 AC2: vm:delete p <vm> deletes one of p\'s stopped VMs whose variation is not in flight — at a vm: released step — dropping its vms.json row and forwarder token; a running one, one whose variation is at a running or stopped step, another project\'s or a golden image it refuses', async () => {
  const d = disk();
  edit(d.at('engines', 'example-development', 'state-engine.json'), e => { e.steps.find(s => s.id === 'local-testing').vm = 'released'; e.steps.push({ id: 'blocked', sequence: 4, 'is-done': null, action: { type: 'none' }, vm: 'stopped' }); });
  d.vm('abc-3-c', 1, 'Stopped'); d.record('C', 'abc-3-c');   // at local-testing: released
  d.vm('abc-3-b', 1, 'Running'); d.record('B', 'abc-3-b');   // at local-testing, still running
  d.vm('abc-3-a', 1, 'Stopped'); d.record('A', 'abc-3-a');   // at generate-solution: running
  d.vm('xyz-1-a', 1, 'Stopped');
  edit(d.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features.push({ key: 'ABC-4', variations: [{ name: 'A', 'harness-status': { state: 'blocked', 'state-engine': 'example-development' }, vm: { name: 'abc-4-a' } }] }); });
  d.vm('abc-4-a', 1, 'Stopped');                              // at blocked: stopped, kept
  mkdirSync(join(d.home, '.harness'), { recursive: true });
  writeFileSync(join(d.home, '.harness', 'vm-tokens.json'), JSON.stringify({ 'abc-3-c': { hash: 'x' }, 'abc-3-a': { hash: 'y' } }));
  assert.deepEqual((await d.inventory()).vms.filter(v => v.deletable).map(v => v.name), ['abc-3-c'], 'released: not in flight');
  await d.cli('vm:delete', 'p', 'abc-3-c');
  assert.equal(d.exists('abc-3-c'), false);
  assert.equal(d.vms()['abc-3-c'], undefined);
  assert.deepEqual(Object.keys(d.tokens()), ['abc-3-a']);
  await assert.rejects(d.cli('vm:delete', 'p', 'abc-3-b'), /vm:delete: abc-3-b is running: vm:stop it first/);
  await assert.rejects(d.cli('vm:delete', 'p', 'abc-3-a'), /vm:delete: abc-3-a's variation is in flight/);
  await assert.rejects(d.cli('vm:delete', 'p', 'abc-4-a'), /vm:delete: abc-4-a's variation is in flight/);
  await assert.rejects(d.cli('vm:delete', 'p', 'xyz-1-a'), /vm:delete: xyz-1-a is not one of p's VMs/);
  await assert.rejects(d.cli('vm:delete', 'p', 'golden-p'), /vm:delete: golden-p is not one of p's VMs/);
  await assert.rejects(d.cli('vm:delete', 'p', 'abc-3-c'), /vm:delete: abc-3-c is not one of p's VMs/);   // gone now
  assert.deepEqual(['abc-3-b', 'abc-3-a', 'abc-4-a', 'xyz-1-a', 'golden-p'].map(d.exists), [true, true, true, true, true]);
});

test('two vm:creates of one VM at once (Setup\'s and control\'s) clone it once, under the project\'s VM lock, and both succeed', async () => {
  const d = disk();
  d.mount();
  const outs = await Promise.all([d.cli('vm:create', 'p', 'ABC-3', 'A'), d.cli('vm:create', 'p', 'ABC-3', 'A')]);
  assert.deepEqual(outs.map(o => JSON.parse(o.stdout).created).sort(), [false, true]);
  assert.equal(d.v.calls().filter(c => c.argv?.[0] === 'clone').length, 1);
});

// ASS-135: the inventory read the sprint and every engine's steps as jq arguments; a sprint past macOS's ARG_MAX
// (1 MB) failed with "Argument list too long". pad() grows ABC-3's sprint by 1.2 MB, a field nothing reads.
const pad = d => edit(d.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.padding = 'x'.repeat(1_200_000); });
const lastAccessedNow = inventory => ({ ...inventory, vms: inventory.vms.map(({ 'last-accessed': _, ...v }) => v) });

test('vm:inventory with a sprint file larger than 1 MB succeeds and gives the same inventory as with a small one', async () => {
  const scenario = async big => {
    const d = disk();
    d.vm('abc-3-a', 1, 'Running', '2026-10-22T00:00:00Z'); d.record('A', 'abc-3-a');
    d.vm('abc-3-c', 2, 'Stopped', '2026-10-10T00:00:00Z'); d.record('C', 'abc-3-c');
    d.vm('abc-3-d', 1, 'Stopped', '2026-10-11T00:00:00Z'); d.record('D', 'abc-3-d');
    if (big) pad(d);
    if (big) assert.ok(readFileSync(d.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json')).length > 1 << 20);
    return d.inventory();
  };
  const small = await scenario(false);
  assert.equal(small.vms.length, 3);
  assert.deepEqual(await scenario(true), small);
});

test('vm:stop with a sprint file larger than 1 MB stops the VM and records it, as with a small one', async () => {
  const scenario = async big => {
    const d = disk();
    d.vm('abc-3-d', 1, 'Running'); d.record('D', 'abc-3-d');
    if (big) pad(d);
    await d.cli('vm:stop', 'p', 'abc-3-d');
    assert.equal(readFileSync(join(d.v.instances, 'abc-3-d', 'status'), 'utf8'), 'Stopped');
    assert.ok(Date.now() - Date.parse(d.vms()['abc-3-d']['last-accessed']) < 60_000);
    return lastAccessedNow(await d.inventory());
  };
  const small = await scenario(false);
  assert.deepEqual(await scenario(true), small);
});

// ASS-287: golden generations. A VM holds a copy of the label of the golden image it was cloned from
// (golden-image.json, vm:create); a rebuild deletes that image, but on APFS its blocks stay while any clone
// references them. label(d, vm, builtAt) writes such a label; cloneOf(d, file, vm) makes vm's disk an APFS clone
// (clonefile: cp -c) of file, as limactl clone does; allocated(file) is what it has allocated (st_blocks).
const T1 = '2026-10-24T13:50:16Z', T2 = '2026-11-01T05:42:33Z';
const label = (d, vm, builtAt) => writeFileSync(join(d.v.instances, vm, 'golden-image.json'), JSON.stringify({ project: 'p', hash: (builtAt === T2 ? 'b' : 'a').repeat(64), 'built-at': builtAt }));
const cloneOf = (d, file, vm, status = 'Stopped') => { d.v.instance(vm, status); execFileSync('cp', ['-c', file, join(d.v.instances, vm, 'disk')]); };
const allocated = file => statSync(file).blocks * 512;
const entries = list => JSON.stringify(Object.fromEntries(list.map(([name, ticket, accessed]) => [name, { ticket, variation: 'A', state: 'Stopped', 'disk-bytes': 0, 'last-accessed': accessed ?? '2026-10-01T00:00:00Z' }])));

test('ASS-287 AC2: vm:inventory charges a VM cloned from an older golden generation (or none recorded) its allocated bytes — the deleted image\'s blocks it pins, shared with other clones or not — and one of the current generation its private bytes; golden images are counted apart', async () => {
  const d = disk();
  label(d, 'golden-p', T2);
  const old = join(d.v.dir, 'old-golden-disk');                                     // golden-p as built at T1, since deleted
  writeFileSync(old, randomBytes(8 * KB));
  cloneOf(d, old, 'abc-1-a'); label(d, 'abc-1-a', T1);
  appendFileSync(join(d.v.instances, 'abc-1-a', 'disk'), randomBytes(KB));         // one block its own
  cloneOf(d, old, 'abc-1-b'); label(d, 'abc-1-b', T1);
  rmSync(old);
  d.vm('abc-1-c', 2);                                                               // cloned before VMs recorded their image
  cloneOf(d, join(d.v.instances, 'golden-p', 'disk'), 'abc-2-a'); label(d, 'abc-2-a', T2);
  appendFileSync(join(d.v.instances, 'abc-2-a', 'disk'), randomBytes(KB));
  d.vm('golden-p-build', 2);                                                        // a failed build, left for inspection
  writeFileSync(d.at('projects', 'p', 'vms.json'), entries([['abc-1-a', 'ABC-1'], ['abc-1-b', 'ABC-1', '2026-10-02T00:00:00Z'], ['abc-1-c', 'ABC-1', '2026-10-03T00:00:00Z'], ['abc-2-a', 'ABC-2', '2026-10-04T00:00:00Z']]));
  const inventory = await d.inventory();
  const vm = Object.fromEntries(inventory.vms.map(v => [v.name, v]));
  assert.equal(allocated(join(d.v.instances, 'abc-1-a', 'disk')), 9 * KB);
  assert.deepEqual(['abc-1-a', 'abc-1-b', 'abc-1-c', 'abc-2-a'].map(n => [vm[n]['disk-bytes'], vm[n]['golden-built-at'], vm[n]['old-generation']]), [
    [9 * KB, T1, true],
    [8 * KB, T1, true],                                                              // its private size is 0 — every block shared with abc-1-a — yet it pins them
    [2 * KB, null, true],
    [1 * KB, T2, false],                                                             // the rest it shares with golden-p, counted once, as golden-p's
  ]);
  assert.deepEqual([inventory['use-bytes'], inventory['golden-bytes'], inventory['golden-built-at']], [20 * KB, 6 * KB, T2]);
});

test('ASS-287 AC3: vm:create with less free space on LIMA_HOME\'s volume (df) than golden-p\'s size deletes the least recently accessed deletable VMs until there is enough, though well within the project\'s limit', async () => {
  const d = disk({ limit: 100 });
  d.mount();
  d.vm('abc-3-c', 3, 'Stopped', '2026-09-01T00:00:00Z'); d.record('C', 'abc-3-c');   // the oldest, but in flight
  d.vm('abc-1-a', 2, 'Stopped', '2026-10-01T00:00:00Z');
  d.vm('abc-1-b', 2, 'Stopped', '2026-10-02T00:00:00Z');
  writeFileSync(d.at('projects', 'p', 'vms.json'), entries([['abc-1-a', 'ABC-1'], ['abc-1-b', 'ABC-1', '2026-10-02T00:00:00Z']]));
  const used = Number(execFileSync('du', ['-sk', d.v.instances], { encoding: 'utf8' }).split('\t')[0]);
  d.volume(used + 8);                                                               // 8 KiB free; golden-p's 16 KiB needed
  const { stdout, stderr } = await d.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(JSON.parse(stdout).created, true);
  assert.match(stderr, /vm:create: deleted abc-1-a \(ABC-1 A, last accessed 2026-10-01T00:00:00Z, [\d.]+ GB\) to make room on the volume holding .*: [\d.]+ GB free, and abc-3-a needs [\d.]+ GB/);
  assert.deepEqual(['abc-1-a', 'abc-1-b', 'abc-3-c', 'abc-3-a'].map(d.exists), [false, true, true, true]);
  assert.equal(readFileSync(join(d.v.dir, 'df-path'), 'utf8').trim(), d.v.instances, 'the volume holding LIMA_HOME');
});

test('ASS-287 AC3: vm:create that cannot get enough free space on the volume without deleting a running or in-flight VM deletes nothing, clones nothing and exits 3, naming the free-space shortfall', async () => {
  const d = disk({ limit: 100 });
  d.mount();
  d.vm('abc-3-c', 3, 'Stopped', '2026-09-01T00:00:00Z'); d.record('C', 'abc-3-c');   // in flight
  d.vm('abc-3-b', 2, 'Running', '2026-09-02T00:00:00Z'); d.record('B', 'abc-3-b');   // running
  d.vm('abc-3-d', 1, 'Stopped', '2026-10-05T00:00:00Z'); d.record('D', 'abc-3-d');   // set aside: deletable, but 8 + 4 KiB is still short of 16
  const used = Number(execFileSync('du', ['-sk', d.v.instances], { encoding: 'utf8' }).split('\t')[0]);
  d.volume(used + 8);
  const error = await d.cli('vm:create', 'p', 'ABC-3', 'A').then(() => null, e => e);
  assert.equal(error?.code, 3, error?.stderr);
  assert.match(error.stderr, /vm:create: the volume holding .* has [\d.]+ GB free, and abc-3-a needs [\d.]+ GB \(golden-p's size\): [\d.]+ GB short; nothing more of p's VMs may be deleted/);
  const feedback = JSON.parse(error.stdout);
  assert.equal(feedback['ai-feedback-short'], 'Disk volume full');
  assert.match(feedback['ai-feedback-long'], /^The volume holding .* GB short;/);
  assert.deepEqual(['abc-3-d', 'abc-3-a'].map(d.exists), [true, false]);
});

test('ASS-287 AC1: vm:reclaim p deletes p\'s stopped VMs of an older golden generation whose variation is not in flight; keeps running and in-flight ones, the current generation\'s and other projects\'; --dry-run only says what it would', async () => {
  const d = disk();
  label(d, 'golden-p', T2);
  d.vm('abc-1-a', 2, 'Stopped', '2026-10-01T00:00:00Z'); label(d, 'abc-1-a', T1);   // an ended sprint's: deleted
  d.vm('abc-3-c', 2, 'Stopped', '2026-10-03T00:00:00Z'); label(d, 'abc-3-c', T1); d.record('C', 'abc-3-c');   // in flight
  d.vm('abc-3-b', 1, 'Running', '2026-10-02T00:00:00Z'); label(d, 'abc-3-b', T1); d.record('B', 'abc-3-b');   // running
  d.vm('abc-3-d', 1, 'Stopped', '2026-10-04T00:00:00Z'); label(d, 'abc-3-d', T2); d.record('D', 'abc-3-d');   // set aside, but the current generation's
  d.vm('xyz-1-a', 1); label(d, 'xyz-1-a', T1);                                       // not p's
  writeFileSync(d.at('projects', 'p', 'vms.json'), entries([['abc-1-a', 'ABC-1']]));
  writeFileSync(join(d.home, '.harness', 'vm-tokens.json'), JSON.stringify({ 'abc-1-a': { hash: 'x' }, 'abc-3-b': { hash: 'y' } }));
  const reclaim = async (...args) => JSON.parse((await d.cli('vm:reclaim', 'p', ...args)).stdout);
  const plan = {
    project: 'p', 'golden-built-at': T2, 'dry-run': true,
    deleted: [{ name: 'abc-1-a', ticket: 'ABC-1', variation: 'A', 'golden-built-at': T1, 'disk-bytes': 2 * KB }],
    kept: [
      { name: 'abc-3-b', ticket: 'ABC-3', variation: 'B', 'golden-built-at': T1, 'disk-bytes': 1 * KB, why: 'running' },
      { name: 'abc-3-c', ticket: 'ABC-3', variation: 'C', 'golden-built-at': T1, 'disk-bytes': 2 * KB, why: 'its variation is in flight' },
    ],
  };
  assert.deepEqual(await reclaim('--dry-run'), plan);
  assert.deepEqual(['abc-1-a', 'abc-3-b', 'abc-3-c', 'abc-3-d', 'xyz-1-a'].map(d.exists), [true, true, true, true, true]);
  assert.deepEqual(await reclaim(), { ...plan, 'dry-run': false });
  assert.deepEqual(['abc-1-a', 'abc-3-b', 'abc-3-c', 'abc-3-d', 'xyz-1-a'].map(d.exists), [false, true, true, true, true]);
  assert.equal(d.vms()['abc-1-a'], undefined);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(d.home, '.harness', 'vm-tokens.json'), 'utf8'))), ['abc-3-b']);
  assert.deepEqual((await reclaim()).deleted, [], 'nothing more to reclaim');
  await assert.rejects(d.cli('vm:reclaim', 'p', '--now'), /usage: vm:reclaim <project> \[--dry-run\]/);
});

// ASS-289: a failed golden build's VM (golden-p-build), left over. holdLock(file) holds a lock on file, as a
// running vm:build-golden holds golden-build.lock, until released.
async function holdLock(file) {
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 60', file]);
  await new Promise(resolve => holder.stdout.once('data', resolve));
  return { release: () => holder.kill('SIGKILL') };
}
const status = (d, vm, state) => writeFileSync(join(d.v.instances, vm, 'status'), state);

test('ASS-289 AC2: vm:inventory reports a leftover golden-p-build apart from the ticket VMs, with its disk bytes, deletable once stopped; running, or stopped while a build holds golden-build.lock (in progress), it is not', async () => {
  const d = disk();
  assert.equal((await d.inventory())['golden-build'], null, 'none left over');
  d.vm('golden-p-build', 3, 'Running', '2026-10-15T00:00:00Z');
  d.vm('abc-1-a', 1, 'Stopped', '2026-10-01T00:00:00Z');
  writeFileSync(d.at('projects', 'p', 'vms.json'), entries([['abc-1-a', 'ABC-1']]));
  const build = state => ({ name: 'golden-p-build', state, 'disk-bytes': 3 * KB, 'last-accessed': '2026-10-15T00:00:00Z' });
  let inventory = await d.inventory();
  assert.deepEqual(inventory['golden-build'], { ...build('Running'), leftover: true, deletable: false });
  assert.deepEqual(inventory.vms.map(v => v.name), ['abc-1-a'], 'not a ticket VM');
  assert.deepEqual([inventory['use-bytes'], inventory['golden-bytes']], [1 * KB, 7 * KB]);
  assert.equal(d.vms()['golden-p-build'], undefined, 'never taken into vms.json');

  status(d, 'golden-p-build', 'Stopped');
  inventory = await d.inventory();
  assert.deepEqual(inventory['golden-build'], { ...build('Stopped'), leftover: true, deletable: true });

  const lock = await holdLock(d.at('projects', 'p', 'golden-build.lock'));            // a build in progress, between its stop and start
  try {
    assert.deepEqual((await d.inventory())['golden-build'], { ...build('Stopped'), leftover: false, deletable: false });
  } finally { lock.release(); }

  writeFileSync(d.at('projects', 'p', 'golden-build-run.json'), JSON.stringify({ pid: process.pid, 'started-at': '2026-11-07T00:00:00Z' }));   // one vm:build-golden-start started, still going
  assert.equal((await d.inventory())['golden-build'].deletable, false);
  writeFileSync(d.at('projects', 'p', 'golden-build-run.exit'), '1\n');                // it ended: failed
  assert.equal((await d.inventory())['golden-build'].deletable, true);
});

test('ASS-289 AC3: vm:create deletes a stopped leftover golden-p-build before any ticket VM, less recently accessed though they are, to fit within p\'s VM disk limit', async () => {
  const d = disk({ limit: ROOM });
  d.mount();
  d.vm('golden-p-build', 3, 'Stopped', '2026-10-15T00:00:00Z');
  d.vm('abc-1-a', 5, 'Stopped', '2026-10-01T00:00:00Z');
  writeFileSync(d.at('projects', 'p', 'vms.json'), entries([['abc-1-a', 'ABC-1']]));
  // 5 blocks used, golden images 4 + 3, 4 needed: 16 of 15; deleting the build's 3 brings it to 13.
  const { stdout, stderr } = await d.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(JSON.parse(stdout).created, true);
  assert.match(stderr, /vm:create: deleted golden-p-build \(p's leftover golden image build, last accessed 2026-10-15T00:00:00Z, [\d.]+ GB\) to make room within p's VM disk limit/);
  assert.ok(!/deleted abc-1-a/.test(stderr), stderr);
  assert.deepEqual(['golden-p-build', 'abc-1-a', 'abc-3-a'].map(d.exists), [false, true, true]);
});

test('ASS-289 AC3: vm:create short of free space on the volume deletes a stopped leftover golden-p-build before any ticket VM', async () => {
  const d = disk({ limit: 100 });
  d.mount();
  d.vm('golden-p-build', 3, 'Stopped', '2026-10-15T00:00:00Z');
  d.vm('abc-1-a', 2, 'Stopped', '2026-10-01T00:00:00Z');
  writeFileSync(d.at('projects', 'p', 'vms.json'), entries([['abc-1-a', 'ABC-1']]));
  const used = Number(execFileSync('du', ['-sk', d.v.instances], { encoding: 'utf8' }).split('\t')[0]);
  d.volume(used + 8);                                                               // 8 KiB free; golden-p's 16 KiB needed; the build holds 12
  const { stderr } = await d.cli('vm:create', 'p', 'ABC-3', 'A');
  assert.match(stderr, /vm:create: deleted golden-p-build \(p's leftover golden image build, last accessed 2026-10-15T00:00:00Z, [\d.]+ GB\) to make room on the volume holding/);
  assert.deepEqual(['golden-p-build', 'abc-1-a', 'abc-3-a'].map(d.exists), [false, true, true]);
});

test('ASS-289 AC3: vm:create never deletes golden-p-build while a build is in progress (golden-build.lock held), stopped though it is; nor a running one', async () => {
  for (const inProgress of [true, false]) {
    const d = disk({ limit: ROOM });
    d.mount();
    d.vm('golden-p-build', 3, inProgress ? 'Stopped' : 'Running', '2026-10-15T00:00:00Z');
    d.vm('abc-1-a', 5, 'Stopped', '2026-10-01T00:00:00Z');
    writeFileSync(d.at('projects', 'p', 'vms.json'), entries([['abc-1-a', 'ABC-1']]));
    const lock = inProgress ? await holdLock(d.at('projects', 'p', 'golden-build.lock')) : { release() {} };
    try {
      const { stderr } = await d.cli('vm:create', 'p', 'ABC-3', 'A');
      assert.match(stderr, /vm:create: deleted abc-1-a/);
      assert.deepEqual(['golden-p-build', 'abc-1-a', 'abc-3-a'].map(d.exists), [true, false, true]);
    } finally { lock.release(); }
  }
});
