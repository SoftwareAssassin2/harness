// vm:setup-complete and vm:mark-setup-complete (ASS-68 AC7): the Setup
// group's first step asks whether the variation's VM holds the
// setup-complete marker, its last step writes it there. limactl is
// test/support/fake-limactl.js; the VM's root a folder (HARNESS_VM_ROOT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';
import { fakeVm } from '../support/fake-vm.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

// ABC-3 A, its VM abc-3-a recorded (unless recorded is false) and in the given Lima status; able to run an agent (ASS-234):
// claude on its PATH, vm:start's agent-url and vm:credentials' env file in /run/harness.
function setup({ recorded = true, status = 'Running' } = {}) {
  const f = fixture(), v = fakeVm({ ...f.env, PATH: f.env.PATH.split(':').filter(d => !existsSync(join(d, 'claude'))).join(':') });   // the Mac's own claude never answers for the VM's
  v.instance('abc-3-a', status);
  mkdirSync(join(v.root, 'repos'));   // as the golden image holds it
  mkdirSync(join(v.root, 'run', 'harness'), { recursive: true });
  writeFileSync(join(v.root, 'run', 'harness', 'agent-url'), 'http://host.lima.internal:7787/run\n');
  writeFileSync(join(v.root, 'run', 'harness', 'env'), 'GH_CONFIG_DIR=/run/harness/gh\n');
  v.inVm('claude', 'echo claude');
  if (recorded) edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0].vm = { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' }; });
  const cli = (...args) => run(AGENT, args, { env: v.env });
  return { f, v, cli, marker: join(v.root, 'repos', '.setup-complete') };
}

test('vm:setup-complete exits 1 until vm:mark-setup-complete writes the marker in the variation\'s VM, then 0', async () => {
  const s = setup();
  await assert.rejects(s.cli('vm:setup-complete', 'p', 'ABC-3', 'A'), e => e.code === 1);   // a setup that stopped part way: no marker
  await s.cli('vm:mark-setup-complete', 'p', 'ABC-3', 'A');
  assert.ok(existsSync(s.marker));
  assert.ok(s.v.calls().some(c => c.vm === 'abc-3-a'), 'written in the VM');
  const { stdout } = await s.cli('vm:setup-complete', 'p', 'ABC-3', 'A');
  assert.equal(stdout, '');
});

test('vm:setup-complete is not complete with no VM recorded on the variation, or its VM not running — never starting it', async () => {
  const none = setup({ recorded: false }), stopped = setup({ status: 'Stopped' });
  for (const s of [none, stopped]) writeFileSync(s.marker, '');   // a marker there all the same
  await assert.rejects(none.cli('vm:setup-complete', 'p', 'ABC-3', 'A'), e => e.code === 1);
  await assert.rejects(stopped.cli('vm:setup-complete', 'p', 'ABC-3', 'A'), e => e.code === 1);
  assert.ok(!stopped.v.calls().some(c => c.argv[0] === 'start'));
  await assert.rejects(stopped.cli('vm:setup-complete', 'p', 'ABC-3', 'Z'), /no ABC-3 variation Z/);
});

test('vm:mark-setup-complete fails without a VM recorded, or one it cannot reach', async () => {
  const none = setup({ recorded: false });
  await assert.rejects(none.cli('vm:mark-setup-complete', 'p', 'ABC-3', 'A'), /ABC-3 A has no VM: vm:create it first/);
  const stopped = setup({ status: 'Stopped' });
  await assert.rejects(stopped.cli('vm:mark-setup-complete', 'p', 'ABC-3', 'A'), /abc-3-a is not running/);
  assert.ok(!existsSync(stopped.marker));
});

// ASS-234 AC1: Setup proves the VM can run an agent before it is complete: claude on its PATH, the forwarder's URL
// (vm:start) and the credential env file (vm:credentials). Each one missing is named, and no marker is written.
test('ASS-234 AC1: vm:mark-setup-complete fails, naming each missing probe, without writing the marker', async () => {
  const missing = {
    'claude (command -v claude)': s => rmSync(join(s.v.dir, 'vm-bin', 'claude')),
    '/run/harness/agent-url': s => rmSync(join(s.v.root, 'run', 'harness', 'agent-url')),
    '/run/harness/env': s => rmSync(join(s.v.root, 'run', 'harness', 'env')),
  };
  for (const [name, remove] of Object.entries(missing)) {
    const s = setup();
    remove(s);
    await assert.rejects(s.cli('vm:mark-setup-complete', 'p', 'ABC-3', 'A'), e => e.stderr.includes(`abc-3-a cannot run an agent: missing ${name}`) && e.code === 1, name);
    assert.ok(!existsSync(s.marker), name);
  }
  const s = setup();
  for (const remove of Object.values(missing).slice(1)) remove(s);
  await assert.rejects(s.cli('vm:mark-setup-complete', 'p', 'ABC-3', 'A'), /missing \/run\/harness\/agent-url, \/run\/harness\/env; Setup stays incomplete/);
  assert.ok(!existsSync(s.marker));
});
