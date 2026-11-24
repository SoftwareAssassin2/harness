// ASS-551: Setup's Create VM and Blocked's Add the Missing Repository run on substrate targets too (a project whose run
// targets are substrate ones alone had no target for them, so every new ticket waited at Create VM for ever), control
// brings the sandbox up before such a host-run in-machine script, and the project check engine:validate now makes too
// (run-targets.js projectRunTargetProblems). The bash side (vm:create making the sandbox, the marker, the clone through
// the Mac) is test/agent-cli/substrate-setup.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectRunTargets, candidates, projectRunTargetProblems, projectRunTargetErrors, reachableSteps } from '../../src/control/run-targets.js';
import { DOCKER_COMMANDS, usesMachine } from '../../src/control/machine-steps.js';
import { readEngine, engineNamesIn, engineFileIn } from '../../src/workflow/engine-file.js';
import { sandboxWaits } from '../../src/control/sandboxes.js';
import { sandboxActor } from '../../src/control/machine-substrate.js';

const ROOT = join(import.meta.dirname, '..', '..');
const dir = join(ROOT, 'engines');
const ENGINES = Object.fromEntries(engineNamesIn(dir).map(name => [name, readEngine(engineFileIn(dir, name))]));
const ws = { id: 'ws-1', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' };
const cvm = { id: 'vm-1', 'gcp-project': 'g', zone: 'z' };
const onlySubstrate = { name: 'p', 'dev-environments': { 'run-targets': ['local-substrate'], substrate: { clusters: [{ machine: 'mac' }] } } };
const remoteSubstrate = { name: 'p', 'dev-environments': { 'run-targets': ['cloud-vm-substrate', 'workstation-substrate'], workstations: [ws], 'cloud-vms': [cvm], substrate: { clusters: [{ machine: 'ws-1' }, { machine: 'vm-1' }] } } };
const step = (engine, id) => ENGINES[engine].steps.find(s => s.id === id);
// ci-checks: ASS-552 takes Build's CI Checks out of the workflow; until then it is the one step left on full machines.
const notCi = problems => problems.filter(p => p.step !== 'ci-checks');

test('ASS-551 AC1, AC4: Setup\'s steps and Add the Missing Repository take every machine target, the substrate ones first — so a project on substrate targets alone has a target for each', () => {
  // ASS-553: and the remote worktrees after them (a full machine).
  const six = ['local-substrate', 'workstation-substrate', 'cloud-vm-substrate', 'local-vm', 'workstation', 'cloud-vm', 'workstation-worktree', 'cloud-vm-worktree'];
  for (const [engine, id] of [['grouped-setup', 'create-vm'], ['v2-setup', 'create-vm'], ['grouped-setup', 'mark-setup-complete'], ['v2-setup', 'mark-setup-complete'], ['grouped-setup', 'check-setup-complete'], ['grouped-blocked', 'add-repository']]) {
    assert.deepEqual(step(engine, id)['run-targets'], six, `${engine}/${id}`);
  }
  assert.ok(!DOCKER_COMMANDS.has('vm:create') && !DOCKER_COMMANDS.has('project:add-repository'), 'they make or use a sandbox on a substrate target, no Docker');
  for (const json of [onlySubstrate, remoteSubstrate]) {
    const rt = projectRunTargets(json);
    for (const [engine, id] of [['grouped-setup', 'create-vm'], ['v2-setup', 'create-vm'], ['grouped-blocked', 'add-repository']]) {
      assert.deepEqual(candidates(step(engine, id), rt).toSorted(), rt.targets.toSorted(), `${engine}/${id}`);   // in the step's order
    }
  }
  // A plain project keeps its VM for them, as before.
  assert.deepEqual(candidates(step('v2-setup', 'create-vm'), projectRunTargets({})), ['local-vm']);
});

test('ASS-551 AC1, AC3: with the shipped execution engines, no machine step a ticket can reach is stranded on a project whose run targets are substrate ones alone (Build\'s CI Checks aside, ASS-552\'s)', () => {
  const tops = Object.keys(ENGINES).filter(name => reachableSteps(ENGINES, name).some(s => s.step.action?.type === 'state-engine' && /setup$/.test(s.step.action.engine ?? '')));
  assert.ok(tops.length >= 2, tops.join());
  // ASS-554: with the worktree targets their worktree steps (worktree: true) need — on sandboxes alone, those steps are
  // stranded by design (test/control/worktree-steps.test.js), and nothing else is.
  const plus = (json, extra) => ({ ...json, 'dev-environments': { ...json['dev-environments'], 'run-targets': [...json['dev-environments']['run-targets'], ...extra] } });
  for (const top of tops) for (const json of [plus(onlySubstrate, ['local-worktree']), plus(remoteSubstrate, ['workstation-worktree', 'cloud-vm-worktree'])]) {
    assert.deepEqual(notCi(projectRunTargetProblems(json, ENGINES, top)), [], `${top} on ${json['dev-environments']['run-targets']}`);
  }
  for (const top of tops) for (const json of [onlySubstrate, remoteSubstrate]) {
    assert.deepEqual(notCi(projectRunTargetProblems(json, ENGINES, top)).filter(p => !/runs in a worktree/.test(p.why)), [], `${top} on ${json['dev-environments']['run-targets']}`);
  }
});

test('ASS-551 AC3: projectRunTargetProblems names the engine, the step and why; control\'s log lines are made from it', () => {
  const engines = {
    top: { steps: [{ id: 'setup', sequence: 1, name: 'Setup', action: { type: 'state-engine', engine: 'sub' } }, { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } }] },
    sub: { steps: [{ id: 'make', sequence: 1, name: 'Make', 'run-targets': ['local-vm'], action: { type: 'script', command: './agent.sh vm:create {project} {ticket} {variation}' }, 'exit-events': [] }] },
  };
  const problems = projectRunTargetProblems(onlySubstrate, engines, 'top');
  assert.deepEqual(problems, [{ engine: 'sub', step: 'make', why: 'its run-targets (local-vm) and the project\'s (local-substrate) share none' }]);
  assert.deepEqual(projectRunTargetErrors(onlySubstrate, engines, 'top'), ['engine sub step "make" can run on none of the project\'s run targets: its run-targets (local-vm) and the project\'s (local-substrate) share none; it is never started']);
});

test('ASS-551 AC1: on a substrate target control brings the sandbox up before Setup\'s host-run steps that work in the machine (Create VM, Mark Setup Complete) and Add the Missing Repository — not before a host step', async () => {
  const calls = [], records = new Map();
  const ctx = {
    memory: { warned: new Set(), backoff: new Map() },
    now: () => new Date('2026-11-23T10:00:00Z'), log: () => {},
    cli: async args => {
      calls.push(args.join(' '));
      if (args[0] === 'substrate:sandbox-up') {
        const [, project, key, variation, machine] = args;
        records.set(`${key} ${variation}`, { name: sandboxActor(key, variation), project, machine, state: 'running' });
        return `${JSON.stringify({ name: sandboxActor(key, variation), machine: `substrate:${project}:${machine}:${sandboxActor(key, variation)}`, created: true, template: 't', branches: [] })}\n`;
      }
      if (args[0] === 'substrate:stack-up') return '{"stack":false}\n';
      return '';
    },
  };
  for (const [engine, id] of [['v2-setup', 'create-vm'], ['v2-setup', 'mark-setup-complete'], ['grouped-blocked', 'add-repository']]) {
    calls.length = 0; ctx.memory.sandboxes = new Map();
    const variation = { name: 'A', 'harness-status': { state: 'setup' } };
    const t = { key: 'ABC-3', variations: [variation] };
    const project = { id: 'p', seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }], tickets: [t] };
    const s = step(engine, id);
    assert.ok(usesMachine(s) && !s['run-location'], `${engine}/${id}: a host-run in-machine script`);
    assert.equal(sandboxWaits(ctx, {}, project, t, variation, s, `ABC-3 A ${id}`), true, `${engine}/${id} waits for its sandbox`);
    for (const r of ctx.memory.sandboxes.values()) if (r.job) await r.job;
    assert.deepEqual(calls, ['substrate:sandbox-up p ABC-3 A mac', 'substrate:stack-up p ABC-3 A --after created 0']);
    variation.sandbox = records.get('ABC-3 A');
    assert.equal(sandboxWaits(ctx, {}, project, t, variation, s, `ABC-3 A ${id}`), false, `${engine}/${id} goes on once it is up`);
  }
  // A host step (a wait on a fix) holds no machine: nothing brought up.
  calls.length = 0;
  const host = step('grouped-blocked', ENGINES['grouped-blocked'].steps.find(x => x.action?.command?.includes('ticket:fix-landed'))?.id);
  const variation = { name: 'A' }, t = { key: 'ABC-4', variations: [variation] };
  assert.equal(sandboxWaits(ctx, {}, { id: 'p', seats: [{ key: 'ABC-4', variation: 'A', kind: 'vm', target: 'local-substrate' }], tickets: [t] }, t, variation, host, 'w'), false);
  assert.deepEqual(calls, []);
});
