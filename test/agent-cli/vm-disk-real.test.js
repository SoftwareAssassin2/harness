// A real VM's disk (ASS-75): run only with HARNESS_VM_TESTS=1, on the Mac the
// VMs run on — it needs Lima and the golden-harness image. It clones a
// throwaway VM, ass-75-disk-a, from golden-harness (never started), and
// deletes it after: vm:inventory, through the real limactl list, finds it in
// a temp harness project's inventory and charges it its APFS private size —
// next to nothing, the clone sharing every block with golden-harness, which
// `du` would count in full — and never lists the golden image.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limaHome } from '../../src/control/vm.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const VM = 'ass-75-disk-a', LIMA = { ...process.env, LIMA_HOME: limaHome() };
const skip = process.env.HARNESS_VM_TESTS !== '1' && 'set HARNESS_VM_TESTS=1 to run against a real VM';
const deleteVm = () => { try { execFileSync('limactl', ['delete', '-f', VM], { env: LIMA, stdio: 'ignore' }); } catch { /* none */ } };

after(() => { if (!skip) deleteVm(); });

test('a real clone of golden-harness is charged its APFS private size — not the golden image\'s blocks it shares — and the golden image is never listed', { skip, timeout: 120_000 }, async () => {
  deleteVm();
  execFileSync('limactl', ['clone', '--tty=false', 'golden-harness', VM], { env: LIMA, stdio: 'ignore' });
  const dir = mkdtempSync(join(tmpdir(), 'vm-disk-'));
  mkdirSync(join(dir, 'projects', 'harness'), { recursive: true });
  writeFileSync(join(dir, 'projects', 'harness', 'project.json'), JSON.stringify({ name: 'Harness' }));
  writeFileSync(join(dir, 'projects', 'harness', 'vms.json'), JSON.stringify({ [VM]: { ticket: 'ASS-75', variation: 'A', state: 'Stopped', 'disk-bytes': 0, 'last-accessed': '2026-10-24T00:00:00Z' } }));
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ 'vm-disk-limit-gb': 200 }));
  const env = { ...LIMA, PROJECTS_DIR: join(dir, 'projects'), HARNESS_FILE: join(dir, 'harness.json'), HARNESS_HOME: join(dir, 'home') };
  const inventory = JSON.parse((await run(AGENT, ['vm:inventory', 'harness'], { env })).stdout);
  assert.deepEqual(inventory.vms.map(v => [v.name, v.state, v.deletable]), [[VM, 'Stopped', true]]);
  const golden = Number(execFileSync('du', ['-sk', join(LIMA.LIMA_HOME, 'golden-harness', 'disk')], { encoding: 'utf8' }).split('\t')[0]) * 1024;
  const clone = Number(execFileSync('du', ['-sk', join(LIMA.LIMA_HOME, VM, 'disk')], { encoding: 'utf8' }).split('\t')[0]) * 1024;
  assert.ok(clone > 1e9 && golden > 1e9, `du counts the shared blocks: golden ${golden}, clone ${clone}`);
  assert.ok(inventory.vms[0]['disk-bytes'] < 50e6, `the clone's own: ${inventory.vms[0]['disk-bytes']}`);
});
