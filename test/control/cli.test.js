// Control's only way to write: agent.sh, run as a child, logged; and the way
// it runs a step's script.
import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { runCli, runScript, scriptSucceeds, SCRIPT_CHECK_TIMEOUT_MS, SLOW_CHECK_MS } from '../../src/control/cli.js';
import { fixture } from '../agent-cli/harness-fixture.js';
import { fakeVm } from '../support/fake-vm.js';
import { within } from '../support/until.js';

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
  let calledBack = 0;
  const server = createServer((req, res) => { calledBack++; res.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // The VM's agent.sh, as the real one: a call to the host's forwarder. Were it
  // run, it would call back to this process (blocked there before ASS-493); curl's
  // --max-time makes that a failure (false, and slow) rather than a hang.
  vm.inVm('agent.sh', `curl -sf --max-time 5 http://127.0.0.1:${server.address().port}/ >/dev/null`);
  const { ctx } = context({ env: vm.env });
  try {
    // ASS-545: the events themselves — the check ran on the Mac (no VM call) and nothing called back to this
    // process — in place of a 4 s limit that ./agent.sh --help outlasted on a loaded Mac. within() is a hang
    // guard only (LOADED_MS, 90 s: well above the check's normal second or two).
    assert.equal(await within(scriptSucceeds(ctx, ['./agent.sh', '--help'], 'ass-137-a')), true);
    assert.deepEqual(vm.calls(), []);
    assert.equal(calledBack, 0, 'the VM\'s agent.sh never ran, so nothing called back');
  } finally { server.close(); }
});

test('ASS-493 AC4: a check is limited to SCRIPT_CHECK_TIMEOUT_MS (10 min), killed and failed past it; one over SLOW_CHECK_MS (30 s) logs its duration as it exits', async () => {
  assert.deepEqual([SCRIPT_CHECK_TIMEOUT_MS, SLOW_CHECK_MS], [600_000, 30_000]);
  const f = fixture();
  const { ctx, lines } = context(f);
  ctx.slowCheckMs = 100;
  assert.equal(await scriptSucceeds(ctx, ['sh', '-c', 'sleep 0.3'], undefined, 'ABC-3 A'), true);
  // ASS-545: the duration's figure itself is the machine's (a loaded Mac takes over a second for a 0.3 s sleep).
  assert.match(lines.at(-1), /^script sh -c "sleep 0.3" \(ABC-3 A\): exited 0 after \d+\.\ds$/);
  ctx.checkTimeoutMs = 200;
  // ASS-545: a check left to run would sleep 600 s; within() fails it at LOADED_MS (90 s), a hang guard only, far
  // above a killed check's fraction of a second however loaded the Mac — the kill itself is shown by the lines below.
  assert.equal(await within(scriptSucceeds(ctx, ['sh', '-c', 'sleep 600'], undefined, 'ABC-3 A')), false);
  assert.ok(lines.includes('error script-succeeds check sh -c "sleep 600" (ABC-3 A) still running after 0.2s: killed, counted as not succeeded'), lines.join('\n'));
  assert.match(lines.at(-1), /^script sh -c "sleep 600" \(ABC-3 A\): killed after \d+\.\ds$/);
});

// ASS-583 AC3: a failing command's stderr (its last lines) is in the error, and so in control's error log line
// (tick.js ctx.attempt logs "<phase> <what>: <message>"); one that fails saying nothing gives its exit status, never
// only node's "Command failed: …".
test('ASS-583 AC3: a failing CLI command\'s stderr (its last lines) is in control\'s error log line; a silent one\'s exit status', async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'cli-root-'));
  writeFileSync(join(root, 'agent.sh'), `#!/bin/bash
case "$1" in
  noisy) for i in $(seq 1 15); do echo "line $i" >&2; done; echo "code:hand-over: harness (https://forge.example/g/harness): authentication failed (fatal: Authentication failed)" >&2; exit 1 ;;
  silent) echo '{"partial":true}'; exit 128 ;;
esac`);
  chmodSync(join(root, 'agent.sh'), 0o755);
  const lines = [];
  const ctx = { root, env: process.env, log: (phase, text) => lines.push(`${phase} ${text}`) };
  // As control logs a step's failure (tick.js ctx.attempt).
  const attempt = async (what, fn) => { try { await fn(); } catch (error) { ctx.log('error', `dispatch ${what}: ${error.message}`); } };
  await attempt('run noisy', () => runCli(ctx, ['noisy']));
  const noisy = lines.find(l => l.startsWith('error dispatch run noisy'));
  assert.match(noisy, /authentication failed \(fatal: Authentication failed\)/);
  assert.match(noisy, /line 15/);
  assert.doesNotMatch(noisy, /line 5\b/, 'only the last lines');
  assert.doesNotMatch(noisy, /Command failed/);
  await attempt('run silent', () => runCli(ctx, ['silent']));
  const silent = lines.find(l => l.startsWith('error dispatch run silent'));
  assert.equal(silent, 'error dispatch run silent: agent.sh silent: exited 128 with nothing on stderr (stdout\'s last line: {"partial":true})');
});
