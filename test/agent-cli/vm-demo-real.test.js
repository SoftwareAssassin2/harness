// The Demo action in a real VM (ASS-76 AC2, AC3): run only with
// HARNESS_VM_TESTS=1, on the Mac the VMs run on — it needs Lima, the
// golden-harness image (with its desktop, desktop.sh) and the network (master
// is fetched). It makes a throwaway VM, demo-1-a, for a ticket DEMO-1 of a
// temp copy of the harness project, through vm:create, and deletes it after.
// vm:demo, with a terminal demo plan whose setup leaves a server-like process
// in the background, brings it back up with a display — a window onto its
// desktop opens on the Mac while this runs — passes the ready-check, and
// starts lightdm, the VM user's Xfce session and xfce4-terminal; asked
// again with a browser plan, Firefox ESR at the address. Stopped and
// started again by vm:start, as control does once the variation moves on, it
// comes back without a display or a desktop.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limaHome } from '../../src/control/vm.js';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const AGENT = join(ROOT, 'agent.sh');
const VM = 'demo-1-a', LIMA = { ...process.env, LIMA_HOME: limaHome() };
const skip = process.env.HARNESS_VM_TESTS !== '1' && 'set HARNESS_VM_TESTS=1 to run against a real VM';
const deleteVm = () => { try { execFileSync('limactl', ['delete', '-f', VM], { env: LIMA, stdio: 'ignore' }); } catch { /* none */ } };
const inVm = command => run('limactl', ['shell', '--workdir', '/', VM, '--', 'bash', '-c', command], { env: LIMA }).then(r => r.stdout.trim(), e => `${e.stdout}${e.stderr}`.trim());
const lima = () => execFileSync('limactl', ['list', VM, '--format', '{{.Status}} {{.Config.Video.Display}}'], { env: LIMA, encoding: 'utf8' }).trim();

after(() => { if (!skip) deleteVm(); });

test('vm:demo in a real VM: up with a display, the setup run, the ready-check passed, lightdm, the Xfce session and the terminal running; vm:stop and vm:start bring it back without them', { skip, timeout: 900_000 }, async () => {
  deleteVm();
  const dir = mkdtempSync(join(tmpdir(), 'demo-'));
  const project = JSON.parse(readFileSync(join(ROOT, 'data', 'projects', 'harness', 'project.json'), 'utf8'));
  const p = join(dir, 'projects', 'harness');
  mkdirSync(join(p, 'sprints', 'sprint-1'), { recursive: true });
  writeFileSync(join(p, 'project.json'), JSON.stringify(project));
  writeFileSync(join(p, 'sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': true }] }));
  writeFileSync(join(p, 'sprints', 'sprint-1', 'sprint.json'), JSON.stringify({ number: 1, features: [{ key: 'DEMO-1', variations: [{ name: 'A', 'harness-status': { state: 'review', 'state-engine': 'harness-development-v2', 'sub-status': { state: 'human-review', 'state-engine': 'v2-review' } } }] }] }));
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ 'forwarder-port': 7799, 'vm-disk-limit-gb': 1000 }));
  writeFileSync(join(dir, 'assignments.json'), JSON.stringify({ assignments: [] }));
  const env = { ...LIMA, PROJECTS_DIR: join(dir, 'projects'), HARNESS_FILE: join(dir, 'harness.json'), ASSIGNMENTS_FILE: join(dir, 'assignments.json'), HARNESS_HOME: join(dir, 'home'), ACLI_DISABLED: '1' };
  const cli = (...args) => run(AGENT, args, { env });

  assert.equal(JSON.parse((await cli('vm:create', 'harness', 'DEMO-1', 'A')).stdout).name, VM);
  assert.equal(lima(), 'Running none');
  writeFileSync(join(p, 'work', 'DEMO-1', 'demo-plan-A.json'), JSON.stringify({
    demo: true,
    setup: ['ls -d /repos/harness > /tmp/demo-setup.txt', 'nohup bash -c "sleep 5; touch /tmp/demo-up; sleep 600" &'],
    'ready-check': 'test -e /tmp/demo-up',
    view: { with: 'terminal', commands: ['cat /tmp/demo-setup.txt'] },
    'look-at': ['the setup wrote /repos/harness'],
  }));

  const started = Date.now();
  const out = JSON.parse((await cli('vm:demo', 'harness', 'DEMO-1', 'A')).stdout);
  console.log(`vm:demo took ${Math.round((Date.now() - started) / 1000)}s`);
  assert.equal(out.name, VM);
  assert.equal(lima(), 'Running vz');
  assert.equal(await inVm('cat /tmp/demo-setup.txt'), '/repos/harness');
  assert.equal(await inVm('test -e /tmp/demo-up && echo up'), 'up');
  assert.equal(await inVm('systemctl is-active lightdm'), 'active');
  assert.match(await inVm('pgrep -u "$(id -un)" -x xfce4-session'), /^\d+$/);
  assert.match(await inVm('pgrep -u "$(id -un)" -f xfce4-terminal'), /\d/);
  assert.match(await inVm('cat /tmp/harness-demo.rc'), /history -s cat\\ \/tmp\/demo-setup\.txt/);
  const accessed = JSON.parse(readFileSync(join(p, 'vms.json'), 'utf8'))[VM]['last-accessed'];
  assert.ok(Date.parse(accessed) >= started - 1000, `accessed ${accessed}`);

  // Again, with the browser: the VM taken as it runs, Firefox opened at the address.
  const plan = JSON.parse(readFileSync(join(p, 'work', 'DEMO-1', 'demo-plan-A.json'), 'utf8'));
  writeFileSync(join(p, 'work', 'DEMO-1', 'demo-plan-A.json'), JSON.stringify({ ...plan, view: { with: 'browser', address: 'file:///tmp/demo-setup.txt' } }));
  await cli('vm:demo', 'harness', 'DEMO-1', 'A');
  assert.equal(lima(), 'Running vz');
  assert.match(await inVm('sleep 3; pgrep -u "$(id -un)" -a firefox-esr | head -n 1'), /firefox-esr.*file:\/\/\/tmp\/demo-setup\.txt/);

  await cli('vm:stop', 'harness', VM);
  await cli('vm:start', 'harness', 'DEMO-1', 'A');
  assert.equal(lima(), 'Running none');
  assert.equal(await inVm('systemctl is-active lightdm'), 'inactive');
});
