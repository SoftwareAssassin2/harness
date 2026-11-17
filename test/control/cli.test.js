// Control's only way to write: agent.sh, run as a child, logged; and the way
// it runs a step's script.
import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { runCli, runScript, scriptSucceeds, SCRIPT_CHECK_TIMEOUT_MS, SLOW_CHECK_MS } from '../../src/control/cli.js';
import { fixture } from '../agent-cli/harness-fixture.js';
import { fakeVm } from '../support/fake-vm.js';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const context = f => { const lines = []; return { ctx: { root: ROOT, env: f.env, log: (phase, text) => lines.push(`${phase} ${text}`) }, lines }; };

test('runCli runs agent.sh with the arguments against the data the env names, logs the command, and returns its stdout', async () => {
  const f = fixture();
  const { ctx, lines } = context(f);
  const out = await runCli(ctx, ['assignments:set-status', 'Spock', 'Ended']);
  assert.equal(out, '');
  assert.equal(f.assignments().assignments[1].status, 'Ended');
  assert.deepEqual(lines, ['cli agent.sh assignments:set-status Spock Ended']);
  const json = await runCli(ctx, ['transient-state-engine:remove', 'aaaaaaaa-0000-4000-8000-000000000001']);
  assert.equal(JSON.parse(json).id, 'aaaaaaaa-0000-4000-8000-000000000001');
});

test('runCli throws on a failing command, its stderr in the message and logged', async () => {
  const f = fixture();
  const { ctx, lines } = context(f);
  await assert.rejects(runCli(ctx, ['assignments:set-status', 'Nobody', 'Ended']), /no assignment for Nobody/);
  assert.equal(lines[0], 'cli agent.sh assignments:set-status Nobody Ended');
  assert.match(lines[1], /^cli stderr: .*no assignment for Nobody/);
});

test('runScript runs an argv in the root, giving back its exit code and output, never throwing; scriptSucceeds is its yes or no, awaited (ASS-493)', async () => {
  const f = fixture();
  const { ctx, lines } = context(f);
  assert.deepEqual(await runScript(ctx, ['sh', '-c', 'echo "{\\"ok\\":true}"; exit 3']), { exitCode: 3, stdout: '{"ok":true}\n' });
  assert.equal((await runScript(ctx, ['./agent.sh', '--help'])).exitCode, 0);                // ./agent.sh resolves in the root
  assert.equal((await runScript(ctx, ['/no/such/binary'])).exitCode, 127);
  assert.equal(await scriptSucceeds(ctx, ['true']), true);
  assert.equal(await scriptSucceeds(ctx, ['false']), false);
  assert.equal(await scriptSucceeds(ctx, ['/no/such/binary']), false);
  assert.ok(lines.every(l => l.startsWith('script ')), lines.join('\n'));
});

test('given a VM (run-location: vm, ASS-74), runScript runs the argv in it, in /repos/, through limactl shell: ./agent.sh is the VM\'s agent.sh, the forwarder\'s client on its PATH', async () => {
  const f = fixture(), vm = fakeVm(f.env);
  vm.inVm('agent.sh', 'echo "{\\"in\\":\\"$1\\"}"; [[ "$1" != fail ]]; exit $(( $? ? 4 : 0 ))');
  const { ctx, lines } = context({ env: vm.env });
  assert.deepEqual(await runScript(ctx, ['./agent.sh', 'ticket:questions-answered', 'p', 'ABC-3'], 'ass-74-a'), { exitCode: 0, stdout: '{"in":"ticket:questions-answered"}\n' });
  assert.equal((await runScript(ctx, ['./agent.sh', 'fail'], 'ass-74-a')).exitCode, 4);
  assert.deepEqual(vm.calls()[0], { vm: 'ass-74-a', workdir: '/repos/', argv: ['agent.sh', 'ticket:questions-answered', 'p', 'ABC-3'] });
  assert.equal(lines[0], 'script ass-74-a: agent.sh ticket:questions-answered p ABC-3');
});

test('given a VM, scriptSucceeds runs a non-agent.sh command in it, but an agent.sh command on the Mac: the VM\'s agent.sh only forwards it there (ASS-137)', async () => {
  const f = fixture(), vm = fakeVm(f.env);
  vm.inVm('check', '[[ "$1" == ok ]]');
  vm.inVm('agent.sh', 'exit 9');                                                           // never reached
  const { ctx, lines } = context({ env: vm.env });
  assert.equal(await scriptSucceeds(ctx, ['check', 'ok'], 'ass-137-a'), true);
  assert.equal(await scriptSucceeds(ctx, ['check', 'no'], 'ass-137-a'), false);
  assert.equal(await scriptSucceeds(ctx, ['./agent.sh', '--help'], 'ass-137-a'), true);         // the Mac's agent.sh, in the root
  assert.equal(await scriptSucceeds(ctx, ['./agent.sh', 'no:such-command'], 'ass-137-a'), false);
  assert.deepEqual(vm.calls().map(c => c.argv), [['check', 'ok'], ['check', 'no']]);
  assert.deepEqual(lines, ['script ass-137-a: check ok', 'script ass-137-a: check no', 'script ./agent.sh --help', 'script ./agent.sh no:such-command']);
});

test('scriptSucceeds never waits on a VM command that calls back to this process (the forwarder control serves): a VM step\'s agent.sh check completes (ASS-137)', async () => {
  const f = fixture(), vm = fakeVm(f.env);
  const server = createServer((req, res) => res.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // The VM's agent.sh, as the real one: a call to the host's forwarder. Were it
  // run, it would call back to this process (blocked there before ASS-493); curl's
  // --max-time makes that a failure (false, and slow) rather than a hang.
  vm.inVm('agent.sh', `curl -sf --max-time 5 http://127.0.0.1:${server.address().port}/ >/dev/null`);
  const { ctx } = context({ env: vm.env });
  const started = Date.now();
  try {
    assert.equal(await scriptSucceeds(ctx, ['./agent.sh', '--help'], 'ass-137-a'), true);
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms`);
    assert.deepEqual(vm.calls(), []);
  } finally { server.close(); }
});

test('ASS-493 AC4: a check is limited to SCRIPT_CHECK_TIMEOUT_MS (10 min), killed and failed past it; one over SLOW_CHECK_MS (30 s) logs its duration as it exits', async () => {
  assert.deepEqual([SCRIPT_CHECK_TIMEOUT_MS, SLOW_CHECK_MS], [600_000, 30_000]);
  const f = fixture();
  const { ctx, lines } = context(f);
  ctx.slowCheckMs = 100;
  assert.equal(await scriptSucceeds(ctx, ['sh', '-c', 'sleep 0.3'], undefined, 'ABC-3 A'), true);
  assert.match(lines.at(-1), /^script sh -c "sleep 0.3" \(ABC-3 A\): exited 0 after 0\.\ds$/);
  ctx.checkTimeoutMs = 200;
  const started = Date.now();
  assert.equal(await scriptSucceeds(ctx, ['sh', '-c', 'sleep 30'], undefined, 'ABC-3 A'), false);
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
  assert.ok(lines.includes('error script-succeeds check sh -c "sleep 30" (ABC-3 A) still running after 0.2s: killed, counted as not succeeded'), lines.join('\n'));
  assert.match(lines.at(-1), /^script sh -c "sleep 30" \(ABC-3 A\): killed after 0\.\ds$/);
});
