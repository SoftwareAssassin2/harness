// ASS-555: every agent on a worktree run target runs inside Claude Code's own sandbox. AC1: an agent dispatched on
// local-worktree (the Mac) starts with the sandbox settings, inline: writes held to its worktree and temp (Bash by
// the sandbox, the file tools by blockWritesOutsideWorkingDirectories), hosts held to the project's allowlist, strict,
// no unsandboxed retry, and Claude Code refusing to start without it. (The real check on the Mac — a write outside
// refused, an unlisted host refused — is in the ticket's change notes: Claude Code 2.1.330.)
// ASS-564 (replacing ASS-555's AC2 refusal): a machine whose sandbox can't run (a remote one's setup probe failed or
// has not run; the Mac without Seatbelt) stays a candidate for the worktree targets — placed there, its seat kept,
// never refused at dispatch — and its agent starts with unsandboxed settings, logged once per machine and recorded in
// its session (sandbox.json, sandboxed: false). Where the sandbox works the settings are ASS-555's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { assignSeats } from '../../src/control/seats.js';
import { seatCapacity, keepSeats, placeSeats } from '../../src/control/seat-kinds.js';
import { planDispatch } from '../../src/control/plan.js';
import { projectRunTargets } from '../../src/control/run-targets.js';
import { headroomOf } from '../../src/control/pool-choice.js';
import { sandboxRefused, noteUnsandboxed } from '../../src/control/dispatch.js';
import { unsandboxedSettings } from '../../src/agents/worktree-sandbox.js';
import { until } from '../support/until.js';

const edit = (file, change) => { const j = JSON.parse(readFileSync(file, 'utf8')); change(j); writeFileSync(file, JSON.stringify(j, null, 2)); };

test('ASS-555 AC1, AC3: an agent dispatched on local-worktree starts in Claude Code\'s sandbox — its worktree and temp writable, the project\'s allowlist strict, no unsandboxed retry, refused to start without it — settings inline, kept in its session folder, logged', async () => {
  const f = controlFixture();
  const at = (...rest) => join(f.dir, ...rest);
  const wt = at('wt');
  mkdirSync(wt);
  edit(at('projects', 'p', 'project.json'), p => {
    p['dev-environments'] = { 'run-targets': ['local-worktree'] };
    p.repositories = [{ url: 'https://gitlab.example.com/acme/app.git', description: 'the app' }];
    p['dev-environments'].substrate = { egress: { allow: ['pypi.org'] } };
  });
  // Its worktree made already (handed over to local-worktree before): ASS-567 dispatches it only once placed there, and
  // readyTarget then finds its place ready rather than handing over from the fixture's workspace (not a git checkout).
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => { Object.assign(sp.features[0].variations[0], { build: { 'worktree-folder': wt }, 'run-target': { target: 'local-worktree', at: '2026-11-23T00:00:00Z' } }); });
  f.ctx.macSandboxProblem = () => null;   // Seatbelt there, whatever the machine running the test
  try {
    // ASS-567: the ticket reaches plan in the first tick's steps phase, after its seats were placed: its agent goes in
    // the next tick, once local-worktree is recorded for it (run-target-places.js heldElsewhere).
    await tick(f.ctx);
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    assert.ok(record, f.lines.join('\n'));
    const live = f.ctx.agents.get(record['agent-name']);
    const args = () => readFileSync(join(live.agent.dir, 'session.txt'), 'utf8').split('\n').find(l => l.startsWith('args ')) ?? '';
    assert.ok(await until(() => args()));
    const settings = JSON.parse(args().slice(args().indexOf('--settings ') + '--settings '.length));
    assert.deepEqual(settings, JSON.parse(readFileSync(join(live.agent.dir, 'sandbox-settings.json'), 'utf8')), 'the copy kept in its session folder');
    const s = settings.sandbox;
    assert.equal(s.enabled, true);
    assert.equal(s.failIfUnavailable, true, 'never unsandboxed: Claude Code exits instead');
    assert.equal(s.allowUnsandboxedCommands, false, 'no dangerouslyDisableSandbox retry');
    assert.equal(s.filesystem.allowWrite[0], wt, 'its worktree');
    assert.ok(!s.filesystem.allowWrite.some(p => p === f.dir || p.startsWith(join(f.dir, 'projects'))), 'never the harness\'s data');
    assert.equal(s.network.strictAllowlist, true, 'a host off the allowlist refused, even in bypassPermissions');
    for (const h of ['gitlab.example.com', 'api.anthropic.com', 'registry.npmjs.org', 'pypi.org']) assert.ok(s.network.allowedDomains.includes(h), h);
    assert.ok(!s.network.allowedDomains.includes('example.com'));
    assert.deepEqual(s.excludedCommands, [`${f.ctx.root}/agent.sh *`, `${f.ctx.root}/off-board.sh *`], 'only the harness\'s CLIs, by absolute path');
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /agent-sh-guard\.js/);
    assert.equal(settings.permissions.blockWritesOutsideWorkingDirectories, true, 'the file tools held to the worktree too');
    assert.deepEqual(settings.permissions.deny, ['WebFetch']);
    assert.ok(s.credentials.envVars.some(e => e.name === 'CLAUDE_CODE_OAUTH_TOKEN' && e.mode === 'deny'));
    assert.ok(s.credentials.files.some(e => e.path === join(f.dir, 'projects', '*', 'project.json') && e.mode === 'deny'), 'the Jira token\'s file unreadable');
    assert.ok(f.lines.some(l => l.includes(`in Claude Code's sandbox (local-worktree: writes ${wt}`)), f.lines.join('\n'));
    assert.deepEqual(JSON.parse(readFileSync(join(live.agent.dir, 'sandbox.json'), 'utf8')), { sandboxed: true, target: 'local-worktree', machine: 'mac' }, 'ASS-564: the session records it sandboxed');
    assert.ok(!f.lines.some(l => /running unsandboxed/.test(l)));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-555 AC1: an agent on a target that is not a worktree one keeps its settings as before (no Claude Code sandbox of the harness\'s)', async () => {
  const f = controlFixture();
  const wt = join(f.dir, 'wt');
  mkdirSync(wt);
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => { sp.features[0].variations[0].build = { 'worktree-folder': wt }; });
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    const live = f.ctx.agents.get(record['agent-name']);
    const args = () => readFileSync(join(live.agent.dir, 'session.txt'), 'utf8').split('\n').find(l => l.startsWith('args ')) ?? '';
    assert.ok(await until(() => args()));
    assert.ok(args().endsWith('--settings {"sandbox":{"enabled":false}}'), args());
    assert.ok(!existsSync(join(live.agent.dir, 'sandbox-settings.json')));
  } finally {
    f.ctx.stopAgents();
  }
});

// The pool: one workstation, its live entry `entry`, the project on [workstation-worktree, local-worktree].
const ws = { id: 'ws-1', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' };
const UP = { state: 'running', connected: true, 'connected-at': '2026-11-23T10:05:00Z', setup: { ok: true, 'checked-at': '2026-11-23T10:09:00Z', home: '/home/u' } };
const NO_BWRAP = { ...UP, setup: { ...UP.setup, sandbox: { ok: false, why: 'bubblewrap socat not installed' } } };
const WITH_BWRAP = { ...UP, setup: { ...UP.setup, sandbox: { ok: true } } };
const projectOn = (entry, seats = []) => ({ id: 'p', devEnvironments: { mode: 'workstation', workstations: [ws] }, workstations: { 'ws-1': entry }, seats, seatBudget: { seats: 2 } });

test('ASS-564 AC1: a remote machine whose sandbox can\'t run, or has not been probed, keeps its seats for the worktree targets — planned there, a seat held there kept, placed there', () => {
  for (const entry of [NO_BWRAP, UP]) {
    const capacity = seatCapacity(projectOn(entry));
    assert.deepEqual(capacity.byKind, { workstation: 1, 'cloud-vm': 0 });
    assert.equal(capacity.byWorktree, undefined, 'no separate count for the worktree targets any more');
    assert.equal(headroomOf(projectOn(entry))('workstation-worktree').machine, 'ws-1');
    const engine = { steps: [{ id: 'committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } }, { id: 'build', sequence: 2, name: 'build', action: { type: 'prompt', prompt: 'p' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }] }, { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } }] };
    const ranked = [{ key: 'T-1', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' } }] }];
    const rt = projectRunTargets({ name: 'p', 'dev-environments': { 'run-targets': ['workstation-worktree', 'local-worktree'], workstations: [ws] } });
    assert.deepEqual(planDispatch({ ranked, engine, harness: {}, seats: { mac: 2, remote: capacity.remote, byKind: capacity.byKind }, runTargets: rt }).targets.map(t => t.target), ['workstation-worktree']);
    const held = [{ key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-worktree', since: 'x' }];
    const kept = keepSeats(held, capacity);
    assert.deepEqual([kept.kept.map(s => s.key), kept.lost], [['T-1'], []]);
    const placed = placeSeats({ records: [], reserved: [{ key: 'T-3', variation: 'A' }], capacity, targetFor: () => ({ target: 'workstation-worktree', candidates: ['workstation-worktree', 'workstation'] }) });
    assert.deepEqual(placed.seated.map(s => [s.key, s.workstation, s.target]), [['T-3', 'ws-1', 'workstation-worktree']]);
  }
});

test('ASS-564 AC1: dispatch refuses no agent for its sandbox any more', () => {
  const machine = 'workstation:p:ws-1:/home/u/harness/worktrees/T-1';
  for (const entry of [NO_BWRAP, UP, WITH_BWRAP]) assert.equal(sandboxRefused(projectOn(entry, [{ key: 'T-1', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-worktree' }]), 'T-1', 'A', machine), null);
});

test('ASS-564 AC1: control keeps a worktree step on a machine whose setup found no sandbox — no seat given up, nothing logged against it', async () => {
  const c = controlFixture();
  const at = (...rest) => join(c.dir, ...rest);
  edit(at('engines', 'example-development', 'workflow.yaml'), e => { e.steps.find(s => s.id === 'build')['run-location'] = 'vm'; });
  edit(at('projects', 'p', 'project.json'), p => { p['dev-environments'] = { 'run-targets': ['workstation-worktree', 'local-worktree'], workstations: [{ id: 'ada-dev', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'cfg' }] }; });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => {
    sp.features = [{ key: 'ABC-3', 'manual-priority': 1, 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'example-development' }, 'state-changes': [] }] }];
  });
  writeFileSync(at('projects', 'p', 'seat-budget.json'), JSON.stringify({ seats: 3 }));
  const live = entry => writeFileSync(at('projects', 'p', 'workstations.json'), JSON.stringify({ 'ada-dev': entry }));
  const where = () => {
    const s = existsSync(at('projects', 'p', 'seats.json')) ? JSON.parse(readFileSync(at('projects', 'p', 'seats.json'), 'utf8')) : {};
    return [...(s.seats ?? []).map(x => `${x.key} ${x.workstation} ${x.target}`), ...(s.local ?? []).map(x => `${x.key} mac ${x.target}`)];
  };
  for (const entry of [NO_BWRAP, UP]) {
    live(entry);
    await assignSeats(c.ctx, c.ctx.load());
    assert.deepEqual(where(), ['ABC-3 ada-dev workstation-worktree'], c.lines.join('\n'));
  }
  live(WITH_BWRAP);
  await assignSeats(c.ctx, c.ctx.load());
  assert.deepEqual(where(), ['ABC-3 ada-dev workstation-worktree']);
  assert.ok(!c.lines.some(l => /taken out of its|sandbox can't run/.test(l)), c.lines.join('\n'));
});

test('ASS-564 AC1, AC3: on the Mac without Seatbelt a local-worktree agent starts unsandboxed — no sandbox settings, its file tools still held — logged, and its session records sandboxed: false with the reason', async () => {
  const f = controlFixture();
  const wt = join(f.dir, 'wt');
  mkdirSync(wt);
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['dev-environments'] = { 'run-targets': ['local-worktree'] }; });
  // Its worktree made already (handed over to local-worktree before): ASS-567 dispatches it only once placed there.
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp => { Object.assign(sp.features[0].variations[0], { build: { 'worktree-folder': wt }, 'run-target': { target: 'local-worktree', at: '2026-11-23T00:00:00Z' } }); });
  f.ctx.macSandboxProblem = () => 'Seatbelt\'s /usr/bin/sandbox-exec is missing';
  try {
    // ASS-567: the ticket reaches plan in the first tick's steps phase, after its seats were placed: its agent goes in
    // the next tick (run-target-places.js heldElsewhere).
    await tick(f.ctx);
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    assert.ok(record, f.lines.join('\n'));
    const live = f.ctx.agents.get(record['agent-name']);
    const args = () => readFileSync(join(live.agent.dir, 'session.txt'), 'utf8').split('\n').find(l => l.startsWith('args ')) ?? '';
    assert.ok(await until(() => args()));
    const settings = JSON.parse(args().slice(args().indexOf('--settings ') + '--settings '.length));
    assert.deepEqual(settings, unsandboxedSettings(), 'started, not refused: no sandbox settings, blockWritesOutsideWorkingDirectories kept');
    assert.deepEqual(JSON.parse(readFileSync(join(live.agent.dir, 'sandbox.json'), 'utf8')), { sandboxed: false, why: 'Seatbelt\'s /usr/bin/sandbox-exec is missing', target: 'local-worktree', machine: 'mac' });
    assert.deepEqual(f.lines.filter(l => /running unsandboxed/.test(l)), [`dispatch worktree ${record['work-item']} A on mac: Claude Code's sandbox unavailable (Seatbelt's /usr/bin/sandbox-exec is missing) — running unsandboxed`]);
    assert.ok(f.lines.some(l => l.includes("unsandboxed (local-worktree: Claude Code's sandbox unavailable: Seatbelt's /usr/bin/sandbox-exec is missing)")), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-564 AC3: an unsandboxed run is logged once per machine while its reason stays; another machine, another reason, or a loss after a sandboxed run, logged again', () => {
  const lines = [], ctx = { memory: {}, log: (phase, text) => lines.push(`${phase} ${text}`) };
  const off = (machine, why) => ({ machine, unsandboxed: why });
  noteUnsandboxed(ctx, 'T-1', 'A', off('ws-1', 'socat not installed'));
  noteUnsandboxed(ctx, 'T-1', 'A', off('ws-1', 'socat not installed'));
  assert.deepEqual(lines, ['dispatch worktree T-1 A on ws-1: Claude Code\'s sandbox unavailable (socat not installed) — running unsandboxed']);
  noteUnsandboxed(ctx, 'T-1', 'A', off('vm-1', 'not checked yet'));
  noteUnsandboxed(ctx, 'T-1', 'A', off('ws-1', 'bwrap refused'));
  assert.equal(lines.length, 3);
  noteUnsandboxed(ctx, 'T-1', 'A', { machine: 'ws-1', unsandboxed: null });
  noteUnsandboxed(ctx, 'T-1', 'A', off('ws-1', 'bwrap refused'));
  assert.equal(lines.length, 4, 'lost again after a sandboxed run');
  noteUnsandboxed(ctx, 'T-1', 'A', null);
  assert.equal(lines.length, 4);
});
