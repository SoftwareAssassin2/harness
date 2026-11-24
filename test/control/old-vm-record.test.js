// ASS-581: control made Lima VMs for a project whose run targets leave out local-vm. Seen live at a project's first
// start after its Lima VMs were deleted: variations last worked before run targets (ASS-540) carried no run-target but
// still their old `vm` record; their current steps had no seat yet (the remote machines not yet connected, or an open
// blocking question keeping the ticket out of the planner), and the VM lifecycle read the old record, `vm: running` at
// their step, and re-created the VM (vm:create) and started it (vm:start) — Blocked's runs too, even with a sandbox
// run-target recorded. AC1: whole ticks (real tick(), the state loaded deep-frozen as loadState leaves it) over a
// project on local-substrate and local-worktree, a variation with an old `vm` record, no run-target and no seat: no
// vm:create or vm:start, the step waiting for a seat on the project's targets, said once; the same at Blocked's
// troubleshooting, and for a VM still running (stopped). AC2: once a seat on a substrate or worktree target is
// placed, the variation is handed over there and its step runs there (no Lima VM made). AC3 is
// test/control/hand-over-vm.test.js, unchanged; AC4 test/agent-cli/vm-create.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tick } from '../../src/control/tick.js';
import { planFor } from '../../src/control/plan.js';
import { awaitsVm } from '../../src/control/vm-lifecycle.js';
import { listsLocalVm, projectRunTargets } from '../../src/control/run-targets.js';
import { controlFixture } from './control-fixture.js';
import { fakeVm } from '../support/fake-vm.js';
import { until } from '../support/until.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const prompt = (id, sequence, to, extra = {}) => ({ id, sequence, 'run-location': 'vm', vm: 'running', action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': to }], ...extra });
const done = sequence => ({ id: 'done', sequence, 'is-done': true, action: { type: 'none' } });
const OLD_VM = { name: 'abc-3-a', 'created-at': '2026-10-01T00:00:00Z', ip: '192.168.64.9' };

// setup(f, { variation, vm, targets, seats }) — the fixture's project p on `targets` (a Mac cluster declared), its
// engine a build step that runs in the machine (`vm: running`) then done; ABC-3 A as `variation` gives it, with the old
// `vm` record; its Lima VM `vm` ('Running', 'Stopped', or null: deleted); `seats` on the Mac. Every agent.sh call
// recorded; code:hand-over and substrate:sandbox-up answered as they behave, the rest the real agent.sh.
function setup(f, { variation = {}, vm = null, targets = ['local-substrate', 'local-worktree'], seats = 0 } = {}) {
  const dir = join(f.dir, 'projects', 'p'), sprintFile = join(dir, 'sprints', 'sprint-10', 'sprint.json');
  f.seats(seats);
  edit(join(f.dir, 'engines', 'example-development', 'workflow.yaml'), e => { e.steps = [e.steps.find(s => s.id === 'blocked'), prompt('build', 2, 'done'), done(3)]; });
  edit(join(dir, 'project.json'), p => { p['dev-environments'] = { 'run-targets': targets, substrate: { clusters: [{ machine: 'mac' }] } }; });
  const onDisk = change => edit(sprintFile, s => change(s.features[0].variations[0]));
  onDisk(v => { v['harness-status'] = { state: 'build', 'state-engine': 'example-development' }; v.vm = OLD_VM; delete v['run-target']; Object.assign(v, variation); });
  const lima = fakeVm(f.env);
  if (vm) lima.instance('abc-3-a', vm);
  f.ctx.env = { ...f.ctx.env, ...lima.env };
  const real = f.ctx.cli, calls = [];
  f.ctx.cli = async (args, env) => {
    calls.push(args.join(' '));
    const [command, , , , target] = args;
    if (/^vm:(create|start|stop|delete)$/.test(command)) return '{}\n';   // recorded only (the assertions are on the calls)
    if (command === 'code:hand-over') {
      const folder = join(f.dir, 'worktrees', 'ABC-3');
      onDisk(v => {
        v['run-target'] = { target, at: new Date().toISOString() };
        if (target === 'local-worktree') { mkdirSync(folder, { recursive: true }); v.build = { ...v.build, 'worktree-folder': folder, 'worktree-by': 'run-target' }; }
      });
      return `${JSON.stringify({ branch: 'change/ABC-3.A-1', folder: target === 'local-worktree' ? folder : null })}\n`;
    }
    if (command === 'substrate:sandbox-up') {
      onDisk(v => { v.sandbox = { name: 'abc-3-a', project: 'p', machine: 'mac', template: 't', image: 'sha256:d', state: 'running' }; });
      return `${JSON.stringify({ name: 'abc-3-a', machine: 'substrate:p:mac:abc-3-a', host: 'mac', created: true, resumed: false, template: 't', branches: [] })}\n`;
    }
    if (command === 'substrate:stack-up') return '{"stack":false}\n';
    if (command.startsWith('substrate:')) return '{}\n';
    return real(args, env);
  };
  f.ctx.succeeds = () => Promise.resolve(true);
  let clock = Date.now();
  f.ctx.now = () => new Date(clock);
  return {
    calls, onDisk, lima,
    // ticks(n) — n whole ticks, a minute apart, the VM jobs beside them and any fake agent's turn awaited.
    ticks: async n => {
      for (let i = 0; i < n; i++) {
        clock += 60_000;
        await tick(f.ctx);
        await Promise.all([...(f.ctx.memory.vms?.values() ?? [])].map(r => r.job));
        await until(() => [...f.ctx.agents.values()].every(a => a.result || a.exited));
      }
    },
  };
}
const vmCalls = calls => calls.filter(c => /^vm:(create|start) /.test(c));

test('listsLocalVm: a project\'s own list, or its mode\'s', () => {
  assert.equal(listsLocalVm({ runTargets: projectRunTargets({ 'dev-environments': { 'run-targets': ['local-substrate', 'local-worktree'] } }) }), false);
  assert.equal(listsLocalVm({ runTargets: projectRunTargets({ 'dev-environments': { 'run-targets': ['local-substrate', 'local-vm'] } }) }), true);
  assert.equal(listsLocalVm({ json: {} }), true, 'vm mode, the default');
  assert.equal(listsLocalVm({ json: { 'dev-environments': { mode: 'workstation' } } }), false);
  assert.equal(listsLocalVm({ json: { 'dev-environments': { mode: 'vm+workstation' } } }), true);
});

test('AC1: a project without local-vm, a variation with an old vm record, no run-target and no seat: no vm:create or vm:start; its step waits for a seat on the project\'s targets, said once', { timeout: 120_000 /* hang guard: the ticks themselves are awaited */ }, async () => {
  for (const vm of [null, 'Stopped']) {
    const f = controlFixture();
    try {
      const s = setup(f, { vm });
      await s.ticks(3);
      const log = f.lines.join('\n');
      assert.deepEqual(vmCalls(s.calls), [], `VM ${vm ?? 'deleted'}: no Lima VM made or started\n${s.calls.join('\n')}`);
      assert.ok(!s.calls.some(c => c.startsWith('code:hand-over') || c.startsWith('substrate:sandbox-up')), 'nothing placed: no seat');
      const state = f.ctx.load(), project = state.projects.find(p => p.id === 'p');
      assert.ok(Object.isFrozen(project.tickets[0].variations[0]), 'the loaded state is frozen');
      assert.ok(planFor(state, project).waiting.some(w => w.key === 'ABC-3' && w.variation === 'A'), 'it waits for a seat');
      assert.equal(awaitsVm(f.ctx, state, project, project.tickets[0].variations[0], 'ABC-3 A build'), false, 'no VM to wait for');
      assert.equal(log.split('\n').filter(l => l.includes("vm ABC-3 A: its old Lima VM record ignored — p doesn't run on local-vm")).length, 1, log);
      assert.doesNotMatch(log, /waits for its VM abc-3-a/);
      assert.equal(f.variation().vm.name, 'abc-3-a', 'the record itself is left as it is');
    } finally { f.ctx.stopAgents(); }
  }
});

test('AC1: the same with no seat for another reason (an open blocking question keeps it out of the planner), and a VM still running is stopped', { timeout: 120_000 /* hang guard */ }, async () => {
  const f = controlFixture();
  try {
    const s = setup(f, { vm: 'Running', seats: 4 });
    mkdirSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3'), { recursive: true });
    writeFileSync(join(f.dir, 'projects', 'p', 'work', 'ABC-3', 'questions-and-answers.json'), JSON.stringify([{ question: 'Which?', blocking: true, answer: null }]));
    await s.ticks(2);
    assert.deepEqual(vmCalls(s.calls), [], s.calls.join('\n'));
    assert.ok(s.calls.includes('vm:stop p abc-3-a'), `the old VM, running, is stopped\n${s.calls.join('\n')}`);
    assert.match(f.lines.join('\n'), /vm p abc-3-a: stopped \(ABC-3 A at build; p doesn't run on local-vm\)/);
  } finally { f.ctx.stopAgents(); }
});

test('AC1: Blocked\'s runs too — troubleshooting (a step that runs in the machine) with an old vm record, with no run-target or a sandbox one recorded: no Lima VM made or started', { timeout: 120_000 /* hang guard */ }, async () => {
  for (const runTarget of [null, { target: 'local-substrate', at: '2026-11-20T00:00:00Z' }]) {
    const f = controlFixture();
    try {
      const s = setup(f, { vm: null, seats: 4 });
      edit(join(f.dir, 'engines', 'example-development', 'workflow.yaml'), e => { e.steps = e.steps.map(st => (st.id === 'blocked' ? { ...st, 'run-location': 'vm', vm: 'running', action: { type: 'prompt', prompt: 'test', 'agent-count': 1 } } : st)); });
      s.onDisk(v => { v['harness-status'] = { state: 'blocked', 'state-engine': 'example-development' }; if (runTarget) v['run-target'] = runTarget; });
      await s.ticks(3);
      assert.deepEqual(vmCalls(s.calls), [], `${JSON.stringify(runTarget)}\n${s.calls.join('\n')}`);
      assert.doesNotMatch(f.lines.join('\n'), /in abc-3-a|into abc-3-a|waits for its VM abc-3-a/, 'nothing sent into the old VM');
    } finally { f.ctx.stopAgents(); }
  }
});

test('a paused project starts or re-creates no VM either (its own pause), project with local-vm or without', { timeout: 120_000 /* hang guard */ }, async () => {
  for (const targets of [['local-substrate', 'local-worktree'], ['local-vm']]) {
    const f = controlFixture();
    try {
      const s = setup(f, { vm: null, seats: 4, targets });
      edit(join(f.dir, 'assignments.json'), a => { a.pauses = { p: { human: { since: '2026-11-24T00:00:00Z' } } }; });
      await s.ticks(2);
      assert.deepEqual(vmCalls(s.calls), [], `${targets}\n${s.calls.join('\n')}`);
    } finally { f.ctx.stopAgents(); }
  }
});

test('AC2: the same variation, once a seat on a substrate or worktree target is placed, is handed over and runs there; no Lima VM made or started', { timeout: 120_000 /* hang guard */ }, async () => {
  for (const targets of [['local-substrate', 'local-worktree'], ['local-worktree']]) {
    const f = controlFixture();
    try {
      const s = setup(f, { vm: null, seats: 0, targets });
      await s.ticks(2);
      assert.deepEqual(vmCalls(s.calls), []);
      f.seats(4);
      await s.ticks(4);
      const log = f.lines.join('\n');
      assert.deepEqual(vmCalls(s.calls), [], `${targets}\n${s.calls.join('\n')}`);
      assert.ok(s.calls.includes(`code:hand-over p ABC-3 A ${targets[0]}`), `handed over to ${targets[0]}\n${s.calls.join('\n')}`);
      assert.match(log, new RegExp(`dispatch \\S+ \\([^)]*\\) on ABC-3 A build, pid \\d+`), log);
      assert.doesNotMatch(log, /in abc-3-a\b/);
    } finally { f.ctx.stopAgents(); }
  }
});
