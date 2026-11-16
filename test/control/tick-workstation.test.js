// A ticket variation's steps on a GCP workstation, through control (ASS-435,
// ASS-468): the forwarder runs an agent's agent.sh calls from the workstation
// for its binding alone and brings the ticket folder's read-only copy up to
// date before each returns; a ticket goes from Create VM through Generate
// Solution and a script step on a fake workstation, each step claiming it —
// its shared repositories checked out on the ticket's branches — before its
// agent or script starts and releasing it at its end — committed work
// pushed to GitLab (bare local repositories here), what a completed step
// left uncommitted committed on its branch by the harness, with a warning
// (AC9), an unfinished one's discarded, master back — so nothing holds it between steps
// (AC1, AC2, AC3, AC5, AC8); an agent killed mid-step still ends its step
// cleanly; a step finding its seat's workstation held by another waits in
// workstation mode, its Health saying why; a holder no step of control's
// holds is released. ASS-469: in vm+workstation mode a VM-seat holder's step
// runs on its VM, and once a workstation seat frees it moves there between
// its steps, its next step on the workstation.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { controlFixture } from './control-fixture.js';
import { wsFixture, closeAll, edit, git, ID } from '../agent-cli/workstation-fixture.js';
import { startForwarder } from '../../src/control/forwarder.js';
import { tick } from '../../src/control/tick.js';
import { fakeVm } from '../support/fake-vm.js';
import { until } from '../support/until.js';
import { fakeHindsight } from '../support/fake-hindsight.js';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const MACHINE_BASH = join(ROOT, 'src', 'agent-cli', 'machine.bash');
afterEach(closeAll);

const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const onWs = (s, machine, script) => run('bash', ['-c', `source "${MACHINE_BASH}" && machine_run "${machine}" -- bash -c '${script}'`], { env: s.env }).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), e => ({ code: e.code, out: e.stdout, err: e.stderr }));
const commit = (dir, file, text) => { writeFileSync(join(dir, file), text); git(dir, 'add', file); git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', file); return git(dir, 'rev-parse', 'HEAD'); };
const remote = (bare, ref) => { try { return git(bare, 'rev-parse', '--verify', '-q', ref); } catch { return null; } };

test('AC3, AC4: agent.sh on the workstation reaches the forwarder on its loopback, runs for its own binding and is refused outside it; a write is in the ticket copy as the call returns', async () => {
  const port = await freePort();
  const s = wsFixture({ forwarder: port });
  assert.equal((await s.result('workstation:connect', 'p', ID)).code, 0);
  assert.equal((await s.result('workstation:setup', 'p', ID)).code, 0);
  assert.equal((await s.result('workstation:claim', 'p', 'ABC-3', 'A')).code, 0);
  const machine = `workstation:p:${ID}:${s.root()}`, lines = [];
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

// The control fixture with project p on workstation ada-dev (workstation mode unless `mode`): its engine backlog →
// committed → setup (the real grouped-setup: Check Setup Complete, Create VM, Mark Setup Complete) →
// generate-solution (a prompt on the variation's machine) → ci-checks (a script there) → done; ABC-3 A's plan a
// merge request in harness (change/ABC-3-1); p's Hindsight on `hindsight` (a port nothing answers on by default).
async function tickFixture({ hindsight = 59111, mode = 'workstation' } = {}) {
  const c = controlFixture();
  const at = (...rest) => join(c.dir, ...rest);
  cpSync(join(ROOT, 'engines', 'grouped-setup'), at('engines', 'grouped-setup'), { recursive: true });
  const s = wsFixture({ f: c, forwarder: await freePort(), mode });
  edit(at('engines', 'example-development', 'state-engine.json'), e => {
    e.steps = [
      ...e.steps.filter(x => ['blocked', 'backlog', 'committed'].includes(x.id)).map(x => (x.id === 'committed' ? { ...x, 'exit-events': [{ condition: { 'agent-needs-work': true }, 'move-to-state': 'setup' }] } : x)),
      { id: 'setup', sequence: 3, name: 'Setup', vm: 'running', 'is-planning-stage': true, 'paired-ticket-system-status': 'In Progress', 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'setup',
        action: { type: 'state-engine', engine: 'grouped-setup' },
        'exit-events': [{ condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked' }] }, 'move-to-state': 'blocked' }, { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked-for-human' }] }, 'move-to-state': 'blocked-for-human' }, { condition: { 'is-done': true }, 'move-to-state': 'generate-solution' }] },
      { id: 'generate-solution', sequence: 4, name: 'Generate Solution', vm: 'running', 'run-location': 'vm', 'paired-ticket-system-status': 'In Progress', 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'generate-solution',
        action: { type: 'prompt', prompt: 'review-plan', 'agent-count': 1 },
        'exit-events': [{ condition: { all: [{ 'turn-complete': true }, { 'structured-output': { 'is-approved': true } }] }, 'move-to-state': 'ci-checks' }] },
      { id: 'ci-checks', sequence: 5, name: 'CI Checks', vm: 'running', 'run-location': 'vm', 'paired-ticket-system-status': 'In Progress', 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'ci-checks',
        action: { type: 'script', command: 'git -C harness rev-parse --abbrev-ref HEAD' },
        'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'done' }, { condition: { not: { 'exit-code': 0 } }, 'move-to-state': 'blocked-for-human' }] },
      { id: 'blocked-for-human', sequence: 6, 'is-blocked-state': true, action: { type: 'human' } },
      { id: 'done', sequence: 7, 'is-done': true, 'paired-ticket-system-status': 'Done', action: { type: 'none' } },
    ];
  });
  writeFileSync(at('prompts', 'review-plan', 'prompt.txt'), 'Solve {ticket} in {folder}; files in {ticket-folder}; run {agent-sh} ticket:questions-answered {project} {ticket}.\nCode: {project-code-folder}.\n{where}\n');
  edit(at('projects', 'p', 'project.json'), p => { p.hindsight = { port: hindsight, 'llm-api-key': null }; });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => { sp.features[0].variations[0]['merge-request'] = [{ id: 1, repository: s.origins.harness, branch: 'change/ABC-3-1', status: 'Open' }]; });
  c.ctx.env = { ...s.env, FAKE_OUTPUT: '{"is-approved":true}' };
  const settle = async () => {
    await Promise.all([...(c.ctx.memory.workstations?.values() ?? [])].map(r => r.job));
    await Promise.all([...(c.ctx.memory.vms?.values() ?? [])].map(r => r.job));
  };
  const ticks = async (n, done) => { for (let i = 0; i < n && !done(); i++) { await tick(c.ctx); await settle(); if (!done()) await new Promise(r => setTimeout(r, 100)); } return done(); };
  return { c, s, at, settle, ticks, state: () => c.variation()['harness-status'], log: () => c.lines.join('\n') };
}

// ABC-3 A set at generate-solution, its Setup done and its vm recording the workstation (vm: the VM instead).
const atGenerateSolution = (h, vm) => edit(h.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => {
  sp.features[0]['ticket-system-status'] = 'In Progress';
  Object.assign(sp.features[0].variations[0], { 'harness-status': { state: 'generate-solution', 'state-engine': 'example-development' }, vm: vm ?? { name: ID, kind: 'workstation', project: 'p', folder: h.s.root(), 'setup-complete-at': '2026-11-15T00:00:00Z' } });
});

// ABC-9 B holding the workstation, its agent at work (an assignment on it): busy.
function heldByAnother(h) {
  edit(h.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => { sp.features.push({ key: 'ABC-9', 'ticket-system-status': 'In Progress', variations: [{ name: 'B', 'harness-status': { state: 'generate-solution', 'state-engine': 'example-development' }, 'state-changes': [] }] }); });
  edit(h.at('projects', 'p', 'workstations.json'), w => { w[ID].holder = { ticket: 'ABC-9', variation: 'B', since: '2026-11-15T00:00:00Z', folder: h.s.root() }; });
  edit(h.at('assignments.json'), a => { a.assignments.push({ 'agent-name': 'Hulk', project: 'p', 'work-item': 'ABC-9', variation: 'B', 'state-engine': 'example-development', state: 'generate-solution', prompt: 'review-plan', status: 'Running', 'start-time': '2026-11-15T00:00:00Z', 'last-heartbeat': '2026-11-15T00:00:00Z', 'assignment-id': '33333333-3333-4333-8333-333333333333', 'agent-count': 1, 'pen-holder': 'Hulk', 'is-lead': true, model: 'claude-opus-5' }); });
  return () => edit(h.at('assignments.json'), a => { a.assignments = a.assignments.filter(x => x['work-item'] !== 'ABC-9'); });
}

test('AC1, AC2, AC3, AC8: each step claims the workstation, its repositories on the ticket\'s branches, before its agent or script starts, and releases it at its end — committed work pushed, a completed step\'s leftovers committed on its branch, master back — so it is held by nothing between steps', { timeout: 300_000 }, async t => {
  const hs = await fakeHindsight();
  t.after(hs.close);
  const h = await tickFixture({ hindsight: hs.port });
  const { c, s, ticks, state, log } = h;
  c.ctx.env.FAKE_HOLD = join(s.w.dir, 'hold');
  writeFileSync(c.ctx.env.FAKE_HOLD, '');
  try {
    let record;
    await ticks(80, () => (record = c.assignments().assignments.find(a => a.state === 'generate-solution')));
    assert.ok(record, `${JSON.stringify(state())}\n${log()}`);
    const root = s.root(), machine = `workstation:p:${ID}:${root}`, repo = s.repo('harness');
    // Create VM recorded the workstation, claiming nothing; Setup marked on the variation.
    assert.equal(c.variation().vm.kind, 'workstation');
    assert.ok(c.variation().vm['setup-complete-at'], 'Mark Setup Complete marked it');
    assert.deepEqual(c.variation()['state-changes'].filter(x => x['to-state'] === 'setup' && x['sub-state-change']).map(x => x['sub-state-change']['to-state']), ['check-setup-complete', 'create-vm', 'mark-setup-complete', 'done']);
    // Claimed for the step before its agent: the holder, the variation's workstation, its branch checked out.
    assert.equal(s.entry().holder.variation, 'A');
    assert.equal(c.variation().workstation.name, ID);
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3-1');
    const claimed = c.lines.findIndex(l => /^workstation p ada-dev: claimed for ABC-3 A generate-solution: its repositories on ABC-3 A's branches/.test(l));
    const dispatched = c.lines.findIndex(l => new RegExp(`^dispatch ${record['agent-name']} .* in ${root}/repos/ \\(workstation ${ID}\\)$`).test(l));
    assert.ok(claimed >= 0 && dispatched > claimed, log());
    const live = c.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => s.w.sshCalls().some(x => x.argv.at(-1)?.includes(live.agent.marker))), log());
    const dir = readdirSync(join(c.dir, 'agents')).find(d => d.startsWith(`${record['agent-name']}-`));
    const prompt = JSON.parse(readFileSync(join(c.dir, 'agents', dir, 'inbox.jsonl'), 'utf8').trim().split('\n')[0]).prompt;
    assert.ok(prompt.includes(`Solve ABC-3 in ${root}/repos/; files in ${root}/ticket; run agent.sh ticket:questions-answered p ABC-3.`), prompt);
    assert.ok(prompt.includes(`Where you are: on the GCP workstation ${ID}, in its shared repositories under ${root}, checked out on this ticket variation's branches for this step`), prompt);
    assert.ok(await until(() => readFileSync(join(c.dir, 'agents', dir, 'session.txt'), 'utf8').includes(`http://127.0.0.1:${hs.port}/mcp/p/`)), 'its memory at the forwarded port');

    // The agent's work: a commit on its branch, and a test it leaves uncommitted.
    const sha = commit(repo, 'feature.txt', 'built\n');
    writeFileSync(join(repo, 'test.txt'), 'a test\n');
    rmSync(c.ctx.env.FAKE_HOLD);
    // Its turn ends, completed: the step's end commits what it left on its branch (a warning), pushes, and releases the
    // workstation; CI Checks claims it again, its branch from GitLab with both commits.
    await ticks(40, () => state().state === 'done' && !s.entry().holder);
    assert.equal(state().state, 'done', log());
    assert.equal(s.entry().holder, undefined, log());
    assert.equal(c.variation().workstation, undefined);
    assert.equal(remote(s.origins.harness, 'refs/heads/change/ABC-3-1~1'), sha, 'pushed to its branch');
    assert.equal(git(s.origins.harness, 'show', 'change/ABC-3-1:test.txt'), 'a test', 'the test it left, committed there');
    assert.match(git(s.origins.harness, 'log', '-1', '--format=%s', 'change/ABC-3-1'), /^ABC-3 A Generate Solution: what the step left uncommitted, committed by the harness/);
    const released = c.lines.findIndex(l => /^workstation p ada-dev: released by ABC-3 A: pushed harness change\/ABC-3-1 \(2\); its repositories back on master$/.test(l));
    assert.ok(c.lines.some(l => /^workstation warning: ABC-3 A: its step completed but left harness uncommitted on change\/ABC-3-1; committed and pushed by the harness \(test\.txt\)$/.test(l)), log());
    const again = c.lines.findIndex(l => /^workstation p ada-dev: claimed for ABC-3 A ci-checks/.test(l));
    assert.ok(released > dispatched && again > released, log());
    assert.ok(c.lines.some(l => l === `script ${machine}: git -C harness rev-parse --abbrev-ref HEAD`), log());
    assert.ok(c.lines.findLastIndex(l => /released by ABC-3 A: nothing to push; its repositories back on master$/.test(l)) > again, log());
    // Back on master, clean.
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '');
    assert.ok(!existsSync(join(h.at('projects', 'p', 'work', 'ABC-3'), 'carry-A')), 'nothing carried between steps');
    assert.equal(c.variation()['ai-feedback-long'] ?? null, null);
  } finally { c.ctx.stopAgents(); }
});

test('AC3: an agent killed mid-step (stop(): its marked process ended there) still ends its step cleanly — the workstation released, its trees clean on master', { timeout: 240_000 }, async () => {
  const h = await tickFixture();
  const { c, s, ticks, log } = h;
  atGenerateSolution(h);
  c.ctx.env = { ...c.ctx.env, FAKE_HOLD: join(s.w.dir, 'hold'), FAKE_OUTLIVE_STDIN: '1' };
  writeFileSync(join(s.w.dir, 'hold'), '');
  try {
    let record;
    await ticks(40, () => (record = c.assignments().assignments.find(a => a.state === 'generate-solution')));
    assert.ok(record, log());
    const live = c.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => s.w.sshCalls().some(x => x.argv.at(-1)?.includes(live.agent.marker))));
    writeFileSync(join(s.repo('harness'), 'half-done.txt'), 'half\n');
    live.agent.stop();
    assert.ok(await until(() => s.w.sshCalls().some(x => x.argv.includes('pkill') || x.argv.at(-1)?.startsWith("'pkill'"))), 'ended on the workstation, under its marker');
    assert.ok(await ticks(40, () => !s.entry().holder), log());
    assert.equal(git(s.repo('harness'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(s.repo('harness'), 'status', '--porcelain', '--untracked-files=all'), '', log());
    assert.ok(c.lines.some(l => /^workstation p ada-dev: released by ABC-3 A \(its step not completed\): nothing to push/.test(l)), log());
    assert.ok(c.lines.some(l => /^workstation ABC-3 A: discarded what was not committed in harness \(on change\/ABC-3-1\): half-done\.txt$/.test(l)), log());
  } finally { c.ctx.stopAgents(); }
});

test('AC1, AC5, AC8: in workstation mode a step finding the workstation held by another waits, no agent sent, its Health saying why; it goes on once the holder\'s step has ended', { timeout: 240_000 }, async () => {
  const h = await tickFixture();
  const { c, s, ticks, log } = h;
  atGenerateSolution(h);
  assert.equal((await s.result('workstation:connect', 'p', ID)).code, 0);
  const free = heldByAnother(h);
  try {
    await ticks(6, () => false);
    assert.equal(c.assignments().assignments.filter(a => a['work-item'] === 'ABC-3').length, 0, log());
    assert.match(c.variation()['ai-feedback-short'] ?? '', /^Waiting for its workstation: its seat's workstation ada-dev is not free for its step: ada-dev is held by ABC-9 B/, log());
    assert.ok(c.lines.some(l => /ABC-3 A generate-solution: waits: its seat's workstation ada-dev is not free for its step: ada-dev is held by ABC-9 B/.test(l)), log());
    assert.ok(c.lines.some(l => l === 'seats ABC-3 A: takes a workstation seat on ada-dev'), log());   // ASS-469: workstation mode's one seat
    assert.equal(s.entry().holder.ticket, 'ABC-9');
    // ABC-9 B's agent done: its holder, no step of control's, is released; ABC-3 A's step claims it and goes on.
    free();
    let record;
    await ticks(40, () => (record = c.assignments().assignments.find(a => a['work-item'] === 'ABC-3' && a.state === 'generate-solution')));
    assert.ok(record, log());
    assert.ok(c.lines.some(l => /^workstation p ada-dev: released: ABC-9 B held it with no step running/.test(l)), log());
    assert.equal(s.entry().holder.variation, 'A');
    assert.equal(c.variation()['ai-feedback-long'] ?? null, null, 'its Health cleared');
  } finally { c.ctx.stopAgents(); }
});

// ASS-469: the seats as control records them (seats.json).
const seatsOf = h => { try { return JSON.parse(readFileSync(h.at('projects', 'p', 'seats.json'), 'utf8')).seats; } catch { return []; } };

test('ASS-469 AC3, AC4, AC8: in vm+workstation mode a VM-seat holder\'s step runs on its VM, its repositories moved to its branches first, never on the workstation another seat-holder holds; once that one leaves, it moves into the workstation seat between its steps — not while its step runs — and its next step runs there', { timeout: 300_000 }, async () => {
  const h = await tickFixture({ mode: 'vm+workstation' });
  const { c, s, ticks, state, log } = h;
  // ABC-3 A's VM, its repositories clones of GitLab's, its ticket folder at /mnt/ticket.
  const v = fakeVm(s.env);
  v.instance('abc-3-a', 'Running');
  for (const r of ['harness', 'example-corpus']) execFileSync('git', ['clone', '-q', s.origins[r], join(v.root, 'repos', r)]);
  mkdirSync(join(v.root, 'mnt'), { recursive: true });
  execFileSync('ln', ['-s', realpathSync(h.at('projects', 'p', 'work', 'ABC-3')), join(v.root, 'mnt', 'ticket')]);
  c.ctx.env = { ...c.ctx.env, ...v.env, HOME: s.env.HOME, LIMA_HOME: v.instances, FAKE_HOLD: join(s.w.dir, 'hold') };
  writeFileSync(join(s.w.dir, 'hold'), '');
  // One VM seat and the workstation's one seat; ABC-9 B already in the workstation seat, at work there.
  edit(h.at('harness.json'), x => { x['max-tickets-in-progress'] = 5; });
  edit(h.at('projects', 'p', 'project.json'), p => { p['max-tickets-in-progress'] = 1; });
  atGenerateSolution(h, { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-11-15T00:00:00Z' });
  assert.equal((await s.result('workstation:connect', 'p', ID)).code, 0);
  const free = heldByAnother(h);
  writeFileSync(h.at('projects', 'p', 'seats.json'), JSON.stringify({ seats: [{ key: 'ABC-9', variation: 'B', kind: 'workstation', workstation: ID, since: '2026-11-15T00:00:00Z' }] }));
  try {
    let record;
    await ticks(40, () => (record = c.assignments().assignments.find(a => a.state === 'generate-solution' && a['work-item'] === 'ABC-3')));
    assert.ok(record, log());
    assert.deepEqual(seatsOf(h).map(x => [x.key, x.kind]), [['ABC-3', 'vm'], ['ABC-9', 'workstation']], log());
    assert.ok(c.lines.some(l => l === 'seats ABC-3 A: takes a VM seat'), log());
    assert.ok(c.lines.some(l => /ABC-3 A generate-solution: it holds a VM seat: its step runs on its VM$/.test(l)), log());
    assert.ok(c.lines.some(l => /ABC-3 A generate-solution: runs on its VM abc-3-a, its repositories moved to its branches/.test(l)), log());
    assert.equal(git(join(v.root, 'repos', 'harness'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3-1', log());
    const live = c.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => v.calls().some(x => x.vm === 'abc-3-a' && x.argv.includes(live.agent.marker))), log());
    assert.equal(c.variation().workstation, undefined);
    const sha = commit(join(v.root, 'repos', 'harness'), 'from-vm.txt', 'built in the VM\n');
    // ABC-9 B is done: it leaves its workstation seat (its stale holder released). ABC-3 A's step still runs on its VM, so it does not move yet.
    edit(h.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => { sp.features[1].variations[0]['harness-status'] = { state: 'done', 'state-engine': 'example-development' }; });
    free();
    await ticks(4, () => false);
    assert.ok(c.lines.some(l => l === 'seats ABC-9 B: leaves a workstation seat on ada-dev (no longer in progress)'), log());
    assert.deepEqual(seatsOf(h).map(x => [x.key, x.kind]), [['ABC-3', 'vm']], 'mid-step: not moved');
    assert.ok(!c.lines.some(l => /ABC-3 A: moves from a VM seat/.test(l)), log());
    // Its turn ends: its VM's step end pushes; at the next tick it moves into the workstation seat, and CI Checks runs on the workstation.
    rmSync(join(s.w.dir, 'hold'));
    await ticks(40, () => state().state === 'done' && !s.entry().holder);
    assert.equal(state().state, 'done', log());
    assert.ok(git(s.origins.harness, 'log', '--format=%H', 'change/ABC-3-1').split('\n').includes(sha), 'pushed from the VM');
    const ended = c.lines.findIndex(l => /^workstation ABC-3 A: its step ended on its VM: pushed harness change\/ABC-3-1/.test(l));
    const moved = c.lines.findIndex(l => l === 'seats ABC-3 A: moves from a VM seat to a workstation seat on ada-dev, between its steps; its VM seat is free for the next ticket');
    const claimed = c.lines.findIndex(l => /^workstation p ada-dev: claimed for ABC-3 A ci-checks/.test(l));
    assert.ok(ended >= 0 && moved > ended && claimed > moved, log());
    assert.ok(c.lines.some(l => l === `script workstation:p:${ID}:${s.root()}: git -C harness rev-parse --abbrev-ref HEAD`), log());
    assert.equal(git(join(v.root, 'repos', 'harness'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the VM left on master');
    assert.equal(c.variation().vm.name, 'abc-3-a', 'its VM kept');
  } finally { c.ctx.stopAgents(); }
});
