// A ticket variation on a GCP workstation (ASS-435, as ASS-468 changed it),
// through the bash commands: vm:create records the project's workstation
// pool on the variation (the first whose login is live, connected and set up
// first when none has been), claiming nothing, and falls back to a VM in
// vm+workstation mode when none can be used, failing in workstation mode; a
// step's claim takes the next free workstation of the list when the first is
// held; the machine layer runs and stops a marked command in the shared root
// there; and workstation:release removes the step's containers, their
// volumes and networks, credentials and token, touching nothing else, and is
// refused while an agent works there. Against a fake workstation
// (test/support/fake-workstation.js).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wsFixture, closeAll, edit, ID } from './workstation-fixture.js';

const run = promisify(execFile);
const MACHINE_BASH = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'machine.bash');
afterEach(closeAll);

const bash = (script, env) => run('bash', ['-c', `source "${MACHINE_BASH}" && ${script}`], { env }).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));

test('vm:create records the first workstation whose login is live (connected and set up first), claiming nothing; with none usable, workstation mode fails and vm+workstation gets a VM', async () => {
  const s = wsFixture({ ids: [ID, 'ws-2'] });
  writeFileSync(s.at('projects', 'p', 'workstations.json'), JSON.stringify({ [ID]: { 'last-error': { kind: 'expired', message: 'expired' } } }));
  const r = await s.result('vm:create', 'p', 'ABC-3', 'B');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { name: 'ws-2', machine: `workstation:p:ws-2:${s.root('ws-2')}`, ip: null, created: true });
  const vm = s.variation('B').vm;
  assert.deepEqual({ ...vm, 'created-at': undefined }, { name: 'ws-2', kind: 'workstation', project: 'p', folder: s.root('ws-2'), 'created-at': undefined });
  assert.equal(s.entry('ws-2').setup.ok, true, 'connected and set up, its home folder unknown till then');
  assert.equal(s.entry('ws-2').holder, undefined, 'nothing claimed');
  // Again: kept, created-at too.
  const again = await s.result('vm:create', 'p', 'ABC-3', 'B');
  assert.equal(JSON.parse(again.out).created, false);
  assert.equal(s.variation('B').vm['created-at'], vm['created-at']);

  edit(s.at('projects', 'p', 'workstations.json'), w => { w['ws-2']['last-error'] = { kind: 'expired', message: 'expired' }; });
  const none = await s.result('vm:create', 'p', 'ABC-3', 'C');
  assert.equal(none.code, 1);
  assert.match(none.err, /p runs its tickets on workstations alone, and no workstation of p's can be used: ada-dev: its gcloud login needs reauthentication; ws-2: its gcloud login needs reauthentication/);
  edit(s.at('projects', 'p', 'project.json'), p => { p['dev-environments'].mode = 'vm+workstation'; });
  const vmPath = await s.result('vm:create', 'p', 'ABC-3', 'C');
  assert.match(vmPath.err, /ABC-3 C gets a VM/);
  assert.match(vmPath.err, /no golden image golden-p/, 'on to the VM path');
  const forced = await s.result('vm:create', 'p', 'ABC-3', 'B', '--vm');
  assert.match(forced.err, /no golden image golden-p/, '--vm: the VM path whatever the mode');
});

test('AC1: a step takes the next free workstation of the list when the first is held', async () => {
  const s = wsFixture({ mode: 'vm+workstation', ids: [ID, 'ws-2'] });
  for (const id of [ID, 'ws-2']) { assert.equal((await s.result('workstation:connect', 'p', id)).code, 0); assert.equal((await s.result('workstation:setup', 'p', id)).code, 0); }
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'B')).code, 0);
  const r = await s.result('workstation:claim', 'p', 'ABC-3', 'C');
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).name, 'ws-2');
  assert.equal(s.variation('C').workstation.name, 'ws-2');
  assert.equal(s.entry('ws-2').holder.variation, 'C');
  assert.equal(s.entry().holder.variation, 'B');
});

test('the machine layer runs a command in the shared root there (VM paths mapped), and machine_stop_marked ends a marked one on the workstation', async () => {
  const s = wsFixture();
  assert.equal((await s.result('workstation:connect', 'p', ID)).code, 0);
  assert.equal((await s.result('workstation:setup', 'p', ID)).code, 0);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'B')).code, 0);
  const machine = `workstation:p:${ID}:${s.root()}`;
  const pwd = await bash(`machine_run --workdir /repos/harness "${machine}" -- bash -c 'pwd; echo "$HARNESS_VM_ROOT"; command -v agent.sh; exit 3'`, s.env);
  assert.equal(pwd.code, 3, pwd.err);
  assert.deepEqual(pwd.out.trim().split('\n'), [s.repo('harness'), s.root(), join(s.root(), 'bin', 'agent.sh')]);
  assert.equal((await bash(`machine_status "${machine}"`, s.env)).out, 'Running\n');
  const marker = `harness-step-test-${process.pid}-${Date.now()}`, pidFile = join(s.w.dir, 'sleeper');
  const child = spawn('bash', ['-c', `source "${MACHINE_BASH}" && machine_run --marker ${marker} "${machine}" -- bash -c 'echo $$ > ${pidFile}; exec sleep 60'`], { env: s.env, stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await bash(`machine_stop_marked "${machine}" ${marker}`, s.env)).code, 0);
  const ended = () => child.exitCode !== null || child.signalCode !== null;
  for (let i = 0; i < 100 && !ended(); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(ended(), 'the marked process ended there');
});

test('AC3: workstation:release removes the step\'s containers, their volumes and networks, credentials and token; nothing else is touched; refused while an agent works there', async () => {
  const s = wsFixture();
  assert.equal((await s.result('workstation:connect', 'p', ID)).code, 0);
  assert.equal((await s.result('workstation:setup', 'p', ID)).code, 0);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'A')).code, 0);
  const home = s.w.home(ID), runtime = s.entry().setup.runtime, root = s.root();
  mkdirSync(join(home, 'workspaces', 'example'), { recursive: true });
  writeFileSync(join(home, 'workspaces', 'example', 'README.md'), 'mine\n');
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Ada\n');
  // Docker: a compose container of the step's (mounting its repository), and one of the owner's.
  writeFileSync(join(s.w.system(ID), 'docker'), `#!/bin/bash
echo "$@" >> "${s.w.dir}/docker-calls"
case "$1 $2" in
  info*) echo 27.3.1 ;;
  ps*) printf 'c1\\nc2\\n' ;;
  inspect*) echo "c1 harness ${root}/repos/harness /var/lib/x"; echo "c2 - ${home}/workspaces/example" ;;
  "volume ls") [[ "$*" == *project=harness* ]] && echo harness_db ;;
  "network ls") [[ "$*" == *project=harness* ]] && echo harness_default ;;
esac
exit 0
`, { mode: 0o755 });
  const refused = await s.result('workstation:release', 'p', ID);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /ABC-3 A still has an agent at work on p's workstation ada-dev/);   // its assignments (the fixture's Daredevil and Spock)
  assert.equal(s.entry().holder.variation, 'A');

  const r = await s.result('workstation:release', 'p', ID, '--force');
  assert.equal(r.code, 0, r.err);
  const calls = readFileSync(join(s.w.dir, 'docker-calls'), 'utf8');
  assert.match(calls, /^rm -f -v c1$/m);
  assert.doesNotMatch(calls, /^rm -f -v c2$/m, 'the owner\'s left alone');
  assert.match(calls, /^volume rm -f harness_db$/m);
  assert.match(calls, /^network rm harness_default$/m);
  assert.match(r.err, /removed container c1/);
  for (const f of ['env', 'gitconfig', 'agent-token']) assert.ok(!existsSync(join(runtime, f)), f);
  assert.ok(existsSync(join(runtime, 'agent-url')), 'setup\'s stays');
  for (const f of ['bin/agent.sh', 'env', 'setup.json', 'repos/harness/README.md']) assert.ok(existsSync(join(home, 'harness', f)), f);
  assert.equal(readFileSync(join(home, 'workspaces', 'example', 'README.md'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(home, '.gitconfig'), 'utf8'), '[user]\n\tname = Ada\n');
  assert.equal(s.entry().holder, undefined);
  assert.equal(s.tokens()[`workstation:p:${ID}:${root}`], undefined);
});
