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
import { writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
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
    project: 'p', 'limit-bytes': 1e9, 'use-bytes': 7 * KB,
    vms: [
      { name: 'abc-1-a', ticket: 'ABC-1', variation: 'A', state: 'Stopped', 'disk-bytes': 3 * KB, 'last-accessed': '2026-10-01T00:00:00Z', deletable: true },
      { name: 'abc-3-c', ticket: 'ABC-3', variation: 'C', state: 'Stopped', 'disk-bytes': 2 * KB, 'last-accessed': '2026-10-10T00:00:00Z', deletable: false },
      { name: 'abc-3-d', ticket: 'ABC-3', variation: 'D', state: 'Stopped', 'disk-bytes': 1 * KB, 'last-accessed': '2026-10-11T00:00:00Z', deletable: true },
      { name: 'abc-3-a', ticket: 'ABC-3', variation: 'A', state: 'Running', 'disk-bytes': 1 * KB, 'last-accessed': '2026-10-22T00:00:00Z', deletable: false },
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

// 11.5 blocks: room for 11 (the limit is GB, so a fraction of one here).
const ROOM = 11.5 * KB / 1e9;

test('vm:create deletes the least recently accessed stopped VMs no variation in flight needs, oldest first, until the new one fits — charged golden-p\'s size — and records it', async () => {
  const d = disk({ limit: ROOM });
  d.mount();
  d.vm('abc-3-c', 3, 'Stopped', '2026-09-01T00:00:00Z'); d.record('C', 'abc-3-c');   // the oldest, but C is in flight (local-testing)
  d.vm('abc-3-b', 1, 'Running', '2026-09-02T00:00:00Z'); d.record('B', 'abc-3-b');   // running
  d.vm('abc-1-a', 2, 'Stopped', '2026-10-01T00:00:00Z');                             // an ended sprint's
  d.vm('abc-3-d', 2, 'Stopped', '2026-10-05T00:00:00Z'); d.record('D', 'abc-3-d');   // set aside
  writeFileSync(d.at('projects', 'p', 'vms.json'), JSON.stringify({ 'abc-1-a': { ticket: 'ABC-1', variation: 'A', state: 'Stopped', 'disk-bytes': 0, 'last-accessed': '2026-10-01T00:00:00Z' } }));
  // 8 blocks used, 4 needed: one deletion (abc-1-a's 2) brings it to 10 of 11.
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
  d.vm('abc-3-d', 1, 'Stopped', '2026-10-05T00:00:00Z'); d.record('D', 'abc-3-d');   // set aside: deletable, but 9 - 1 + 4 is still over
  const error = await d.cli('vm:create', 'p', 'ABC-3', 'A').then(() => null, e => e);
  assert.equal(error?.code, 3, error?.stderr);
  assert.match(error.stderr, /vm:create: p's VMs use [\d.]+ GB of its [\d.]+ GB VM disk limit \(vm-disk-limit-gb\), and abc-3-a needs [\d.]+ GB \(golden-p's size\); nothing more may be deleted/);
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
