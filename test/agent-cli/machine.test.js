// The machine layer for the bash commands (src/agent-cli/machine.bash,
// ASS-432 AC1): a ticket variation's machine named from what it records (its
// vm { name, kind }: $machine_of, so vm.bash recorded_vm and code.bash vm_of),
// Lima the only backend, and each operation — a command run in it (workdir,
// stdin, exit code, a marker to stop it by), files copied in and out, status,
// start and stop — through test/support/fake-limactl.js on PATH as the Lima
// backend's limactl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVm } from '../support/fake-vm.js';

const run = promisify(execFile);
const MACHINE = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'machine.bash');
// bash(script, env) — the script run with machine.bash sourced: { code, out, err }.
const bash = (script, env) => run('bash', ['-c', `source "${MACHINE}" && ${script}`], { env }).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));
const until = async (check, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (check()) return true; return check(); };

function lima() {
  const v = fakeVm({ ...process.env, LIMA_HOME: mkdtempSync(join(tmpdir(), 'lima-home-')) });
  v.instance('ass-74-a', 'Running', '60022');
  return v;
}

test('$machine_of: a variation\'s machine is its VM\'s Lima name without a kind or with kind lima, <kind>:<name> for any other, "" without a VM', async () => {
  const of = vm => bash(`jq -r "$machine_of" <<< '${JSON.stringify({ name: 'A', ...(vm ? { vm } : {}) })}'`, process.env).then(r => r.out);
  assert.equal(await of({ name: 'ass-74-a', ip: '192.168.64.15' }), 'ass-74-a\n');
  assert.equal(await of({ name: 'ass-74-a', kind: 'lima' }), 'ass-74-a\n');
  assert.equal(await of({ name: 'box-1', kind: 'other' }), 'other:box-1\n');
  // ASS-435: a workstation's is workstation:<project>:<id>:<folder>, from its placement's project and folder.
  assert.equal(await of({ name: 'ws-1', kind: 'workstation', project: 'p', folder: '/home/me/harness/ASS-1-A' }), 'workstation:p:ws-1:/home/me/harness/ASS-1-A\n');
  assert.equal(await of(null), '\n');
});

test('machine_backend: lima for a Lima name; a kind with no backend fails, naming it, and so does every operation on its machine', async () => {
  assert.deepEqual(await bash('machine_backend ass-74-a', process.env), { code: 0, out: 'lima\n', err: '' });
  assert.deepEqual(await bash('machine_backend workstation:p:ws-1:/home/me/harness/ASS-1-A', process.env), { code: 0, out: 'workstation\n', err: '' });   // ASS-435
  const refused = await bash('machine_run other:box-1 -- true', process.env);
  assert.equal(refused.code, 1);
  assert.equal(refused.err, "box-1: no machine backend for its kind 'other' (there is: lima workstation cloud-vm)\n");
});

test('machine_run runs the command in the VM, in its workdir, its stdin, stdout and exit code passed through (limactl shell)', async () => {
  const v = lima();
  const r = await bash(`echo hello | machine_run --workdir /repos/ ass-74-a -- bash -c 'read -r l; echo "$l in $(pwd)"; exit 4'`, v.env);
  assert.deepEqual(r, { code: 4, out: `hello in ${join(realpathSync(v.root), 'repos')}\n`, err: '' });
  assert.equal((await bash('machine_run ass-74-a -- true', v.env)).code, 0);
  assert.deepEqual(v.calls(), [{ vm: 'ass-74-a', workdir: '/repos/', argv: ['bash', '-c', 'read -r l; echo "$l in $(pwd)"; exit 4'] }, { vm: 'ass-74-a', workdir: null, argv: ['true'] }]);
});

test('machine_run --marker runs it under a marker of its own, and machine_stop_marked ends it in the VM, which a local signal never reaches', async () => {
  const v = lima(), marker = `harness-step-test-${process.pid}-${Date.now()}`;
  const child = spawn('bash', ['-c', `source "${MACHINE}" && machine_run --marker ${marker} ass-74-a -- sleep 60`], { env: v.env, stdio: 'ignore' });
  assert.ok(await until(() => v.calls().length === 1));
  assert.deepEqual(v.calls()[0].argv.slice(0, 2), ['bash', '-c']);
  assert.deepEqual(v.calls()[0].argv.slice(3), [marker, 'sleep', '60']);
  assert.equal((await bash(`machine_stop_marked ass-74-a ${marker}`, v.env)).code, 0);
  assert.deepEqual(v.calls()[1], { vm: 'ass-74-a', workdir: null, argv: ['pkill', '-TERM', '-f', `[h]${marker.slice(1)}`] });
  assert.ok(await until(() => child.exitCode !== null || child.signalCode !== null), 'the process in the VM ends');
});

test('machine_run --timeout ends it past its seconds, exit 124 as timeout(1)\'s; within them, the command\'s own exit', async () => {
  const v = lima();
  assert.equal((await bash('machine_run --timeout 1 ass-74-a -- sleep 5', v.env)).code, 124);
  assert.deepEqual(await bash('machine_run --timeout 30 --workdir / ass-74-a -- bash -c "echo done; exit 3"', v.env), { code: 3, out: 'done\n', err: '' });
});

test('machine_copy_in and machine_copy_out copy a file or a folder into and out of the VM (limactl copy -r)', async () => {
  const v = lima(), local = mkdtempSync(join(tmpdir(), 'local-'));
  mkdirSync(join(local, 'folder'));
  writeFileSync(join(local, 'folder', 'a.txt'), 'in');
  assert.equal((await bash(`machine_copy_in ass-74-a "${join(local, 'folder')}" /tmp/folder`, v.env)).code, 0);
  assert.equal(readFileSync(join(v.root, 'tmp', 'folder', 'a.txt'), 'utf8'), 'in');
  assert.equal((await bash(`machine_copy_out ass-74-a /tmp/folder/a.txt "${join(local, 'back.txt')}"`, v.env)).code, 0);
  assert.equal(readFileSync(join(local, 'back.txt'), 'utf8'), 'in');
  assert.notEqual((await bash(`machine_copy_out ass-74-a /no/such "${join(local, 'x')}"`, v.env)).code, 0);
  assert.ok(!existsSync(join(local, 'x')));
});

test('machine_status, machine_stop and machine_start: its status (failing for none), a stop (forced or not), and a start under the sandbox vm:start explains', async () => {
  const v = lima();
  v.script('sandbox-exec', `[[ "$1" == -p ]] || exit 2; printf '%s\\n' "$2" > "${v.dir}/sandbox-profile"; shift 2; exec "$@"`);
  assert.deepEqual(await bash('machine_status ass-74-a', v.env), { code: 0, out: 'Running\n', err: '' });
  assert.notEqual((await bash('machine_status no-such-vm 2>/dev/null', v.env)).code, 0);
  assert.equal((await bash('machine_stop ass-74-a', v.env)).code, 0);
  assert.equal((await bash('machine_status ass-74-a', v.env)).out, 'Stopped\n');
  assert.equal((await bash('machine_stop ass-74-a force', v.env)).code, 0);
  assert.equal((await bash('machine_start vm:start ass-74-a none 7777 5000', v.env)).code, 0);
  assert.equal((await bash('machine_status ass-74-a', v.env)).out, 'Running\n');
  assert.match(readFileSync(join(v.dir, 'sandbox-profile'), 'utf8'), /\(allow network-outbound \(remote ip "localhost:7777"\) \(remote ip "localhost:5000"\) \(remote ip "localhost:60022"\)\)/);
  assert.deepEqual(v.calls().filter(c => ['stop', 'start'].includes(c.argv[0])).map(c => c.argv), [['stop', 'ass-74-a'], ['stop', '-f', 'ass-74-a'], ['start', '--tty=false', 'ass-74-a']]);
});
