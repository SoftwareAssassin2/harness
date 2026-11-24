// ASS-567: a step starts only where the planner places it. Seen live after ASS-565: a ticket finished Setup in its Mac
// Substrate sandbox (local-substrate), its seat went at setup's end, it moved on to Plan's enrich-ac (`worktree: true`,
// so local-worktree) — and in that same tick enrich-ac's agent was dispatched into the sandbox (with no seat record, its
// machine was read from its run-target), which control was hibernating meanwhile; its ticket folder was synced into
// the sandbox as it was being suspended, so the agent found /mnt/ticket empty and asked the operator for its ticket.
// AC1: whole ticks over frozen loaded state (control fixture, real tick()) — Setup on local-substrate, then a
// worktree step, at the top level or as a run's first step, straight on or through a step that uses no machine: the
// worktree step's agent is dispatched in the Mac worktree (that tick or the next), never in the sandbox; no ticket
// folder is ever synced into a sandbox that is stopped or being stopped. AC2: every pair of differing targets
// (sandbox ↔ worktree, sandbox ↔ VM, worktree ↔ VM, remote ↔ Mac): a step whose seat record still names the previous
// step's target, or which has none yet, is held (run-target-places.js heldElsewhere) until it is placed on its own,
// and then everything that starts it reads that one (runsOnMachine, machineOf) — plus whole ticks worktree → sandbox →
// worktree, each straight on. AC4: a copy that leaves /mnt/ticket short is caught, logged as a harness fault, the step held and retried,
// never dispatched (AC3, the commands' side with the fake command server: test/agent-cli/substrate-ticket-copy.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deepFreeze } from '../../src/control/read.js';
import { heldElsewhere, runsOnMachine } from '../../src/control/run-target-places.js';
import { machineOf } from '../../src/control/machine.js';
import { syncSandboxTicket, superviseSandboxes, sandboxWaits } from '../../src/control/sandboxes.js';
import { tick } from '../../src/control/tick.js';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { until } from '../support/until.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const ok = to => [{ condition: { 'exit-code': 0 }, 'move-to-state': to }];
const script = (id, sequence, targets, to) => ({ id, sequence, 'run-location': 'vm', 'run-targets': targets, action: { type: 'script', command: 'true' }, 'exit-events': [...ok(to), { condition: { not: { 'exit-code': 0 } }, 'move-to-state': id }] });
const prompt = (id, sequence, to, extra = {}) => ({ id, sequence, 'run-location': 'vm', action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': to }], ...extra });
const committed = to => ({ id: 'committed', sequence: 2, 'is-planning-stage': true, action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': to }] });
const done = sequence => ({ id: 'done', sequence, 'is-done': true, action: { type: 'none' } });
// Setup's end: a step that uses no machine (the variation's seat goes, ASS-527), then on.
const between = (id, sequence, to) => ({ id, sequence, action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': to }] });

// ticks(f, { steps, engines, targets }) — the fixture's project p on `targets` (a Mac cluster declared), its engine
// `steps`, sub-engines `engines`; the Substrate and git commands faked as they behave (code:hand-over records the
// run-target, onto local-worktree its worktree folder; substrate:sandbox-up the sandbox; substrate:sandbox-stop takes
// a moment, the sandbox `stopping` meanwhile, then stopped), a script in a sandbox exiting 0, the rest the real
// agent.sh; ticks until done. Returns { log, states, handOvers, syncs (the sandbox's state at each ticket copy) }.
async function ticks(f, { steps, engines = {}, targets = ['local-substrate', 'local-worktree'] }) {
  const dir = join(f.dir, 'projects', 'p'), sprintFile = join(dir, 'sprints', 'sprint-10', 'sprint.json');
  f.seats(4);
  edit(join(f.dir, 'engines', 'example-development', 'workflow.yaml'), e => { e.steps = [e.steps.find(s => s.id === 'blocked'), ...steps]; });
  for (const [name, sub] of Object.entries(engines)) { mkdirSync(join(f.dir, 'engines', name), { recursive: true }); writeFileSync(join(f.dir, 'engines', name, 'workflow.yaml'), JSON.stringify({ steps: sub }, null, 2)); }
  edit(join(dir, 'project.json'), p => { p['dev-environments'] = { 'run-targets': targets, substrate: { clusters: [{ machine: 'mac' }] } }; });
  const variationOnDisk = change => edit(sprintFile, s => change(s.features[0].variations[0]));
  variationOnDisk(v => { v['harness-status'] = hs('committed'); });
  const real = f.ctx.cli, realScript = f.ctx.script, handOvers = [], syncs = [], sandboxCalls = [];
  let sandbox = null;   // the fake sandbox's state: null (none), running, stopping, stopped
  f.ctx.cli = async (args, env) => {
    const [command, , , , target] = args;
    if (command === 'code:hand-over') {
      handOvers.push(target);
      const folder = join(f.dir, 'worktrees', 'ABC-3');
      variationOnDisk(v => {
        v['run-target'] = { target, at: new Date().toISOString() };
        if (target === 'local-worktree') { mkdirSync(folder, { recursive: true }); v.build = { ...v.build, 'worktree-folder': folder, 'worktree-by': 'run-target' }; }
      });
      return `${JSON.stringify({ branch: 'change/ABC-3.A-1', folder: target === 'local-worktree' ? folder : null })}\n`;
    }
    if (command === 'substrate:sandbox-up') {
      sandboxCalls.push(args.join(' '));
      const created = sandbox == null;
      sandbox = 'running';
      variationOnDisk(v => { v.sandbox = { name: 'abc-3-a', project: 'p', machine: 'mac', template: 't', image: 'sha256:d', state: 'running' }; });
      return `${JSON.stringify({ name: 'abc-3-a', machine: 'substrate:p:mac:abc-3-a', host: 'mac', created, resumed: !created, template: 't', branches: [] })}\n`;
    }
    if (command === 'substrate:sandbox-stop') {
      sandboxCalls.push(args.join(' '));
      sandbox = 'stopping';
      await new Promise(r => setTimeout(r, 40));   // a suspend takes a moment; the tick goes on beside it
      sandbox = 'stopped';
      variationOnDisk(v => { v.sandbox = { ...v.sandbox, state: 'stopped', at: new Date().toISOString() }; });
      return '{"stopped":true}\n';
    }
    if (command === 'substrate:sandbox-sync-ticket') { syncs.push(sandbox); return ''; }
    if (command === 'substrate:sandbox-delete') { sandbox = null; variationOnDisk(v => { delete v.sandbox; }); return '{"deleted":true,"branches":[]}\n'; }
    if (command === 'substrate:stack-up') return '{"stack":false}\n';
    if (command.startsWith('substrate:') || command === 'code:remove-worktree') return '{}\n';
    return real(args, env);
  };
  f.ctx.succeeds = () => Promise.resolve(true);
  f.ctx.script = (argv, vm, env) => (String(vm ?? '').startsWith('substrate:') ? Promise.resolve({ exitCode: 0, stdout: '' }) : realScript(argv, vm, env));
  let clock = Date.now();
  f.ctx.now = () => new Date(clock);
  const states = [];
  for (let i = 0; i < 40; i++) {
    clock += 60_000;
    await tick(f.ctx);
    await until(() => [...f.ctx.agents.values()].every(a => a.result || a.exited));   // its fake agent's turn over before the next tick
    const state = f.variation()['harness-status'].state;
    if (states.at(-1) !== state) states.push(state);
    if (state === 'done') break;
  }
  for (const j of f.ctx.memory.sandboxJobs?.values() ?? []) await j;   // a stop still running beside the last tick
  return { log: f.lines.join('\n'), states, handOvers, syncs, sandboxCalls };
}

const WORKTREE_PLAN = prompt('enrich-ac', 1, 'done', { worktree: true });
const SHAPES = {
  'straight on, at the top level': { steps: [committed('setup'), script('setup', 3, ['local-substrate'], 'plan'), prompt('plan', 4, 'done', { worktree: true, 'is-planning-stage': true }), done(5)], step: 'plan' },
  'through a step that uses no machine, at the top level': { steps: [committed('setup'), script('setup', 3, ['local-substrate'], 'setup-done'), between('setup-done', 4, 'plan'), prompt('plan', 5, 'done', { worktree: true, 'is-planning-stage': true }), done(6)], step: 'plan' },
  'as a run\'s first step': { steps: [committed('setup'), script('setup', 3, ['local-substrate'], 'plan'), { id: 'plan', sequence: 4, 'is-planning-stage': true, action: { type: 'state-engine', engine: 'plan-run' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'done' }] }, done(5)], engines: { 'plan-run': [WORKTREE_PLAN, done(2)] }, step: 'enrich-ac' },
  'through a step that uses no machine, as a run\'s first step': { steps: [committed('setup'), script('setup', 3, ['local-substrate'], 'setup-done'), between('setup-done', 4, 'plan'), { id: 'plan', sequence: 5, 'is-planning-stage': true, action: { type: 'state-engine', engine: 'plan-run' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'done' }] }, done(6)], engines: { 'plan-run': [WORKTREE_PLAN, done(2)] }, step: 'enrich-ac' },
};

for (const [shape, { steps, engines, step }] of Object.entries(SHAPES)) {
  test(`AC1: Setup in the sandbox, then a worktree step ${shape}: its agent goes to the Mac worktree, never into the sandbox; no ticket copy into a stopped or stopping sandbox`, { timeout: 120_000 /* hang guard: the ticks themselves are awaited */ }, async () => {
    const f = controlFixture();
    try {
      const { log, states, handOvers, syncs, sandboxCalls } = await ticks(f, { steps, engines });
      assert.ok(states.includes('done'), `${states.join(' → ')}\n${log}`);
      assert.ok(sandboxCalls.includes('substrate:sandbox-up p ABC-3 A mac'), `Setup ran in its sandbox\n${log}`);
      assert.deepEqual(handOvers, ['local-substrate', 'local-worktree'], log);
      assert.match(log, new RegExp(`dispatch \\S+ \\([^)]*\\) on ABC-3 A ${step}, pid \\d+, in \\S+/worktrees/ABC-3, in Claude Code's sandbox`), log);
      assert.doesNotMatch(log, new RegExp(`on ABC-3 A ${step}, pid \\d+, in /repos/`), 'never dispatched into the sandbox');
      assert.ok(syncs.every(s => s === 'running'), `a ticket copy into a sandbox that was ${syncs.join(', ')}\n${log}`);
      assert.doesNotMatch(log, /not extensible|Cannot add property/);
    } finally { f.ctx.stopAgents(); }
  });
}

// AC2: whole ticks the other way and back — a worktree step, a sandbox script straight after it, a worktree step
// straight after that (no step between to give the seats a tick: ASS-565's tick-level test had one).
test('AC2: whole ticks worktree → sandbox → worktree, each straight on: each step where its own step is placed, the sandbox script only once its sandbox is up and its ticket copied in', { timeout: 120_000 /* hang guard */ }, async () => {
  const f = controlFixture();
  try {
    const scripts = [];
    const steps = [committed('plan'), prompt('plan', 3, 'build', { worktree: true, 'is-planning-stage': true }), script('build', 4, ['local-substrate'], 'review'), prompt('review', 5, 'done', { worktree: true }), done(6)];
    const run = ticks(f, { steps });
    const installed = f.ctx.script;
    f.ctx.script = (argv, vm, env) => { scripts.push(String(vm ?? 'host')); return installed(argv, vm, env); };
    const { log, states, handOvers, syncs } = await run;
    assert.ok(states.includes('done'), `${states.join(' → ')}\n${log}`);
    assert.deepEqual(handOvers, ['local-worktree', 'local-substrate', 'local-worktree'], log);
    assert.match(log, /on ABC-3 A plan, pid \d+, in \S+\/worktrees\/ABC-3/);
    assert.match(log, /on ABC-3 A review, pid \d+, in \S+\/worktrees\/ABC-3/);
    assert.doesNotMatch(log, /on ABC-3 A (plan|review), pid \d+, in \/repos\//);
    assert.deepEqual(scripts, ['substrate:p:mac:abc-3-a'], 'build ran in the sandbox, never on the worktree plan used');
    assert.ok(syncs.length >= 1 && syncs.every(s => s === 'running'), syncs.join(', '));
  } finally { f.ctx.stopAgents(); }
});

// AC2: every pair of differing targets, by class. A step at `to` after one at `from`: with its record still naming
// `from`, or with none (its run-target `from`, the previous step's place), it is held; once seats.js places it on
// `to`, it is not — and then the step's place, as dispatch and steps.js read it, is `to`'s.
const PAIRS = [
  ['local-substrate', 'local-worktree'], ['workstation-substrate', 'workstation-worktree'],   // sandbox ↔ worktree
  ['local-substrate', 'local-vm'], ['cloud-vm-substrate', 'cloud-vm'],                        // sandbox ↔ VM
  ['local-worktree', 'local-vm'], ['workstation-worktree', 'workstation'],                     // worktree ↔ VM
  ['workstation', 'local-worktree'], ['cloud-vm-worktree', 'local-substrate'], ['workstation-substrate', 'local-vm'], ['cloud-vm', 'local-substrate'],   // remote ↔ Mac
];
const SEAT = { 'local-substrate': { kind: 'vm' }, 'local-vm': { kind: 'vm' }, workstation: { kind: 'workstation', workstation: 'ws-1' }, 'workstation-worktree': { kind: 'workstation', workstation: 'ws-1' }, 'workstation-substrate': { kind: 'workstation', workstation: 'ws-1' }, 'cloud-vm': { kind: 'cloud-vm', workstation: 'vm-1' }, 'cloud-vm-worktree': { kind: 'cloud-vm', workstation: 'vm-1' }, 'cloud-vm-substrate': { kind: 'cloud-vm', workstation: 'vm-1' } };
const MAC = new Set(['local-worktree', 'local-workspace']);
// projectAt(record, last) — a project whose ticket ABC-3 A last ran on `last` (its run-target), holding `record`'s target.
function projectAt(record, last) {
  const variation = { name: 'A', 'harness-status': { state: 'next', 'state-engine': 'e' }, vm: { name: 'abc-3-a' }, sandbox: { name: 'abc-3-a', project: 'p', machine: 'mac', state: 'running' }, ...(last ? { 'run-target': { target: last } } : {}) };
  const t = deepFreeze({ key: 'ABC-3', variations: [variation] });
  const records = record == null ? {} : MAC.has(record) ? { localSeats: deepFreeze([{ key: 'ABC-3', variation: 'A', target: record }]) } : { seats: deepFreeze([{ key: 'ABC-3', variation: 'A', target: record, ...SEAT[record] }]) };
  return { project: { id: 'p', tickets: [t], ...records }, v: t.variations[0] };
}
const vmStep = { id: 'next', 'run-location': 'vm', action: { type: 'prompt', prompt: 'p' } };

for (const [a, b] of PAIRS) for (const [from, to] of [[a, b], [b, a]]) {
  test(`AC2: ${from} → ${to}: the step is held while its record names ${from}, or it has none, and starts on ${to} once placed there`, () => {
    const planned = { targets: [{ key: 'ABC-3', variation: 'A', target: to, candidates: [to] }] };
    assert.equal(heldElsewhere(projectAt(from, from).project, 'ABC-3', 'A', planned), true, `its record still ${from}`);
    assert.equal(heldElsewhere(projectAt(null, from).project, 'ABC-3', 'A', planned), true, `no record yet, its run-target ${from}`);
    const { project, v } = projectAt(to, from);
    assert.equal(heldElsewhere(project, 'ABC-3', 'A', planned), false, `placed on ${to}`);
    // Where it starts, as dispatch (vmFor) and steps.js read it: on the Mac, or in the machine `to` names.
    assert.equal(runsOnMachine(project, 'ABC-3', 'A', vmStep), !MAC.has(to));
    if (/-substrate$/.test(to)) assert.equal(machineOf(v, to), 'substrate:p:mac:abc-3-a');
    else if (!MAC.has(to)) assert.doesNotMatch(String(machineOf(v, to)), /^substrate:/, `not the sandbox ${from} used`);
  });
}

// AC4: a copy that leaves /mnt/ticket short, the stop/copy race, and a sandbox not up for the step.
function bareCtx(answer = () => '') {
  const calls = [], lines = [];
  return {
    memory: { warned: new Set(), backoff: new Map() }, calls, lines,
    attempt: async (phase, what, fn) => { try { await fn(); } catch (error) { lines.push(`error ${phase} ${what}: ${error.message}`); } },
    now: () => new Date('2026-11-23T12:00:00Z'),
    log: (phase, text) => lines.push(`${phase} ${text}`),
    cli: async args => { calls.push(args.join(' ')); return answer(args); },
  };
}

test('AC4: a ticket copy that leaves /mnt/ticket empty is caught: logged as a harness fault (sandbox ticket folder empty), the step held and retried — nothing starts in the sandbox until a copy holds the files', { timeout: 120_000 /* hang guard */ }, async () => {
  const f = controlFixture();
  try {
    let empty = 1;   // the first copy comes out short, the next holds the files
    const started = [];
    const steps = [committed('build'), script('build', 3, ['local-substrate'], 'done'), done(4)];
    const run = ticks(f, { steps, targets: ['local-substrate'] });
    // Wrapped after ticks() installs its fakes: substrate:sandbox-sync-ticket fails as the command does (exit 4).
    const cli = f.ctx.cli, script_ = f.ctx.script;
    f.ctx.cli = async (args, env) => {
      if (args[0] === 'substrate:sandbox-sync-ticket' && empty > 0) {
        empty--;
        throw Object.assign(new Error('agent.sh substrate:sandbox-sync-ticket p ABC-3 A: substrate:sandbox-sync-ticket: ticket folder empty: substrate:p:mac:abc-3-a\'s /mnt/ticket holds 0 of the ticket folder\'s 3 entries after the copy'), { code: 4 });
      }
      return cli(args, env);
    };
    f.ctx.script = (argv, vm, env) => { started.push(empty); return script_(argv, vm, env); };
    const { log, states } = await run;
    assert.ok(states.includes('done'), `${states.join(' → ')}\n${log}`);
    assert.equal((log.match(/harness fault: sandbox ticket folder empty/g) ?? []).length, 1, log);
    assert.match(log, /ABC-3 A build: could not bring its sandbox's ticket copy up to date: .*ticket folder empty.*; tried again in \d+s/, log);
    assert.deepEqual(started, [0], 'its script started once, only after a copy held the files');
  } finally { f.ctx.stopAgents(); }
});

test('AC4: in dispatch, the same fault holds the agent: syncSandboxTicket rejects, logged as a harness fault, before any assignment is made', async () => {
  const ctx = bareCtx(args => { if (args[0] === 'substrate:sandbox-sync-ticket') throw Object.assign(new Error('substrate:sandbox-sync-ticket: ticket folder empty: … holds 0 of 3'), { code: 4 }); return '{}\n'; });
  const variation = { name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' }, sandbox: { name: 'abc-3-a', project: 'p', machine: 'mac', state: 'running' } };
  const t = { key: 'ABC-3', variations: [variation] };
  const project = { id: 'p', tickets: [t], seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }] };
  ctx.memory.sandboxes = new Map([['p/ABC-3/A', { failures: 0, until: 0, job: null, up: 'mac' }]]);   // brought up by this control
  await assert.rejects(syncSandboxTicket(ctx, project, t, variation, 'substrate:p:mac:abc-3-a'), /ticket folder empty/);
  assert.match(ctx.lines.join('\n'), /^error sandbox ABC-3 A: harness fault: sandbox ticket folder empty — \/mnt\/ticket in abc-3-a lacks the ticket's files/m);
  assert.ok(!ctx.calls.some(c => c.startsWith('assignments:create')));
});

test('AC3, AC4: no ticket copy while control is stopping the sandbox (the step waits, nothing started); one not up for the step (a run holding no substrate seat) is resumed first, which copies the folder', async () => {
  let release;
  const stopped = new Promise(r => { release = r; });
  const ctx = bareCtx(async args => { if (args[0] === 'substrate:sandbox-stop') await stopped; return args[0] === 'substrate:sandbox-up' ? '{"name":"abc-3-a","created":false,"resumed":true}\n' : '{}\n'; });
  const variation = { name: 'A', 'harness-status': { state: 'review', 'state-engine': 'e' }, sandbox: { name: 'abc-3-a', project: 'p', machine: 'mac', state: 'running' }, 'run-target': { target: 'local-worktree' } };
  const t = { key: 'ABC-3', variations: [variation] };
  const project = { id: 'p', engine: { steps: [{ id: 'review' }, { id: 'done', 'is-done': true }] }, tickets: [t], localSeats: [{ key: 'ABC-3', variation: 'A', target: 'local-worktree' }] };
  // Its step on the worktree now: superviseSandboxes stops (hibernates) the sandbox, the stop running beside the tick.
  superviseSandboxes(ctx, { projects: [project], assignments: [] });
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(ctx.calls, ['substrate:sandbox-stop p ABC-3 A']);
  await assert.rejects(syncSandboxTicket(ctx, project, t, variation, 'substrate:p:mac:abc-3-a'), /is being stopped: nothing is copied into it or started in it/);
  // A step placed back on the sandbox meanwhile waits for the stop to end before its sandbox is brought up again.
  const onSandbox = { ...project, localSeats: [], seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }] };
  assert.equal(sandboxWaits(ctx, {}, onSandbox, t, variation, vmStep, 'ABC-3 A next'), true);
  assert.ok(!ctx.calls.some(c => c.startsWith('substrate:sandbox-up')), ctx.calls.join('; '));
  release();
  for (const j of ctx.memory.sandboxJobs?.values() ?? []) await j;
  // Stopped now: a step holding no substrate seat that runs in it all the same (Blocked's runs) resumes it first.
  const hibernated = { ...variation, sandbox: { ...variation.sandbox, state: 'stopped' } };
  const blocked = { ...project, localSeats: [] };
  await syncSandboxTicket(ctx, blocked, { ...t, variations: [hibernated] }, hibernated, 'substrate:p:mac:abc-3-a');
  assert.equal(ctx.calls.at(-1), 'substrate:sandbox-up p ABC-3 A mac', 'resumed (its ticket folder copied as it resumes), never copied into while suspended');
  assert.ok(!ctx.calls.includes('substrate:sandbox-sync-ticket p ABC-3 A'));
  assert.match(ctx.lines.join('\n'), /brought up on the Mac before a step that holds no substrate seat runs in it, its ticket folder copied in/);
});
