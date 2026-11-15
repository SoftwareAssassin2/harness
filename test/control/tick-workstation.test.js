// A ticket variation's agents on a GCP workstation, through control (ASS-435):
// the forwarder runs an agent's agent.sh calls from the workstation for its
// binding alone and brings the ticket folder's read-only copy up to date
// before each returns (AC3, AC4); a ticket goes from Create VM through
// Generate Solution on a fake workstation — placed, its folder readied, its
// agent dispatched over the connection in that folder, told its paths, its
// memory at the forwarded port, stopped there — and its workstation is freed
// once it is Done (AC1, AC2, AC3, AC5, AC6, AC8); its steps and agents wait
// while the workstation cannot be used, its Health saying why (AC7); and an
// unplaced ticket in workstation mode waits while none is free.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { controlFixture } from './control-fixture.js';
import { wsFixture, closeAll, edit, ID } from '../agent-cli/workstation-fixture.js';
import { startForwarder } from '../../src/control/forwarder.js';
import { tick } from '../../src/control/tick.js';
import { awaitsVm } from '../../src/control/vm-lifecycle.js';
import { superviseWorkstations } from '../../src/control/workstations.js';
import { machineUp, workstationState } from '../../src/control/workstation-machines.js';
import { until } from '../support/until.js';
import { fakeHindsight } from '../support/fake-hindsight.js';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const MACHINE_BASH = join(ROOT, 'src', 'agent-cli', 'machine.bash');
afterEach(closeAll);

const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const onWs = (s, machine, script) => run('bash', ['-c', `source "${MACHINE_BASH}" && machine_run "${machine}" -- bash -c '${script}'`], { env: s.env }).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));

test('AC3, AC4: agent.sh on the workstation reaches the forwarder on its loopback, runs for its own binding and is refused outside it; a write is in the ticket copy as the call returns', async () => {
  const port = await freePort();
  const s = wsFixture({ forwarder: port });
  assert.equal((await s.result('vm:create', 'p', 'ABC-3', 'A')).code, 0);
  const machine = `workstation:p:${ID}:${s.folder('A')}`, lines = [];
  // The connection's forward stands in as the same port on this host (the fake workstation is this machine).
  const server = await startForwarder({ root: ROOT, env: s.env, port, log: (phase, text) => lines.push(`${phase} ${text}`) });
  try {
    const wrote = await onWs(s, machine, 'echo "from the workstation" | agent.sh work:write p ABC-3 A notes.md && cat "$HARNESS_VM_ROOT/ticket/notes-A.md" && touch "$HARNESS_VM_ROOT/ticket/x" 2>/dev/null || echo read-only');
    assert.equal(wrote.code, 0, wrote.err);
    assert.equal(wrote.out, 'from the workstation\nread-only\n');
    assert.ok(lines.some(l => l === `forwarder RUN ${machine} ["work:write","p","ABC-3","A","notes.md"]`), lines.join('\n'));
    const refused = await onWs(s, machine, 'agent.sh ticket:questions-answered p ABC-4');
    assert.equal(refused.code, 77);
    assert.match(refused.err, /refused by the host: ticket "ABC-4" is not this VM's ABC-3/);
    const other = await onWs(s, machine, 'echo x | agent.sh work:write p ABC-3 B notes.md');
    assert.equal(other.code, 77);
    assert.ok(!existsSync(s.at('projects', 'p', 'work', 'ABC-3', 'notes-B.md')));
  } finally { server.close(); }
});

// The control fixture with project p on workstation ada-dev in workstation mode: its engine backlog → committed →
// setup (the real grouped-setup: Check Setup Complete, Create VM, Mark Setup Complete) → generate-solution (a prompt
// in the variation's machine) → done; p's Hindsight on `hindsight` (a port nothing answers on by default).
async function tickFixture({ hindsight = 59111 } = {}) {
  const c = controlFixture();
  const at = (...rest) => join(c.dir, ...rest);
  cpSync(join(ROOT, 'engines', 'grouped-setup'), at('engines', 'grouped-setup'), { recursive: true });
  const s = wsFixture({ f: c, forwarder: await freePort() });
  edit(at('engines', 'example-development', 'state-engine.json'), e => {
    e.steps = [
      ...e.steps.filter(x => ['blocked', 'backlog', 'committed'].includes(x.id)).map(x => (x.id === 'committed' ? { ...x, 'exit-events': [{ condition: { 'agent-needs-work': true }, 'move-to-state': 'setup' }] } : x)),
      { id: 'setup', sequence: 3, name: 'Setup', vm: 'running', 'is-planning-stage': true, 'paired-ticket-system-status': 'In Progress', 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'setup',
        action: { type: 'state-engine', engine: 'grouped-setup' },
        'exit-events': [{ condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked' }] }, 'move-to-state': 'blocked' }, { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked-for-human' }] }, 'move-to-state': 'blocked-for-human' }, { condition: { 'is-done': true }, 'move-to-state': 'generate-solution' }] },
      { id: 'generate-solution', sequence: 4, name: 'Generate Solution', vm: 'running', 'run-location': 'vm', 'paired-ticket-system-status': 'In Progress', 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'generate-solution',
        action: { type: 'prompt', prompt: 'review-plan', 'agent-count': 1 },
        'exit-events': [{ condition: { all: [{ 'turn-complete': true }, { 'structured-output': { 'is-approved': true } }] }, 'move-to-state': 'done' }] },
      { id: 'blocked-for-human', sequence: 5, 'is-blocked-state': true, action: { type: 'human' } },
      { id: 'done', sequence: 6, 'is-done': true, 'paired-ticket-system-status': 'Done', action: { type: 'none' } },
    ];
  });
  writeFileSync(at('prompts', 'review-plan', 'prompt.txt'), 'Solve {ticket} in {folder}; files in {ticket-folder}; run {agent-sh} ticket:questions-answered {project} {ticket}.\nCode: {project-code-folder}.\n{where}\n');
  edit(at('projects', 'p', 'project.json'), p => { p.hindsight = { port: hindsight, 'llm-api-key': null }; });
  c.ctx.env = { ...s.env, FAKE_OUTPUT: '{"is-approved":true}' };
  const settle = async () => {
    await Promise.all([...(c.ctx.memory.workstations?.values() ?? [])].map(r => r.job));
    await Promise.all([...(c.ctx.memory.vms?.values() ?? [])].map(r => r.job));
  };
  return { c, s, at, settle, state: () => c.variation()['harness-status'], log: () => c.lines.join('\n') };
}

test('AC8: a ticket goes from Create VM through Generate Solution on a fake workstation — placed, readied, its agent run and stopped there — and frees the workstation once Done', { timeout: 240_000 }, async t => {
  const h = await fakeHindsight();
  t.after(h.close);
  const { c, s, settle, state, log } = await tickFixture({ hindsight: h.port });
  c.ctx.env.FAKE_MEMORY = JSON.stringify([{ tool: 'retain', arguments: { content: 'remembered from the workstation', context: 'test' } }]);
  try {
    let record;
    for (let i = 0; i < 60 && !record; i++) {
      await tick(c.ctx);
      await settle();
      record = c.assignments().assignments.find(a => a.state === 'generate-solution');
      if (!record) await new Promise(r => setTimeout(r, 200));
    }
    assert.ok(record, `${JSON.stringify(state())}\n${log()}`);
    const folder = s.folder('A'), machine = `workstation:p:${ID}:${folder}`;
    // Placed (AC1), readied there (AC2): Setup's own steps, through the machine layer.
    assert.deepEqual({ ...c.variation().vm, 'created-at': undefined }, { name: ID, kind: 'workstation', project: 'p', folder, 'created-at': undefined });
    assert.equal(s.entry().holder.variation, 'A');
    assert.ok(existsSync(join(folder, 'repos', '.setup-complete')), 'Mark Setup Complete wrote its marker there');
    assert.deepEqual(c.variation()['state-changes'].filter(x => x['to-state'] === 'setup' && x['sub-state-change']).map(x => x['sub-state-change']['to-state']), ['check-setup-complete', 'create-vm', 'mark-setup-complete', 'done']);
    // Its agent, over the workstation's connection, in its folder's repos/, under a marker (AC3).
    const live = c.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => s.w.sshCalls().some(x => x.argv.includes(`workstation-${ID}`) && x.argv.at(-1).includes(live.agent.marker))), log());
    const call = s.w.sshCalls().find(x => x.argv.at(-1).includes(live.agent.marker));
    assert.ok(call.argv.at(-1).includes(`'${folder}/repos/'`), call.argv.at(-1));
    const dir = readdirSync(join(c.dir, 'agents')).find(d => d.startsWith(`${record['agent-name']}-`));
    const prompt = JSON.parse(readFileSync(join(c.dir, 'agents', dir, 'inbox.jsonl'), 'utf8').trim().split('\n')[0]).prompt;
    assert.ok(prompt.includes(`Solve ABC-3 in ${folder}/repos/; files in ${folder}/ticket; run agent.sh ticket:questions-answered p ABC-3.`), prompt);
    assert.ok(prompt.includes(`Where you are: on the GCP workstation ${ID}, in this ticket variation's own folder there, ${folder}.`), prompt);
    assert.ok(prompt.includes(`- harness (`) && prompt.includes(`in ${folder}/repos/harness/`), prompt);
    assert.ok(prompt.includes('Run every other command here, on the workstation, in this folder.'), prompt);
    // AC5: its memory at 127.0.0.1 — on a workstation the connection's reverse forward of the Mac's port — never host.lima.internal.
    assert.ok(await until(() => readFileSync(join(c.dir, 'agents', dir, 'session.txt'), 'utf8').includes('memory retain')), log());
    const session = readFileSync(join(c.dir, 'agents', dir, 'session.txt'), 'utf8');
    assert.ok(session.includes(`http://127.0.0.1:${h.port}/mcp/p/`) && !session.includes('host.lima.internal'), session);
    assert.ok(!/memory retain unreachable/.test(session), session);
    assert.ok(c.lines.some(l => new RegExp(`^dispatch ${record['agent-name']} .* in ${folder}/repos/ \\(workstation ${ID}\\)$`).test(l)), log());
    assert.equal(readFileSync(join(folder, 'ticket', 'plan.md'), 'utf8'), 'the plan\n', 'the ticket copy, pushed as it started');

    // Its turn approved: Done — and the workstation, given up, is freed: its folder removed (AC6).
    assert.ok(await until(() => live.result), log());
    for (let i = 0; i < 20 && (state().state !== 'done' || s.entry().holder); i++) { await tick(c.ctx); await settle(); }
    assert.equal(state().state, 'done', log());
    assert.equal(s.entry().holder, undefined, log());
    assert.ok(!existsSync(folder));
    assert.ok(c.lines.some(l => /^workstation p ada-dev: released \(ABC-3 A done: done\): its folder removed/.test(l)), log());
  } finally { c.ctx.stopAgents(); }
});

test('stop() ends an agent on the workstation: its marked process there, which a local signal never reaches', { timeout: 240_000 }, async () => {
  const { c, s, settle, log } = await tickFixture();
  c.ctx.env = { ...c.ctx.env, FAKE_HOLD: join(s.w.dir, 'hold'), FAKE_OUTLIVE_STDIN: '1' };
  writeFileSync(join(s.w.dir, 'hold'), '');
  try {
    let record;
    for (let i = 0; i < 60 && !record; i++) { await tick(c.ctx); await settle(); record = c.assignments().assignments.find(a => a.state === 'generate-solution'); }
    assert.ok(record, log());
    const live = c.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => s.w.sshCalls().some(x => x.argv.at(-1)?.includes(live.agent.marker))));
    const marked = () => run('pgrep', ['-f', `bash -c .*${live.agent.marker}`]).then(() => true, () => false);
    assert.ok(await until(marked), 'running under its marker');
    live.agent.stop();
    assert.ok(await until(() => s.w.sshCalls().some(x => x.argv.includes('pkill') || x.argv.at(-1)?.startsWith("'pkill'"))), 'pkill sent over the connection');
    for (let i = 0; i < 50 && await marked(); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(await marked(), false, 'ended on the workstation');
  } finally { c.ctx.stopAgents(); }
});

test('AC7: a variation whose workstation cannot be used waits — its steps not judged, no agent sent — its Health saying why, and goes on once it is back', { timeout: 240_000 }, async () => {
  const { c, s, settle, log } = await tickFixture();
  c.ctx.env = { ...c.ctx.env, FAKE_HOLD: join(s.w.dir, 'hold') };
  writeFileSync(join(s.w.dir, 'hold'), '');
  try {
    let record;
    for (let i = 0; i < 60 && !record; i++) { await tick(c.ctx); await settle(); record = c.assignments().assignments.find(a => a.state === 'generate-solution'); }
    assert.ok(record, log());
    c.ctx.stopAgents();
    for (const name of [...c.ctx.agents.keys()]) c.ctx.agents.delete(name);
    await s.cli('assignments:remove', record['agent-name']);
    // Its gcloud login lapses and the connection drops: down, and the Health names the login to run.
    s.w.mark(null, 'expired');
    await s.cli('workstation:disconnect', 'p', ID);
    c.ctx.memory.workstations.get('p').ws.get(ID).checkedAt = 0;
    const waits = () => { const st = c.ctx.load(), project = st.projects.find(p => p.id === 'p'); return awaitsVm(c.ctx, st, project, project.tickets[0].variations[0], 'ABC-3 A generate-solution'); };
    assert.equal(machineUp(s.entry(), 'ABC-3', 'A'), false);
    assert.equal(waits(), true);
    superviseWorkstations(c.ctx, c.ctx.load()); await settle();
    assert.equal(workstationState(s.entry()), 'sign in needed');
    assert.match(c.variation()['ai-feedback-short'] ?? '', /^Waiting for its workstation: the gcloud login of workstation ada-dev needs reauthentication/, log());
    assert.match(c.variation()['ai-feedback-long'], /run gcloud auth login/);
    await tick(c.ctx); await settle();
    assert.equal(c.assignments().assignments.filter(a => a.state === 'generate-solution').length, 0, 'no agent sent meanwhile');
    // Signed in again: reconnected, readied again after the restart its runtime folder may have lost, the Health cleared.
    s.w.unmark(null, 'expired');
    c.ctx.memory.workstations.get('p').ws.get(ID).until = 0;
    for (let i = 0; i < 10 && !machineUp(s.entry(), 'ABC-3', 'A'); i++) { superviseWorkstations(c.ctx, c.ctx.load()); await settle(); }
    assert.equal(machineUp(s.entry(), 'ABC-3', 'A'), true, log());
    superviseWorkstations(c.ctx, c.ctx.load()); await settle();
    assert.equal(c.variation()['ai-feedback-long'] ?? null, null, log());
    assert.equal(waits(), false, log());
  } finally { c.ctx.stopAgents(); }
});

test('AC1: in workstation mode an unplaced ticket waits at Setup, its Create VM not run, while no workstation is free', { timeout: 120_000 }, async () => {
  const { c, s, at, settle, log } = await tickFixture();
  // ABC-9 B holds the workstation, at a step that runs its machine: in flight.
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sprint => {
    sprint.features.push({ key: 'ABC-9', 'ticket-system-status': 'In Progress', variations: [{ name: 'B', 'harness-status': { state: 'generate-solution', 'state-engine': 'example-development' }, 'state-changes': [], vm: { name: ID, kind: 'workstation', project: 'p', folder: join(s.w.home(ID), 'harness', 'ABC-9-B') } }] });
  });
  writeFileSync(at('projects', 'p', 'workstations.json'), JSON.stringify({ [ID]: { holder: { ticket: 'ABC-9', variation: 'B', since: '2026-11-14T00:00:00Z' } } }));
  for (let i = 0; i < 6; i++) { await tick(c.ctx); await settle(); }
  const v = c.variation();
  assert.equal(v['harness-status'].state, 'setup', log());
  assert.equal(v.vm, undefined, 'never placed');
  assert.ok(c.lines.some(l => /ABC-3 A .*waits: no workstation of p's is free \(ada-dev is held by ABC-9 B\)/.test(l)), log());
  assert.match(v['ai-feedback-long'] ?? '', /no workstation of p's is free/);
});

test('AC7: after the workstation restarts (its runtime folder emptied), control reconnects, sets it up and readies the variation again — credentials and token back — before its steps go on', { timeout: 240_000 }, async () => {
  const { c, s, settle, log } = await tickFixture();
  c.ctx.env = { ...c.ctx.env, FAKE_HOLD: join(s.w.dir, 'hold') };
  writeFileSync(join(s.w.dir, 'hold'), '');
  try {
    let record;
    for (let i = 0; i < 60 && !record; i++) { await tick(c.ctx); await settle(); record = c.assignments().assignments.find(a => a.state === 'generate-solution'); }
    assert.ok(record, log());
    c.ctx.stopAgents();
    for (const name of [...c.ctx.agents.keys()]) c.ctx.agents.delete(name);
    await s.cli('assignments:remove', record['agent-name']);
    const before = s.entry().holder['boot-id'], runtime = s.entry().setup.runtime;
    // It stops (its idle stop, say): the connection drops with it; started again, it has a new boot and an empty runtime folder.
    s.w.setState(ID, 'STATE_STOPPED');
    for (let i = 0; i < 50 && existsSync(join(s.w.harnessHome, 'workstations', `p-${ID}.sock`)); i++) await new Promise(r => setTimeout(r, 100));
    c.ctx.memory.workstations.get('p').ws.get(ID).checkedAt = 0;
    const st = c.ctx.load(), project = st.projects.find(p => p.id === 'p');
    assert.equal(awaitsVm(c.ctx, st, project, project.tickets[0].variations[0], 'ABC-3 A generate-solution'), true, 'its connection gone: waits at once');
    for (let i = 0; i < 10 && !(machineUp(s.entry(), 'ABC-3', 'A') && s.entry().holder['boot-id'] !== before); i++) { superviseWorkstations(c.ctx, c.ctx.load()); await settle(); }
    assert.equal(machineUp(s.entry(), 'ABC-3', 'A'), true, log());
    assert.notEqual(s.entry().holder['boot-id'], before);
    assert.ok(c.lines.some(l => /^workstation p ada-dev: readied again \(ABC-3 A at generate-solution; workstation ada-dev has started since its folder was readied/.test(l)), log());
    for (const f of ['env', 'agent-token', 'agent-url']) assert.ok(existsSync(join(runtime, f)), f);
  } finally { c.ctx.stopAgents(); }
});
