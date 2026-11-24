// ASS-540: run targets — steps and projects declare where a machine-using step may run (run-targets), validation, the
// resolution rule in the planner, the seatless Mac targets, Docker and machine-only commands, and the shipped engines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { planDispatch } from '../../src/control/plan.js';
import { placeSeats, targetOf, onMacTarget } from '../../src/control/seat-kinds.js';
import { RUN_TARGETS, projectRunTargets, candidates, projectTargetErrors, projectRunTargetErrors, stepRunTargetErrors, MODE_TARGETS } from '../../src/control/run-targets.js';
import { devEnvironments, devEnvironmentsErrors } from '../../src/control/dev-environments.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { scriptPlace, DOCKER_COMMANDS, MACHINE_ONLY } from '../../src/control/machine-steps.js';
import { readEngine, engineNamesIn, engineFileIn } from '../../src/workflow/engine-file.js';
import { runsOnMachine } from '../../src/control/run-target-places.js';

const ROOT = join(import.meta.dirname, '..', '..');
const prompt = (id, extra = {}) => ({ id, sequence: 1, name: id, action: { type: 'prompt', prompt: 'p' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }], ...extra });
const script = (id, command, extra = {}) => ({ id, sequence: 1, name: id, action: { type: 'script', command }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'done' }, { condition: { not: { 'exit-code': 0 } }, 'move-to-state': 'done' }], ...extra });
const errorsOf = (step, name = 'e') => validateStateEngine({ steps: [step, { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } }] }, ROOT, name).filter(e => /run-targets/.test(e));
const json = d => ({ name: 'p', 'dev-environments': d });
const ws = { id: 'ws-1', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' };
const cvm = { id: 'vm-1', 'gcp-project': 'g', zone: 'z' };

test('ASS-540 AC1: run-targets on a machine-using step is one target or a list of the eight; unknown, duplicate, or on a step that uses no machine fails, naming file, step and reason', () => {
  assert.equal(RUN_TARGETS.length, 10);   // ASS-553: workstation-worktree and cloud-vm-worktree
  assert.deepEqual(errorsOf(prompt('build', { 'run-targets': 'local-worktree' })), []);
  assert.deepEqual(errorsOf(prompt('build', { 'run-targets': RUN_TARGETS })), []);
  const unknown = errorsOf(prompt('build', { 'run-targets': ['local-vm', 'kubernetes'] }));
  assert.equal(unknown.length, 1);
  assert.match(unknown[0], /^engines\/e\/workflow\.yaml: step "build" run-targets has an unknown run target "kubernetes"/);
  assert.match(errorsOf(prompt('build', { 'run-targets': ['local-vm', 'local-vm'] }))[0], /step "build" run-targets lists "local-vm" twice/);
  assert.match(errorsOf(prompt('build', { 'run-targets': [] }))[0], /run-targets is empty/);
  // a gate, a wait, a host script: no machine, so no run-targets
  assert.match(errorsOf({ id: 'gate', sequence: 1, name: 'Gate', action: { type: 'human' }, 'run-targets': 'local-vm', 'exit-events': [{ condition: { 'human-review': 'Approve' }, 'move-to-state': 'done' }] })[0], /step "gate" run-targets is set on a step that uses no machine/);
  assert.match(errorsOf(script('wait', './agent.sh ticket:fix-landed {project} {ticket} {variation}', { 'run-targets': ['local-vm'] }))[0], /uses no machine/);
});

test('ASS-540 AC2: dev-environments.run-targets lists the project\'s targets in order; unset, derived from mode as before; wrong ones fail naming the field', () => {
  assert.deepEqual(projectRunTargets({}), { targets: ['local-vm'], derived: true, mode: 'vm', docker: new Set(), poolChoice: null });
  assert.deepEqual(projectRunTargets(json({ mode: 'workstation', workstations: [ws] })).targets, ['workstation', 'cloud-vm']);
  assert.deepEqual(projectRunTargets(json({ mode: 'vm+workstation', workstations: [ws] })).targets, ['workstation', 'cloud-vm', 'local-vm']);
  assert.deepEqual(MODE_TARGETS.vm, ['local-vm']);
  const own = projectRunTargets(json({ 'run-targets': ['local-worktree', 'local-vm'] }));
  assert.deepEqual([own.targets, own.derived, own.mode], [['local-worktree', 'local-vm'], false, 'vm']);
  // run-targets replaces mode: the mode read is the one it amounts to
  assert.equal(devEnvironments(json({ 'run-targets': ['cloud-vm', 'local-vm'], 'cloud-vms': [cvm] })).mode, 'vm+workstation');
  assert.equal(devEnvironments(json({ 'run-targets': ['workstation'], workstations: [ws] })).mode, 'workstation');
  // validation, naming the field
  assert.deepEqual(devEnvironmentsErrors(json({ 'run-targets': ['workstation', 'local-vm'], workstations: [ws] })), []);
  assert.deepEqual(projectTargetErrors(json({ 'run-targets': ['workstation'] })), ['dev-environments.run-targets lists workstation, but dev-environments.workstations lists no workstation']);
  assert.deepEqual(projectTargetErrors(json({ 'run-targets': ['cloud-vm'], workstations: [ws] })), ['dev-environments.run-targets lists cloud-vm, but dev-environments.cloud-vms lists no cloud VM']);
  assert.deepEqual(projectTargetErrors(json({ 'run-targets': ['local-substrate'] })), ['dev-environments.run-targets lists local-substrate, but dev-environments.substrate.clusters declares no Substrate cluster on the Mac (local)']);
  assert.match(projectTargetErrors(json({ 'run-targets': ['cloud-vm-substrate'], 'cloud-vms': [cvm] }))[0], /no Substrate cluster on a cloud VM/);
  assert.deepEqual(projectTargetErrors(json({ 'run-targets': ['local-substrate', 'cloud-vm-substrate'], 'cloud-vms': [cvm], substrate: { clusters: [{ machine: 'mac' }, { machine: 'vm-1' }] } })), []);
  // ASS-533: a GKE cluster gives no host until GKE is approved; a mac cluster is not a cloud VM's.
  assert.match(projectTargetErrors(json({ 'run-targets': ['cloud-vm-substrate'], 'cloud-vms': [cvm], substrate: { clusters: [{ machine: 'mac' }, { machine: 'gke', 'gcp-project': 'g', location: 'l', cluster: 'c' }] } }))[0], /no Substrate cluster on a cloud VM/);
  assert.match(devEnvironmentsErrors(json({ 'run-targets': ['nope'] }))[0], /^dev-environments\.run-targets: has an unknown run target "nope"/);
});

// A one-engine project: the planner's view of a step at `step`.
const engineWith = step => ({ steps: [{ id: 'committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } }, { ...step, sequence: 2 }, { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } }] });
const at = (state, extra = {}) => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' }, ...extra });
const ticket = (key, ...variations) => ({ key, variations });
const plan = (engine, ranked, extra) => planDispatch({ ranked, engine, harness: { 'max-agents': null }, ...extra });

test('ASS-540 AC3: a step runs on the first target, in the step\'s order, both lists allow and with a free seat; none free, it waits and takes the first that frees', () => {
  const engine = engineWith(prompt('build', { 'run-targets': ['cloud-vm', 'local-vm'] }));
  const rt = projectRunTargets(json({ 'run-targets': ['local-vm', 'workstation', 'cloud-vm'], workstations: [ws], 'cloud-vms': [cvm] }));
  assert.deepEqual(candidates(engine.steps[1], rt), ['cloud-vm', 'local-vm']);   // the step's order, not the project's
  const ranked = [ticket('T-1', at('build')), ticket('T-2', at('build')), ticket('T-3', at('build'))];
  const seats = { mac: 1, remote: 2, byKind: { workstation: 1, 'cloud-vm': 1 } };
  const p = plan(engine, ranked, { seats, runTargets: rt });
  assert.deepEqual(p.targets.map(t => [t.key, t.target]), [['T-1', 'cloud-vm'], ['T-2', 'local-vm']]);   // never the workstation: the step does not list it
  assert.deepEqual(p.waiting, [{ key: 'T-3', variation: 'A' }]);
  assert.deepEqual(p.dispatch.map(d => d.key), ['T-1', 'T-2']);
  // the cloud VM frees (T-1 done): T-3 takes it
  const later = plan(engine, [ticket('T-1', at('done')), ticket('T-2', at('build')), ticket('T-3', at('build'))], { seats, runTargets: rt, seated: (t, v) => (t.key === 'T-2' ? { key: 'T-2', variation: v.name, kind: 'vm', target: 'local-vm' } : false) });
  assert.deepEqual(later.targets.map(t => [t.key, t.target]), [['T-2', 'local-vm'], ['T-3', 'cloud-vm']]);
  // a step whose list shares nothing with the project's: refused (never started), listed by projectRunTargetErrors
  const none = engineWith(prompt('build', { 'run-targets': ['local-worktree'] }));
  const refused = plan(none, [ticket('T-1', at('build'))], { seats, runTargets: rt });
  assert.deepEqual([refused.dispatch, refused.refused, refused.waiting], [[], [{ key: 'T-1', variation: 'A', step: 'build' }], [{ key: 'T-1', variation: 'A' }]]);
  assert.deepEqual(projectRunTargetErrors(json({ 'run-targets': ['local-vm', 'workstation', 'cloud-vm'], workstations: [ws], 'cloud-vms': [cvm] }), { e: none }, 'e'),
    ['engine e step "build" can run on none of the project\'s run targets: its run-targets (local-worktree) and the project\'s (local-vm, workstation, cloud-vm) share none; it is never started']);
});

test('ASS-540 AC3: with run-targets unset everywhere, seats go as before — derived lists; planning on the local VM in a derived vm+workstation project', () => {
  const engine = engineWith(prompt('build'));
  const rt = projectRunTargets(json({ mode: 'vm+workstation', workstations: [ws] }));
  const p = plan(engine, [ticket('T-1', at('build')), ticket('T-2', at('build'))], { seats: { mac: 1, remote: 1 }, runTargets: rt });
  assert.deepEqual(p.targets.map(t => t.target), ['workstation', 'local-vm']);
  const planning = engineWith(prompt('plan', { 'is-planning-stage': true }));
  assert.deepEqual(plan(planning, [ticket('T-1', at('plan'))], { seats: { mac: 1, remote: 1 }, runTargets: rt }).targets.map(t => t.target), ['local-vm']);
});

test('ASS-540 AC4: local-worktree and local-workspace take no seat (not on the Mac\'s seats); local-workspace one ticket at a time per project', () => {
  const engine = engineWith(prompt('build'));
  const rt = projectRunTargets(json({ 'run-targets': ['local-workspace', 'local-worktree'] }));
  const p = plan(engine, [ticket('T-1', at('build')), ticket('T-2', at('build')), ticket('T-3', at('build'))], { seats: { mac: 0, remote: 0 }, runTargets: rt });
  assert.deepEqual(p.local, [{ key: 'T-1', variation: 'A', target: 'local-workspace' }, { key: 'T-2', variation: 'A', target: 'local-worktree' }, { key: 'T-3', variation: 'A', target: 'local-worktree' }]);
  assert.deepEqual([p.reserved, p.onMac, p.waiting, p.seats.used.mac], [[], [], [], 0]);
  assert.deepEqual(p.dispatch.map(d => d.key), ['T-1', 'T-2', 'T-3']);
  // a step that may only use the workspace: the second ticket waits for it
  const only = engineWith(prompt('build', { 'run-targets': 'local-workspace' }));
  const w = plan(only, [ticket('T-1', at('build')), ticket('T-2', at('build'))], { seats: { mac: 0, remote: 0 }, runTargets: rt });
  assert.deepEqual([w.local.map(l => l.key), w.waiting.map(x => x.key)], [['T-1'], ['T-2']]);
  // the holder keeps it ahead of a higher-ranked ticket
  const kept = plan(only, [ticket('T-2', at('build')), ticket('T-1', at('build'))], { seats: { mac: 0, remote: 0 }, runTargets: rt, seated: (t, v) => (t.key === 'T-1' ? { key: 'T-1', variation: v.name, target: 'local-workspace', pool: 'local' } : false) });
  assert.deepEqual(kept.local.map(l => l.key), ['T-1']);
  // targetOf / onMacTarget read seats.json's local list; a vm step there runs on the Mac, not in its machine
  const project = { localSeats: [{ key: 'T-1', variation: 'A', target: 'local-worktree' }], seats: [{ key: 'T-2', variation: 'A', kind: 'vm' }] };
  assert.deepEqual([targetOf(project, 'T-1', 'A'), targetOf(project, 'T-2', 'A'), onMacTarget(project, 'T-1', 'A'), onMacTarget(project, 'T-2', 'A')], ['local-worktree', 'local-vm', true, false]);
  const vmStep = { 'run-location': 'vm', action: { type: 'prompt' } };
  assert.deepEqual([runsOnMachine(project, 'T-1', 'A', vmStep), runsOnMachine(project, 'T-2', 'A', vmStep)], [false, true]);
});

test('ASS-540 AC3, AC4: seats are placed by target — a workstation\'s or a cloud VM\'s as asked, a holder moved between its steps when its next step wants another kind', () => {
  const capacity = { mode: 'vm+workstation', vm: 1, workstations: [{ id: 'ws-1', seats: 1, lost: null }, { id: 'vm-1', seats: 1, lost: null, kind: 'cloud-vm' }], remote: 2 };
  const plans = { 'T-1 A': { target: 'cloud-vm', candidates: ['cloud-vm', 'local-vm'] }, 'T-2 A': { target: 'local-vm', candidates: ['local-vm'] } };
  const targetFor = (k, v) => plans[`${k} ${v}`];
  const placed = placeSeats({ records: [], reserved: [{ key: 'T-1', variation: 'A' }, { key: 'T-2', variation: 'A' }], capacity, targetFor, now: 'n' });
  assert.deepEqual(placed.records, [{ key: 'T-1', variation: 'A', kind: 'cloud-vm', workstation: 'vm-1', target: 'cloud-vm', since: 'n' }, { key: 'T-2', variation: 'A', kind: 'vm', target: 'local-vm', since: 'n' }]);
  // T-2's next step wants a workstation: it moves there between steps (not mid-step)
  plans['T-2 A'] = { target: 'workstation', candidates: ['workstation'] };
  const midway = placeSeats({ records: placed.records, reserved: [{ key: 'T-1', variation: 'A' }, { key: 'T-2', variation: 'A' }], capacity, targetFor, now: 'm', midStep: () => true });
  assert.equal(midway.records[1].kind, 'vm');
  const moved = placeSeats({ records: placed.records, reserved: [{ key: 'T-1', variation: 'A' }, { key: 'T-2', variation: 'A' }], capacity, targetFor, now: 'm' });
  assert.deepEqual(moved.records[1], { key: 'T-2', variation: 'A', kind: 'workstation', workstation: 'ws-1', target: 'workstation', since: 'm' });
});

test('ASS-540 AC6: a script step whose command needs Docker never runs on a substrate target — by machine-steps.js or the project\'s sandbox declaration — and validation says so', () => {
  assert.ok(DOCKER_COMMANDS.has('ci-checks:verify'));
  const ci = script('ci', './agent.sh ci-checks:verify {project} {ticket} {variation}');
  const all = projectRunTargets(json({ 'run-targets': ['local-substrate', 'local-vm'], substrate: { clusters: [{ machine: 'mac' }] } }));
  assert.deepEqual(candidates(ci, all), ['local-vm']);
  assert.match(errorsOf({ ...ci, 'run-targets': ['local-substrate', 'local-vm'] })[0], /step "ci" run-targets lists local-substrate, but its command needs Docker, which a Substrate sandbox does not have/);
  // the project marks its own test command as needing Docker
  const tests = script('tests', './agent.sh automated-tests:verify-success {project} {ticket} {variation}');
  assert.deepEqual(candidates(tests, all), ['local-substrate', 'local-vm']);
  const marked = projectRunTargets(json({ 'run-targets': ['local-substrate', 'local-vm'], substrate: { clusters: [{ machine: 'mac' }], 'needs-docker': ['automated-tests:verify-success'] } }));
  assert.deepEqual(candidates(tests, marked), ['local-vm']);
  // substrate alone left: validation for that project says so, and the step is never started
  const onlySub = json({ 'run-targets': ['local-substrate'], substrate: { clusters: [{ machine: 'mac' }], 'needs-docker': ['automated-tests:verify-success'] } });
  assert.match(projectRunTargetErrors(onlySub, { e: engineWith(tests) }, 'e')[0], /step "tests" can run on none of the project's run targets: its command needs Docker, and the run targets left \(local-substrate\) are Substrate sandboxes/);
  // a machine-only command never on the Mac targets either
  const refresh = script('refresh', './agent.sh vm:refresh-repositories {project} {ticket} {variation}');
  assert.deepEqual(candidates(refresh, projectRunTargets(json({ 'run-targets': ['local-worktree', 'local-vm'] }))), ['local-vm']);
  assert.match(stepRunTargetErrors({ ...refresh, 'run-targets': ['local-worktree'] }).join(), /works only in the ticket's machine/);
});

test('ASS-540 AC7: shipped engines set run-targets only where a step cannot run on some target, and machine-steps.js agrees; the code:* and merge-request:create commands are declared where they run (the Mac, with control)', () => {
  for (const c of ['code:create-branch', 'code:create-worktree', 'code:update-workspace', 'merge-request:create']) assert.equal(scriptPlace(`./agent.sh ${c} {project}`), 'host', c);
  const dir = join(ROOT, 'engines');
  let set = 0;
  for (const name of engineNamesIn(dir)) {
    const engine = readEngine(engineFileIn(dir, name));
    for (const [k, list] of Object.entries(engine)) if (/(^|-)(steps|trigger)$/.test(k)) for (const step of list) {
      assert.deepEqual(stepRunTargetErrors(step), [], `${name}/${step.id}`);
      const commands = [step.action?.command, ...JSON.stringify(step['exit-events'] ?? []).match(/agent\.sh [\w:-]+/g) ?? []].filter(Boolean).map(c => c.replace(/^(\.\/)?agent\.sh /, '').split(' ')[0]);
      const restricted = commands.some(c => MACHINE_ONLY.has(c));
      if (step['run-targets'] === undefined) { assert.ok(!restricted || step.action?.type !== 'script', `${name}/${step.id} runs a machine-only command and leaves run-targets unset`); continue; }
      set++;
      assert.ok(restricted, `${name}/${step.id} sets run-targets though it can run on every target`);
      assert.ok(!step['run-targets'].some(t => t === 'local-worktree' || t === 'local-workspace'), `${name}/${step.id}`);
      if (commands.some(c => DOCKER_COMMANDS.has(c))) assert.ok(!step['run-targets'].some(t => t.endsWith('-substrate')), `${name}/${step.id}`);
    }
  }
  assert.ok(set > 10);
});
