// ASS-554: worktree steps — a step flagged `worktree: true` in its workflow.yaml runs on a worktree target the project
// lists (local-worktree, workstation-worktree, cloud-vm-worktree), by pool. AC1: the flag is validated (a value not
// true or false, a flagged step that uses no machine, a flagged step whose own run-targets name another kind of
// target, a project listing no worktree target for a flagged step: each named by engine and step). AC2: the planner
// sends a flagged step to a worktree (remote machines first, by headroom; the Mac's last) and an unflagged one to the
// project's sandboxes, never spilling onto a worktree; a ticket going plan (worktree) → build (sandbox) → review
// (worktree) has its branch handed over at every switch (readyTarget → code:hand-over; the hand-over itself, with real
// git and a fake sandbox, is test/agent-cli/worktree-steps.test.js). AC3: the shipped engines' planning, review, risk
// and documentation steps carry the flag, and only steps that need no build, test or running app do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDispatch } from '../../src/control/plan.js';
import { readyTarget } from '../../src/control/run-target-places.js';
import { projectRunTargets, candidates, stepRunTargetErrors, projectRunTargetProblems, projectRunTargetErrors, poolChoiceOf, worktreeStep, isWorktreeTarget } from '../../src/control/run-targets.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { readEngine, engineNamesIn, engineFileIn } from '../../src/workflow/engine-file.js';
import { usesMachine } from '../../src/control/machine-steps.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ws = { id: 'ws-1', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' };
const cvm = { id: 'vm-1', 'gcp-project': 'g', zone: 'z' };
const prompt = (id, extra = {}) => ({ id, sequence: 2, name: id, 'run-location': 'vm', action: { type: 'prompt', prompt: 'p' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }], ...extra });
const engineOf = (...steps) => ({ steps: [{ id: 'committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } }, ...steps, { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } }] });
const at = (state, extra = {}) => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, ...extra });
const ticket = (key, ...variations) => ({ key, variations });
const json = d => ({ name: 'p', 'dev-environments': d });
// The three kinds of step a ticket goes through: Plan's (flagged), Build's (not), Review's (flagged).
const plan = prompt('write-execution-plan', { worktree: true, 'is-planning-stage': true });
const build = prompt('generate-solution');
const review = prompt('code-review', { worktree: true });
const flow = engineOf(plan, build, review);
// The Mac projects' new run targets, and the client project's (its machines remote: worktrees there, sandboxes there).
const MAC = json({ 'run-targets': ['local-substrate', 'local-worktree'], substrate: { clusters: [{ machine: 'mac' }] } });
const REMOTE = json({ 'run-targets': ['cloud-vm-substrate', 'workstation-substrate', 'workstation-worktree', 'cloud-vm-worktree'], workstations: [ws], 'cloud-vms': [cvm], substrate: { clusters: [{ machine: 'ws-1' }, { machine: 'vm-1' }] } });

test('ASS-554 AC1: the worktree flag is true or false, only on a machine-using step, and a flagged step\'s own run-targets name worktree targets only — each error naming the engine\'s file and the step', () => {
  const errorsOf = step => validateStateEngine(engineOf(step), ROOT, 'e').filter(e => /worktree/.test(e));
  assert.deepEqual(errorsOf(prompt('review', { worktree: true })), []);
  assert.deepEqual(errorsOf(prompt('review', { worktree: false })), []);
  assert.deepEqual(errorsOf(prompt('review', { worktree: true, 'run-targets': ['workstation-worktree', 'local-worktree'] })), []);
  assert.deepEqual(errorsOf(prompt('review', { worktree: true, 'is-active': false })), [], 'a switched-off AI step may keep its flag');
  assert.deepEqual(errorsOf(prompt('review', { worktree: 'yes' })), ['engines/e/workflow.yaml: step "review" worktree "yes" is not true or false']);
  assert.deepEqual(errorsOf({ id: 'gate', sequence: 2, name: 'Gate', action: { type: 'human' }, worktree: true, 'exit-events': [{ condition: { 'human-review': 'Approve' }, 'move-to-state': 'done' }] }),
    ['engines/e/workflow.yaml: step "gate" worktree is set on a step that uses no machine (gates, human steps, waits and harness bookkeeping run with control on the Mac)']);
  assert.deepEqual(errorsOf(prompt('review', { worktree: true, 'run-targets': ['local-worktree', 'local-substrate', 'local-vm'] })), [
    'engines/e/workflow.yaml: step "review" run-targets lists local-substrate, but the step runs in a worktree (worktree: true): its run-targets may name only local-worktree, workstation-worktree, cloud-vm-worktree',
    'engines/e/workflow.yaml: step "review" run-targets lists local-vm, but the step runs in a worktree (worktree: true): its run-targets may name only local-worktree, workstation-worktree, cloud-vm-worktree',
  ]);
  assert.equal(worktreeStep(review), true);
  assert.equal(worktreeStep(build), false);
});

test('ASS-554 AC1: a project that lists no worktree target for a flagged step it can reach is a problem naming the engine and the step (control logs it, engine:validate fails); one listing one, or still on its mode, is not', () => {
  const engines = { top: engineOf(prompt('review', { action: { type: 'state-engine', engine: 'sub' } })), sub: flow };
  const sandboxesOnly = json({ 'run-targets': ['local-substrate'], substrate: { clusters: [{ machine: 'mac' }] } });
  const problems = projectRunTargetProblems(sandboxesOnly, engines, 'top');
  assert.deepEqual(problems.map(p => [p.engine, p.step]), [['sub', 'write-execution-plan'], ['sub', 'code-review']]);
  assert.equal(problems[0].why, 'it runs in a worktree (worktree: true), and the project\'s run targets (local-substrate) include no worktree target (local-worktree, workstation-worktree, cloud-vm-worktree)');
  assert.match(projectRunTargetErrors(sandboxesOnly, engines, 'top')[1], /^engine sub step "code-review" can run on none of the project's run targets: it runs in a worktree/);
  assert.deepEqual(projectRunTargetProblems(MAC, engines, 'top'), []);
  assert.deepEqual(projectRunTargetProblems(REMOTE, engines, 'top'), []);
  // A project whose run targets are still derived from its mode runs every step as before, flag or not.
  assert.deepEqual(projectRunTargetProblems(json({ mode: 'vm' }), engines, 'top'), []);
  assert.deepEqual(candidates(plan, projectRunTargets(json({ mode: 'vm' }))), ['local-vm']);
  // A flagged step whose own list names a worktree target the project lacks: the lists share none.
  const own = { top: engineOf(prompt('review', { worktree: true, 'run-targets': ['workstation-worktree'] })) };
  assert.match(projectRunTargetProblems(MAC, own, 'top')[0].why, /its run-targets \(workstation-worktree\) and the project's \(local-substrate, local-worktree\) share none/);
});

test('ASS-554 AC2: a flagged step takes the project\'s worktree targets alone, by pool (remote-first: the remote machine with the most headroom, the Mac last); an unflagged one its sandboxes and never spills onto a worktree', () => {
  const mac = projectRunTargets(MAC), remote = projectRunTargets(REMOTE);
  assert.deepEqual(candidates(plan, mac), ['local-worktree']);
  assert.deepEqual(candidates(review, mac), ['local-worktree']);
  assert.deepEqual(candidates(build, mac), ['local-substrate'], 'worktrees are for worktree steps while a sandbox is left');
  assert.deepEqual(candidates(plan, remote), ['workstation-worktree', 'cloud-vm-worktree']);
  assert.deepEqual(candidates(build, remote), ['cloud-vm-substrate', 'workstation-substrate']);
  assert.equal(poolChoiceOf(plan, remote, candidates(plan, remote)), 'remote-first');
  // Nothing left but worktrees (a project on worktrees alone): an unflagged step takes them, as ASS-553 allowed.
  assert.deepEqual(candidates(build, projectRunTargets(json({ 'run-targets': ['local-worktree'] }))), ['local-worktree']);
  // Whether any step could take a seat (no step) still sees every target.
  assert.deepEqual(candidates(undefined, mac), ['local-substrate', 'local-worktree']);

  // The Mac projects: two tickets at Plan, two at Build, one at Review, one sandbox seat. Plan and Review go to the
  // worktree (no seat); Build's first takes the sandbox and its second waits for one — never the worktree.
  const ranked = [ticket('T-1', at('generate-solution')), ticket('T-2', at('write-execution-plan')), ticket('T-3', at('generate-solution')), ticket('T-4', at('code-review')), ticket('T-5', at('write-execution-plan'))];
  const p = planDispatch({ ranked, engine: flow, harness: {}, seats: { mac: 1, remote: 0, byKind: { workstation: 0, 'cloud-vm': 0 } }, runTargets: mac });
  assert.deepEqual(p.targets.map(t => [t.key, t.target]), [['T-1', 'local-substrate'], ['T-2', 'local-worktree'], ['T-4', 'local-worktree'], ['T-5', 'local-worktree']]);
  assert.ok(p.waiting.some(w => w.key === 'T-3'), JSON.stringify(p.waiting));
  assert.ok(!p.targets.some(t => t.key === 'T-3'));

  // The client project's shape plus the Mac's worktree: Plan to the remote machine with the most room, then the
  // other, and the Mac's only once both are full.
  const withMac = projectRunTargets(json({ ...REMOTE['dev-environments'], 'run-targets': [...REMOTE['dev-environments']['run-targets'], 'local-worktree'] }));
  const rooms = { 'workstation-worktree': 0.6, 'cloud-vm-worktree': 1.8, 'local-worktree': 9 };
  const machine = { 'workstation-worktree': 'ws-1', 'cloud-vm-worktree': 'vm-1' };
  const headroom = (t, placed) => ({ room: (rooms[t] ?? 0) - (placed.get(machine[t] ?? 'mac') ?? 0), ...(machine[t] ? { machine: machine[t] } : {}) });
  const planning = ['P-1', 'P-2', 'P-3'].map(k => ticket(k, at('write-execution-plan')));
  const q = planDispatch({ ranked: planning, engine: flow, harness: {}, seats: { mac: Infinity, remote: 2, byKind: { workstation: 1, 'cloud-vm': 1 } }, runTargets: withMac, headroom });
  assert.deepEqual(q.targets.map(t => [t.key, t.target, t.machine ?? null, t.choice]), [
    ['P-1', 'cloud-vm-worktree', 'vm-1', 'remote-first'], ['P-2', 'workstation-worktree', 'ws-1', 'remote-first'], ['P-3', 'local-worktree', null, 'remote-first']]);
});

test('ASS-554 AC2: a ticket going plan (worktree) → build (sandbox) → review (worktree) has its branch handed over at every switch, and not again while it stays', async () => {
  const calls = [], lines = [];
  const ctx = { cli: async args => { calls.push(args.join(' ')); return `${JSON.stringify({ branch: 'change/ABC-3.A-1' })}\n`; }, now: () => new Date('2026-11-23T12:00:00Z'), log: (phase, text) => lines.push(`${phase} ${text}`) };
  const folder = mkdtempSync(join(tmpdir(), 'wt-'));
  const variation = at('write-execution-plan', { build: { 'worktree-folder': folder } });
  const t = ticket('ABC-3', variation);
  const project = { id: 'p', tickets: [t], seats: [], localSeats: [] };
  const onWorktree = () => { project.seats = []; project.localSeats = [{ key: 'ABC-3', variation: 'A', target: 'local-worktree' }]; };
  const onSandbox = () => { project.localSeats = []; project.seats = [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }]; };
  onWorktree();
  assert.equal(await readyTarget(ctx, project, t, variation), 'local-worktree');   // Plan
  assert.equal(await readyTarget(ctx, project, t, variation), 'local-worktree');   // Plan's next step: no move
  onSandbox();
  assert.equal(await readyTarget(ctx, project, t, variation), 'local-substrate');  // Build
  onWorktree();
  assert.equal(await readyTarget(ctx, project, t, variation), 'local-worktree');   // Review
  assert.deepEqual(calls, ['code:hand-over p ABC-3 A local-worktree', 'code:hand-over p ABC-3 A local-substrate', 'code:hand-over p ABC-3 A local-worktree']);
  assert.match(lines.join('\n'), /handed over from local-substrate to local-worktree \(change\/ABC-3\.A-1\)/);
  // On the client project's remote machines: a remote worktree ↔ a sandbox there is handed over too (the sandbox's
  // branches move through the Mac); worktree ↔ plain machine needs none (their steps push and claim).
  const remote = at('write-execution-plan', { 'run-target': { target: 'workstation-worktree' } });
  const r = ticket('ABC-4', remote);
  const rp = { id: 'p', tickets: [r], seats: [{ key: 'ABC-4', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-substrate' }] };
  calls.length = 0;
  assert.equal(await readyTarget(ctx, rp, r, remote), 'workstation-substrate');
  rp.seats = [{ key: 'ABC-4', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation-worktree' }];
  assert.equal(await readyTarget(ctx, rp, r, remote), 'workstation-worktree');
  assert.deepEqual(calls, ['code:hand-over p ABC-4 A workstation-substrate', 'code:hand-over p ABC-4 A workstation-worktree']);
});

// The steps flagged in the shipped engines (AC3; the change notes list them): Plan's, the code and security reviews,
// Review's explanation, risk and token checks, Document's, the steps to test, Requirements Changed's.
const FLAGGED = {
  'grouped-plan': ['enrich-ac', 'root-cause-analysis', 'review-root-cause-analysis', 'write-execution-plan', 'write-execution-plan-stronger', 'write-test-plan', 'enrich-automated-test-data', 'review-plan', 'choose-work-mode'],
  'v2-plan': ['enrich-ac', 'root-cause-analysis', 'review-root-cause-analysis', 'write-execution-plan', 'write-test-plan', 'enrich-automated-test-data', 'review-plan', 'choose-work-mode'],
  'grouped-build': ['code-review', 'security-review'],
  'v2-build': ['code-review', 'security-review'],
  'grouped-merge': ['code-review', 'security-review'],
  'grouped-review': ['explain-the-change', 'risk-assessment', 'token-expense-check'],
  'v2-review': ['explain-the-change', 'risk-assessment', 'token-expense-check'],
  'grouped-document': ['update-documentation', 'update-merge-request-details', 'add-screenshots-to-merge-request'],
  'v2-document': ['update-documentation', 'update-merge-request-details', 'add-screenshots-to-merge-request'],
  'grouped-steps-to-test': ['write-steps-to-test'],
  'v2-steps-to-test': ['write-steps-to-test'],
  'steps-to-test': ['write-steps-to-test'],
  'grouped-requirements-changed': ['revise-acceptance-criteria', 'judge'],
  'harness-development': ['enrich-ac', 'root-cause-analysis', 'review-root-cause-analysis', 'write-execution-plan', 'write-test-plan', 'enrich-automated-test-data', 'review-plan', 'code-review', 'security-review', 'update-documentation', 'update-merge-request-details', 'add-screenshots-to-merge-request', 'risk-assessment', 'token-expense-check'],
};
// Steps that build, test, run the app or fix code: never flagged.
const NEVER = new Set(['generate-solution', 'generate-automated-tests', 'address-merge-request-feedback', 'test', 'take-screenshots', 'troubleshoot', 'repair-project', 'repair-environment', 'apply-fix']);

test('ASS-554 AC3: the shipped engines flag their planning, review, risk and documentation steps — exactly those — and never a step that builds, tests or runs the app', () => {
  const dir = join(ROOT, 'engines');
  for (const name of engineNamesIn(dir)) {
    const e = readEngine(engineFileIn(dir, name));
    const steps = Object.entries(e).filter(([k, v]) => /(^|-)(steps|trigger)$/.test(k) && Array.isArray(v)).flatMap(([, v]) => v);
    const flagged = steps.filter(worktreeStep).map(s => s.id);
    assert.deepEqual(flagged, FLAGGED[name] ?? [], name);
    for (const s of steps.filter(worktreeStep)) {
      assert.ok(usesMachine({ ...s, 'is-active': true }), `${name}/${s.id} uses a machine`);
      assert.ok(!NEVER.has(s.id), `${name}/${s.id}`);
      assert.ok(!s['run-targets'] || [].concat(s['run-targets']).every(isWorktreeTarget), `${name}/${s.id}`);
    }
  }
});
