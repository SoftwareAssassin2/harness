// ASS-529: several tickets' steps on one workstation at once, through the bash
// commands. AC2: workstation:claim --workstation gives each variation a folder
// of its own (a slot: the shared root, then <home>/harness/slots/<n>) — its
// own checkout, ticket copy, machine name and forwarder token — and
// workstation:release --slot <n> ends that one alone, the others' trees,
// tokens and the project's credentials untouched (removed with the last).
// AC3: with ticket-isolation separate (opt-in), each slot's slot.env names
// its own COMPOSE_PROJECT_NAME and port offset, sourced by every session
// there; by default (one-at-a-time) nothing is added — slot 0 has no slot.env,
// exactly as before, and slot n's names only its forwarder token file. AC1: workstation:usage measures the
// machine's memory and CPU over its connection and records them; a failed
// reading is recorded as such. Against a fake workstation
// (test/support/fake-workstation.js), bare local repositories for GitLab.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wsFixture, closeAll, git, edit, ID } from './workstation-fixture.js';

afterEach(closeAll);

async function connected(s) {
  assert.equal((await s.result('workstation:connect', 'p', ID)).code, 0);
  assert.equal((await s.result('workstation:setup', 'p', ID)).code, 0);
}

// ASS-545: no timeout of its own — test/run.sh's 600 s per test is the hang guard; a fixed one a loaded Mac outlasts.
test('AC2, AC3, AC6: two and three tickets on one workstation — each claim takes a folder of its own; a release frees its slot alone; the credentials go with the last (ticket-isolation separate)', async () => {
  const s = wsFixture();
  edit(s.at('projects', 'p', 'project.json'), p => { p['dev-environments']['ticket-isolation'] = 'separate'; });
  await connected(s);
  const root = s.root(), runtime = s.entry().setup.runtime;
  const claim = async name => { const r = await s.result('workstation:claim', 'p', 'ABC-3', name, '--workstation', ID); assert.equal(r.code, 0, r.err); return JSON.parse(r.out); };

  const b = await claim('B'), c = await claim('C'), a = await claim('A');
  assert.deepEqual([b.slot, b.folder], [0, root]);
  assert.deepEqual([c.slot, c.folder], [1, join(root, 'slots', '1')]);
  assert.deepEqual([a.slot, a.folder], [2, join(root, 'slots', '2')]);
  assert.equal(c.machine, `workstation:p:${ID}:${join(root, 'slots', '1')}`);
  assert.equal(s.entry().holder.variation, 'B');
  assert.deepEqual(Object.entries(s.entry().holders).map(([n, h]) => [n, h.variation, h.slot, h.folder]), [['1', 'C', 1, join(root, 'slots', '1')], ['2', 'A', 2, join(root, 'slots', '2')]]);
  assert.equal(s.variation('C').workstation.folder, join(root, 'slots', '1'));
  // Each its own checkout, ticket copy, forwarder token and binding.
  for (const f of [root, join(root, 'slots', '1'), join(root, 'slots', '2')]) {
    assert.ok(existsSync(join(f, 'repos', 'harness', '.git')), f);
    assert.equal(readFileSync(join(f, 'ticket', 'plan.md'), 'utf8'), 'the plan\n');
  }
  assert.ok(['agent-token', 'agent-token-1', 'agent-token-2'].every(t => existsSync(join(runtime, t))));
  assert.deepEqual(['B', 'C', 'A'].map(v => s.tokens()[`workstation:p:${ID}:${v === 'B' ? root : join(root, 'slots', v === 'C' ? '1' : '2')}`]?.variation), ['B', 'C', 'A']);
  // AC3: each slot's environment keeps its tests apart.
  assert.deepEqual(readFileSync(join(root, 'slots', '1', 'slot.env'), 'utf8').trim().split('\n'), ['HARNESS_TICKET=ABC-3', 'HARNESS_VARIATION=C', 'HARNESS_SLOT=1', 'HARNESS_PORT_OFFSET=100', 'COMPOSE_PROJECT_NAME=harness-slot1', `AGENT_TOKEN_FILE=${runtime}/agent-token-1`]);
  assert.match(readFileSync(join(root, 'slot.env'), 'utf8'), /^COMPOSE_PROJECT_NAME=harness-slot0$/m);
  // A session in slot 2's folder sees its slot.env (machine-workstation.bash wsm_enter, through vm:run's machine layer).
  const script = join(s.w.dir, 'show-env.sh');
  writeFileSync(script, 'echo "$COMPOSE_PROJECT_NAME $HARNESS_PORT_OFFSET $HARNESS_VM_ROOT"\n');
  const env = await s.result('vm:run', 'p', 'ABC-3', 'A', script);
  assert.equal(env.code, 0, env.err);
  assert.match(env.out, new RegExp(`harness-slot2 200 ${join(root, 'slots', '2')}`));

  // The same variation never takes two; another claim without --workstation finds it held, as before.
  assert.match((await s.result('workstation:claim', 'p', 'ABC-3', 'C', '--workstation', ID)).err, /ABC-3 C holds a step there already/);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'C')).code, 4);

  // C's step works in its own checkout; its end (slot 1) touches nothing of B's or A's.
  writeFileSync(join(root, 'slots', '1', 'repos', 'harness', 'c.txt'), 'c\n');
  writeFileSync(join(root, 'repos', 'harness', 'b.txt'), 'b\n');
  const end = await s.result('workstation:release', 'p', ID, '--force', '--slot', '1');
  assert.equal(end.code, 0, end.err);
  assert.equal(JSON.parse(end.out).released.variation, 'C');
  assert.equal(git(join(root, 'slots', '1', 'repos', 'harness'), 'status', '--porcelain', '--untracked-files=all'), '');
  assert.ok(existsSync(join(root, 'repos', 'harness', 'b.txt')), "B's work untouched");
  assert.equal(s.entry().holder.variation, 'B');
  assert.deepEqual(Object.keys(s.entry().holders), ['2']);
  assert.ok(!existsSync(join(runtime, 'agent-token-1')) && existsSync(join(runtime, 'agent-token')) && existsSync(join(runtime, 'env')), 'only its token removed; the credentials stay for the others');
  assert.equal(s.tokens()[`workstation:p:${ID}:${join(root, 'slots', '1')}`], undefined);
  // A new claim takes the freed slot 1.
  assert.equal((await claim('C')).slot, 1);
  assert.equal((await s.result('workstation:release', 'p', ID, '--force', '--slot', '1')).code, 0);
  // B (slot 0) ends: A still holds slot 2, so the credentials stay; A ends last: they go.
  writeFileSync(join(root, 'repos', 'harness', 'b.txt'), 'b\n');
  assert.equal((await s.result('workstation:release', 'p', ID, '--force')).code, 0);
  assert.equal(s.entry().holder, undefined);
  assert.ok(existsSync(join(runtime, 'env')));
  assert.equal((await s.result('workstation:release', 'p', ID, '--force', '--slot', '2')).code, 0);
  assert.equal(s.entry().holders, undefined);
  assert.ok(!existsSync(join(runtime, 'env')) && !existsSync(join(runtime, 'agent-token-2')), 'the last one out removes the credentials');
});

// ASS-545: no timeout of its own — test/run.sh's 600 s per test is the hang guard; a fixed one a loaded Mac outlasts.
test('AC3: by default (ticket-isolation unset: one-at-a-time) a slot adds nothing to its sessions — slot 0 has no slot.env, slot n names only its token file', async () => {
  const s = wsFixture();
  await connected(s);
  const root = s.root(), runtime = s.entry().setup.runtime;
  for (const name of ['B', 'C']) assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', name, '--workstation', ID)).code, 0);
  assert.ok(!existsSync(join(root, 'slot.env')), 'slot 0: exactly as before');
  assert.equal(readFileSync(join(root, 'slots', '1', 'slot.env'), 'utf8'), `AGENT_TOKEN_FILE=${runtime}/agent-token-1\n`);
  const script = join(s.w.dir, 'show-env.sh');
  writeFileSync(script, 'echo "[${COMPOSE_PROJECT_NAME-unset}] [${HARNESS_PORT_OFFSET-unset}] $AGENT_TOKEN_FILE"\n');
  const env = await s.result('vm:run', 'p', 'ABC-3', 'C', script);
  assert.equal(env.code, 0, env.err);
  assert.match(env.out, new RegExp(`\\[unset\\] \\[unset\\] ${runtime}/agent-token-1`));
});

// ASS-545: no timeout of its own — test/run.sh's 600 s per test is the hang guard; a fixed one a loaded Mac outlasts.
test('AC1: workstation:usage reads the machine\'s memory and CPU over its connection and records them; a failed reading is recorded; no connection is not measured', async () => {
  const s = wsFixture();
  assert.equal((await s.result('workstation:usage', 'p', ID)).code, 255, 'not connected: not measured');
  await connected(s);
  s.w.machine(64, 6, 16);
  const r = await s.result('workstation:usage', 'p', ID);
  assert.equal(r.code, 0, r.err);
  const u = s.entry().usage;
  assert.deepEqual([u.memory['total-bytes'], u.memory['available-bytes'], u.cpu.cores, u.cpu.samples.length, u.error], [64 * 1024 ** 3, 58 * 1024 ** 3, 16, 1, null]);
  for (let i = 0; i < 6; i++) await s.result('workstation:usage', 'p', ID);
  assert.equal(s.entry().usage.cpu.samples.length, 5, 'the last five samples kept');
  // Its /proc unreadable: the reading fails, recorded, the samples kept.
  const env = { ...s.env, WORKSTATION_PROC_ROOT: join(s.w.dir, 'no-proc') };
  const code = await new Promise(resolve => execFile(join(import.meta.dirname, '..', '..', 'agent.sh'), ['workstation:usage', 'p', ID], { env }, e => resolve(e?.code ?? 0)));
  assert.equal(code, 1);
  assert.match(s.entry().usage.error.message, /its memory and CPU could not be read/);
  assert.equal(s.entry().usage.cpu.samples.length, 5);
});
