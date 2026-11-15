// A ticket variation on a GCP workstation (ASS-435), through the bash
// commands: vm:create places it on a free workstation of its project's pool
// (workstations first in vm+workstation mode, a VM only when none is free;
// none but workstations in workstation mode), claims it in the live data and
// records it on the variation with its kind (AC1); makes and readies its own
// folder there as a VM's (AC2: the repositories cloned and checked out once,
// the ticket's read-only copy, credentials and the forwarder token in the
// setup's runtime folder, the binding in vm-tokens.json); the Setup steps'
// marker works there; the machine layer runs and stops a marked command
// there; and workstation:release removes the folder, its containers,
// credentials and token and frees the workstation, touching nothing else
// (AC6). Against a fake workstation (test/support/fake-workstation.js).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wsFixture, closeAll, git, edit, ID } from './workstation-fixture.js';

const run = promisify(execFile);
const MACHINE_BASH = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'machine.bash');
afterEach(closeAll);

const bash = (script, env) => run('bash', ['-c', `source "${MACHINE_BASH}" && ${script}`], { env }).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));

test('AC1, AC2: vm:create places a variation on a free workstation (connected and set up first), records it on the variation with its kind and in the live data, and readies its own folder as a VM', async () => {
  const s = wsFixture();
  const r = await s.result('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(r.code, 0, r.err);
  const folder = s.folder('A'), machine = `workstation:p:${ID}:${folder}`;
  assert.deepEqual(JSON.parse(r.out), { name: ID, machine, ip: null, created: true });
  assert.match(r.err, /ABC-3 A placed on p's workstation ada-dev/);
  const vm = s.variation('A').vm;
  assert.deepEqual({ ...vm, 'created-at': undefined }, { name: ID, kind: 'workstation', project: 'p', folder, 'created-at': undefined });
  const entry = s.entry();
  assert.equal(entry.connected, true);
  assert.equal(entry.setup.ok, true);
  assert.deepEqual({ ticket: entry.holder.ticket, variation: entry.holder.variation, folder: entry.holder.folder, kind: entry.holder['credential-kind'] }, { ticket: 'ABC-3', variation: 'A', folder, kind: 'claude' });
  assert.equal(entry.holder['boot-id'], entry.setup['boot-id']);
  // The repositories, cloned and checked out once; never the owner's ~/workspaces.
  assert.equal(git(join(folder, 'repos', 'harness'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(join(folder, 'repos', 'example-corpus'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'master');
  assert.ok(existsSync(join(folder, 'repos', '.vm-create-checked-out')));
  assert.ok(!existsSync(join(s.w.home(ID), 'workspaces')));
  // The ticket's read-only copy, and the folder standing in for a VM's root.
  assert.equal(readFileSync(join(folder, 'ticket', 'plan.md'), 'utf8'), 'the plan\n');
  assert.equal(statSync(join(folder, 'ticket', 'plan.md')).mode & 0o222, 0, 'read-only');
  assert.equal(statSync(join(folder, 'ticket')).mode & 0o222, 0, 'its folder too');
  assert.equal(readlinkSync(join(folder, 'mnt', 'ticket')), '../ticket');
  const runtime = entry.setup.runtime;
  assert.equal(realpathSync(join(folder, 'run', 'harness')), realpathSync(runtime));
  // Credentials and the forwarder token in the runtime folder, the paths there its own; the binding under the machine.
  const env = readFileSync(join(runtime, 'env'), 'utf8');
  assert.match(env, new RegExp(`^GIT_CONFIG_GLOBAL=${runtime}/gitconfig$`, 'm'));
  assert.match(env, /^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-TEST$/m);
  assert.match(readFileSync(join(runtime, 'gitconfig'), 'utf8'), /name = Ada/);
  const token = readFileSync(join(runtime, 'agent-token'), 'utf8').trim();
  const binding = s.tokens()[machine];
  assert.deepEqual({ ...binding, 'issued-at': undefined }, { project: 'p', ticket: 'ABC-3', variation: 'A', 'ticket-folder': realpathSync(s.at('projects', 'p', 'work', 'ABC-3')), 'token-sha256': createHash('sha256').update(token).digest('hex'), 'issued-at': undefined, machine });
  assert.equal(readFileSync(join(runtime, 'agent-url'), 'utf8').trim(), 'http://127.0.0.1:7787/run');

  // Setup's marker, in its folder: not complete, marked, complete.
  assert.equal((await s.result('vm:setup-complete', 'p', 'ABC-3', 'A')).code, 1);
  const marked = await s.result('vm:mark-setup-complete', 'p', 'ABC-3', 'A');
  assert.equal(marked.code, 0, marked.err);
  assert.ok(existsSync(join(folder, 'repos', '.setup-complete')));
  assert.equal((await s.result('vm:setup-complete', 'p', 'ABC-3', 'A')).code, 0);

  // Again: it stays where it is, its folder and created-at kept, its working trees untouched.
  writeFileSync(join(folder, 'repos', 'harness', 'work.txt'), 'mine\n');
  const again = await s.result('vm:create', 'p', 'ABC-3', 'A');
  assert.equal(again.code, 0, again.err);
  assert.equal(JSON.parse(again.out).created, false);
  assert.equal(s.variation('A').vm['created-at'], vm['created-at']);
  assert.ok(existsSync(join(folder, 'repos', 'harness', 'work.txt')));
});

test('AC1: one variation per workstation — another waits in workstation mode, gets a VM in vm+workstation mode, and takes the next free workstation first', async () => {
  const s = wsFixture();
  assert.equal((await s.result('vm:create', 'p', 'ABC-3', 'A')).code, 0);
  const second = await s.result('vm:create', 'p', 'ABC-3', 'B');
  assert.equal(second.code, 1);
  assert.match(second.err, /p runs its tickets on workstations alone, and no workstation of p's is free: ada-dev: held by ABC-3 A/);
  assert.equal(s.variation('B').vm, undefined);
  assert.equal(s.entry().holder.variation, 'A');

  edit(s.at('projects', 'p', 'project.json'), p => { p['dev-environments'].mode = 'vm+workstation'; });
  const vm = await s.result('vm:create', 'p', 'ABC-3', 'B');
  assert.match(vm.err, /no workstation of p's is free: ada-dev: held by ABC-3 A; ABC-3 B gets a VM/);
  assert.match(vm.err, /no golden image golden-p/, 'on to the VM path');
});

test('AC1: vm+workstation mode uses a free workstation before any VM, the next in the list when the first is held', async () => {
  const s = wsFixture({ mode: 'vm+workstation', ids: [ID, 'ws-2'] });
  assert.equal((await s.result('vm:create', 'p', 'ABC-3', 'A')).code, 0);
  const r = await s.result('vm:create', 'p', 'ABC-3', 'B');
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).name, 'ws-2');
  assert.equal(s.variation('B').vm.kind, 'workstation');
  assert.equal(s.entry('ws-2').holder.variation, 'B');
});

test('AC1: a workstation whose holder is no longer in flight is reclaimed by the next placement, its folder removed first', async () => {
  const s = wsFixture();
  assert.equal((await s.result('vm:create', 'p', 'ABC-3', 'C')).code, 0);   // C has no assignment, and its step sets no vm: not in flight
  const r = await s.result('vm:create', 'p', 'ABC-3', 'B');
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /workstation ada-dev freed: ABC-3 C's folder .* removed \(reclaimed for ABC-3 B\)/);
  assert.ok(!existsSync(s.folder('C')));
  assert.equal(s.entry().holder.variation, 'B');
});

test('the machine layer runs a command in the variation\'s folder there (VM paths mapped), and machine_stop_marked ends a marked one on the workstation', async () => {
  const s = wsFixture();
  assert.equal((await s.result('vm:create', 'p', 'ABC-3', 'A')).code, 0);
  const machine = `workstation:p:${ID}:${s.folder('A')}`;
  const pwd = await bash(`machine_run --workdir /repos/harness "${machine}" -- bash -c 'pwd; echo "$HARNESS_VM_ROOT"; command -v agent.sh; exit 3'`, s.env);
  assert.equal(pwd.code, 3, pwd.err);
  assert.deepEqual(pwd.out.trim().split('\n'), [join(s.folder('A'), 'repos', 'harness'), s.folder('A'), join(s.w.home(ID), 'harness', 'bin', 'agent.sh')]);
  assert.equal((await bash(`machine_status "${machine}"`, s.env)).out, 'Running\n');
  const marker = `harness-step-test-${process.pid}-${Date.now()}`, pidFile = join(s.w.dir, 'sleeper');
  const child = spawn('bash', ['-c', `source "${MACHINE_BASH}" && machine_run --marker ${marker} "${machine}" -- bash -c 'echo $$ > ${pidFile}; exec sleep 60'`], { env: s.env, stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await bash(`machine_stop_marked "${machine}" ${marker}`, s.env)).code, 0);
  const ended = () => child.exitCode !== null || child.signalCode !== null;
  for (let i = 0; i < 100 && !ended(); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(ended(), 'the marked process ended there');
});

test('AC6: workstation:release removes the variation\'s folder, its containers, credentials and token, and frees the workstation; nothing else is touched; refused while it is in flight', async () => {
  const s = wsFixture();
  assert.equal((await s.result('vm:create', 'p', 'ABC-3', 'A')).code, 0);
  const home = s.w.home(ID), runtime = s.entry().setup.runtime, folder = s.folder('A');
  mkdirSync(join(home, 'workspaces', 'example'), { recursive: true });
  writeFileSync(join(home, 'workspaces', 'example', 'README.md'), 'mine\n');
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Ada\n');
  // Docker: a container of the variation's (mounting its repository) and one of the owner's.
  writeFileSync(join(s.w.system(ID), 'docker'), `#!/bin/bash
case "$1" in
  info) echo 27.3.1 ;;
  ps) printf 'c1\\nc2\\n' ;;
  inspect) echo "c1 ${folder}/repos/harness /var/lib/x"; echo "c2 ${home}/workspaces/example" ;;
  rm) echo "$@" >> "${s.w.dir}/docker-rm" ;;
esac
`, { mode: 0o755 });
  const refused = await s.result('workstation:release', 'p', ID);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /ABC-3 A still needs p's workstation ada-dev/);   // its assignments (the fixture's Daredevil and Spock)
  assert.ok(existsSync(folder));

  const r = await s.result('workstation:release', 'p', ID, '--force');
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(folder));
  assert.equal(readFileSync(join(s.w.dir, 'docker-rm'), 'utf8'), 'rm -f -v c1\n', 'the variation\'s container alone');
  for (const f of ['env', 'gitconfig', 'agent-token']) assert.ok(!existsSync(join(runtime, f)), f);
  assert.ok(existsSync(join(runtime, 'agent-url')), 'setup\'s stays');
  for (const f of ['bin/agent.sh', 'env', 'setup.json']) assert.ok(existsSync(join(home, 'harness', f)), f);
  assert.equal(readFileSync(join(home, 'workspaces', 'example', 'README.md'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(home, '.gitconfig'), 'utf8'), '[user]\n\tname = Ada\n');
  assert.equal(s.entry().holder, undefined);
  assert.equal(s.tokens()[`workstation:p:${ID}:${folder}`], undefined);
  assert.ok(lstatSync(home).isDirectory());
});
