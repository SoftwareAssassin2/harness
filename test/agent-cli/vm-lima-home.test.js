// ASS-578 AC1: a project may keep its Lima VMs and golden image in a folder of its own (project.json lima-home); every
// Lima operation for that project — create, start, credentials, stop, delete, ports, the inventory — runs with that
// folder as LIMA_HOME, and a project without one keeps the harness-wide folder. The fake limactl keeps its instances
// in the LIMA_HOME it is run with and logs it on every call (FAKE_LIMA_BY_HOME), so a call made with the wrong folder
// both shows in the log and finds no instance. (The golden build: vm-build-golden.test.js; the hand-over:
// hand-over-stopped-vm.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lima, edit } from './vm-fixture.js';
import { run, AGENT } from './harness-fixture.js';

// setup(own) — vm-fixture's project p, its golden-p in its own Lima folder when own, else the harness-wide one
// (LIMA_HOME, the fixture's instances folder); and a second project q, without a lima-home, its golden-q harness-wide.
function setup(own) {
  const l = lima();
  const folder = own ? realpathSync(mkdtempSync(join(tmpdir(), 'own-lima-'))) : l.v.instances;
  if (own) {
    edit(join(l.f.dir, 'projects', 'p', 'project.json'), p => { p['lima-home'] = folder; });
    renameSync(join(l.v.instances, 'golden-p'), join(folder, 'golden-p'));
  }
  const pj = JSON.parse(readFileSync(join(l.f.dir, 'projects', 'p', 'project.json'), 'utf8'));
  delete pj['lima-home'];
  mkdirSync(join(l.f.dir, 'projects', 'q'), { recursive: true });
  writeFileSync(join(l.f.dir, 'projects', 'q', 'project.json'), JSON.stringify({ ...pj, name: 'Q' }));
  l.v.instance('golden-q');
  l.mount();
  Object.assign(l.env, { FAKE_LIMA_BY_HOME: '1' });
  const homes = () => l.v.calls().map(c => c.home);
  return { ...l, folder, homes };
}

for (const own of [true, false]) {
  test(`ASS-578 AC1: ${own ? 'with its own lima-home, every Lima operation for the project runs in its folder' : 'without a lima-home, the project\'s Lima operations run in the harness-wide folder, as before'} — create, start, credentials, stop, ports, inventory, delete`, async () => {
    const s = setup(own);
    const created = JSON.parse((await s.cli('vm:create', 'p', 'ABC-3', 'A')).stdout);
    assert.equal(created.name, 'abc-3-a');
    assert.ok(existsSync(join(s.folder, 'abc-3-a')), 'cloned beside its golden image');
    if (own) assert.ok(!existsSync(join(s.v.instances, 'abc-3-a')), 'nothing in the harness-wide folder');
    await s.cli('vm:start', 'p', 'ABC-3', 'A');
    await s.cli('vm:credentials', 'p', 'abc-3-a');
    await s.cli('vm:stop', 'p', 'abc-3-a');
    await s.cli('vm:ports');
    const inventory = JSON.parse((await s.cli('vm:inventory', 'p')).stdout);
    assert.deepEqual(inventory.vms.map(v => [v.name, v.state]), [['abc-3-a', 'Stopped']]);
    await s.cli('vm:delete', 'p', 'abc-3-a');
    assert.ok(!existsSync(join(s.folder, 'abc-3-a')), 'deleted from its folder');
    const calls = s.v.calls();
    const kind = c => ('vm' in c ? 'shell' : c.argv[0]);
    const kinds = new Set(calls.map(kind));
    for (const kind of ['clone', 'start', 'shell', 'stop', 'list', 'delete']) assert.ok(kinds.has(kind), `limactl ${kind} ran`);
    // vm:ports lists every folder in use: p's own and the harness-wide one (golden-q's) — only that list may run outside p's.
    const elsewhere = calls.filter(c => c.home !== s.folder && !(kind(c) === 'list' && c.argv.length === 3));
    assert.deepEqual(elsewhere, [], `every call for p ran with LIMA_HOME ${s.folder}`);
    // The other project, without a lima-home, in the harness-wide folder.
    const before = s.v.calls().length;
    const q = JSON.parse((await s.cli('vm:inventory', 'q')).stdout);
    assert.equal(q.project, 'q');
    assert.ok(s.v.calls().slice(before).every(c => c.home === s.v.instances), 'q ran with the harness-wide folder');
    if (own) assert.ok(s.v.calls().slice(before).length > 0);
  });
}

test('ASS-578 AC1: vm:ports sees the pins of every Lima folder in use, so a clone in a project\'s own folder never takes a port pinned in the harness-wide one', async () => {
  const s = setup(true);
  s.v.instance('xyz-10-a', 'Stopped', '45678');   // harness-wide, another project's
  const ports = JSON.parse((await s.cli('vm:ports')).stdout);
  assert.ok(ports.vms.some(v => v.name === 'xyz-10-a' && v.port === 45678 && v.status === 'Stopped'), JSON.stringify(ports));
  await s.cli('vm:create', 'p', 'ABC-3', 'A');
  const set = s.v.calls().find(c => !('vm' in c) && c.argv[0] === 'clone').argv.at(-1);
  assert.doesNotMatch(set, /\.ssh\.localPort = 45678$/);
  const env = { ...s.env, VM_PORT_TRY: '45678' };
  await s.cli('vm:stop', 'p', 'abc-3-a');
  await s.cli('vm:delete', 'p', 'abc-3-a');
  await run(AGENT, ['vm:create', 'p', 'ABC-3', 'A'], { env });
  const second = s.v.calls().filter(c => !('vm' in c) && c.argv[0] === 'clone').at(-1).argv.at(-1);
  assert.doesNotMatch(second, /\.ssh\.localPort = 45678$/, 'the harness-wide pin is passed over');
});

test('ASS-578: a project.json lima-home that is not an absolute path is refused by its VM commands, naming it, and nothing is made', async () => {
  const s = setup(false);
  edit(join(s.f.dir, 'projects', 'p', 'project.json'), p => { p['lima-home'] = 'relative/lima'; });
  await assert.rejects(run(AGENT, ['vm:create', 'p', 'ABC-3', 'A'], { env: s.env }), /lima-home 'relative\/lima' is not an absolute path/);
  assert.equal(s.v.calls().filter(c => !('vm' in c) && c.argv[0] === 'clone').length, 0);
});
