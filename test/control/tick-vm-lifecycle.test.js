// VMs by state (ASS-75): once per loop control makes each project's VMs
// match where their variations stand — running from Setup through Review and
// in Self Healing (and at a step beneath that runs in it), stopped at
// Release, Done, Blocked and Blocked for Human, while paused, and once set
// aside — whoever moved the ticket (the TUI writes sprint.json itself). A VM
// deleted to make room that is needed again is recreated (vm:create). The
// real grouped engines; agent.sh a recorder (the vm:* commands are tested in
// test/agent-cli/vm-disk.test.js); limactl a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { superviseVms, VM_WAIT } from '../../src/control/vm-lifecycle.js';
import { tick } from '../../src/control/tick.js';
import { runSteps } from '../../src/control/steps.js';
import { dispatch, VM_UP_CEILING, vmUpCeilingMs } from '../../src/control/dispatch.js';
import { runCli } from '../../src/control/cli.js';
import { fakeVm } from '../support/fake-vm.js';
import { engineDir, engineNames } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ENGINE = 'example-development-grouped';
const at = (state, sub) => ({ state, 'state-engine': ENGINE, ...(sub ? { 'sub-status': { state: sub[1], 'state-engine': sub[0] } } : {}) });

// p on example-development-grouped, ticket ABC-3's variations as `variations` gives them ({ name: [harness-status, VM
// status or null for none, extra fields] }), each VM abc-3-<name>; agent.sh calls recorded, each answered by fail(args),
// else printing answer(args) (ASS-215: vm:start's JSON); HARNESS_HOME a folder of its own (vm-credentials.json);
// harness.json's ticket limits `limits` (default: none in progress, so every variation holds its seat, ASS-233).
function lifecycle(variations, { fail = () => null, answer = () => '', limits = { 'max-tickets-in-progress': null } } = {}) {
  const f = controlFixture();
  const file = (...rest) => join(f.dir, ...rest);
  writeFileSync(file('harness.json'), JSON.stringify({ ...JSON.parse(readFileSync(file('harness.json'), 'utf8')), ...limits }));
  for (const name of engineNames()) if (!existsSync(file('engines', name)) && existsSync(join(engineDir(name), 'state-engine.json'))) cpSync(engineDir(name), file('engines', name), { recursive: true });
  const project = JSON.parse(readFileSync(file('projects', 'p', 'project.json'), 'utf8'));
  writeFileSync(file('projects', 'p', 'project.json'), JSON.stringify({ ...project, 'execution-state-engine': ENGINE }));
  const v = fakeVm(f.env);
  const sprint = file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  writeFileSync(sprint, JSON.stringify({ number: 10, bugs: [], spikes: [], features: [{ key: 'ABC-3', 'ticket-system-status': 'In Progress', variations: Object.entries(variations).map(([name, [status, vm, extra]]) => {
    if (vm) v.instance(`abc-3-${name.toLowerCase()}`, vm);
    return { name, 'harness-status': status, 'state-changes': [], vm: { name: `abc-3-${name.toLowerCase()}`, ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' }, ...extra };
  }) }] }));
  const home = file('harness-home');
  mkdirSync(home, { recursive: true });
  f.ctx.env = { ...v.env, HARNESS_HOME: home };
  let now = Date.parse('2026-10-24T12:00:00Z');
  f.ctx.now = () => new Date(now);
  const calls = [];
  f.ctx.cli = async args => { calls.push(args.join(' ')); const error = fail(args); if (error) throw new Error(error); return answer(args); };
  const edit = change => { const json = JSON.parse(readFileSync(sprint, 'utf8')); change(json.features[0]); writeFileSync(sprint, JSON.stringify(json)); };
  return {
    f, v, calls, edit, file, home,
    later: ms => { now += ms; },
    // One pass of the phase, its work awaited; the calls it made.
    pass: async () => {
      const before = calls.length;
      await superviseVms(f.ctx, f.ctx.load());
      await Promise.all([...f.ctx.memory.vms.values()].map(r => r.job));
      return calls.slice(before).sort();
    },
  };
}

test('each variation\'s VM runs from Setup through Review and in Self Healing, and is stopped at Release, Done, Blocked, Blocked for Human, while paused and once set aside', async () => {
  const l = lifecycle({
    A: [at('setup', ['grouped-setup', 'mark-setup-complete']), 'Stopped'],
    B: [at('review', ['grouped-review', 'explain-the-change']), 'Stopped'],   // ASS-418: Variation Selection, a human step, now stops it
    C: [at('self-healing'), 'Stopped'],
    D: [at('build', ['grouped-build', 'code-review']), 'Running'],                         // as it should be
    E: [at('release', ['grouped-release-example', 'team-code-review']), 'Running'],
    F: [at('done'), 'Running'],
    G: [at('blocked', ['grouped-blocked', 'wait-on']), 'Running'],
    H: [at('blocked-for-human'), 'Running'],
    I: [at('build', ['grouped-build', 'generate-solution']), 'Running', { 'is-paused': true }],
    J: [at('review', ['grouped-review', 'variation-selection']), 'Running', { 'is-deleted': true }],
    K: [at('done'), 'Stopped'],                                                              // as it should be
  });
  assert.deepEqual(await l.pass(), [
    'vm:start p ABC-3 A', 'vm:start p ABC-3 B', 'vm:start p ABC-3 C',
    'vm:stop p abc-3-e', 'vm:stop p abc-3-f', 'vm:stop p abc-3-g', 'vm:stop p abc-3-h', 'vm:stop p abc-3-i', 'vm:stop p abc-3-j',
  ]);
  assert.ok(l.f.lines.includes('vm p abc-3-e: stopped (ABC-3 E at release)'), l.f.lines.join('\n'));
  assert.ok(l.f.lines.includes('vm p abc-3-a: started (ABC-3 A at setup)'), l.f.lines.join('\n'));
});

test('a step beneath that runs in the VM has it running though its group does not: Blocked\'s troubleshooting, example Release\'s Address Merge Request Feedback', async () => {
  const l = lifecycle({
    A: [at('blocked', ['grouped-blocked', 'troubleshoot']), 'Stopped'],
    B: [at('release', ['grouped-release-example', 'address-merge-request-feedback']), 'Stopped'],
  });
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A', 'vm:start p ABC-3 B']);
});

test('a move made by hand (the TUI) is followed at the next pass, and so is a pause lifted; a VM that is as it should be is left alone', async () => {
  const l = lifecycle({ A: [at('build', ['grouped-build', 'generate-solution']), 'Running'], B: [at('plan', ['grouped-plan', 'enrich-ac']), 'Stopped', { 'is-paused': true }] });
  assert.deepEqual(await l.pass(), []);
  l.edit(t => { t.variations[0]['harness-status'] = at('release', ['grouped-release-example', 'take-out-of-draft-mode']); t.variations[1]['is-paused'] = false; });
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 B', 'vm:stop p abc-3-a']);
  l.edit(t => { t['is-paused'] = true; });   // the whole ticket paused
  writeFileSync(join(l.v.instances, 'abc-3-a', 'status'), 'Stopped');   // as the commands left them (agent.sh is a recorder here)
  writeFileSync(join(l.v.instances, 'abc-3-b', 'status'), 'Running');
  assert.deepEqual(await l.pass(), ['vm:stop p abc-3-b']);
});

test('a VM deleted to make room that its variation needs again is recreated through vm:create; one it does not need is left deleted', async () => {
  const l = lifecycle({ A: [at('build', ['grouped-build', 'generate-solution']), null], B: [at('done'), null] });
  assert.deepEqual(await l.pass(), ['vm:create p ABC-3 A']);
  assert.ok(l.f.lines.includes('vm p abc-3-a: recreated (ABC-3 A at build; it had been deleted)'), l.f.lines.join('\n'));
});

test('a VM only the inventory knows (its sprint ended) is stopped when running; other VMs — golden images, other projects\' — are never touched', async () => {
  const l = lifecycle({});
  l.v.instance('abc-1-a', 'Running');
  l.v.instance('golden-p', 'Running');
  l.v.instance('xyz-1-a', 'Running');
  writeFileSync(l.file('projects', 'p', 'vms.json'), JSON.stringify({ 'abc-1-a': { ticket: 'ABC-1', variation: 'A', state: 'Running', 'disk-bytes': 0, 'last-accessed': '2026-10-01T00:00:00Z' } }));
  assert.deepEqual(await l.pass(), ['vm:stop p abc-1-a']);
  assert.ok(l.f.lines.includes('vm p abc-1-a: stopped (ABC-1 A is not in the sprint)'), l.f.lines.join('\n'));
});

// ASS-234 AC2: a VM only the inventory knows whose variation is in the sprint (a vm:create that failed before
// linking it, from before it linked a clone at once) is said to be not linked to its variation, not not in the sprint.
test('ASS-234 AC2: an inventory-only VM matching a sprint variation is logged "not linked to its variation"', async () => {
  const l = lifecycle({ A: [at('setup', ['grouped-setup', 'create-vm']), 'Running'] });
  l.edit(t => { delete t.variations[0].vm; });
  writeFileSync(l.file('projects', 'p', 'vms.json'), JSON.stringify({ 'abc-3-a': { ticket: 'ABC-3', variation: 'A', state: 'Running', 'disk-bytes': 0, 'last-accessed': '2026-10-01T00:00:00Z' } }));
  assert.deepEqual(await l.pass(), ['vm:stop p abc-3-a']);
  assert.ok(l.f.lines.includes('vm p abc-3-a: stopped (ABC-3 A not linked to its variation)'), l.f.lines.join('\n'));
});

test('a failing start or stop is logged and backed off, 30 seconds doubling; the rest still run', async () => {
  const l = lifecycle({ A: [at('plan', ['grouped-plan', 'enrich-ac']), 'Stopped'], B: [at('done'), 'Running'] }, { fail: args => args[0] === 'vm:start' && 'vm:start: abc-3-a would not start' });
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A', 'vm:stop p abc-3-b']);
  assert.ok(l.f.lines.some(l2 => l2 === 'error vm p abc-3-a: vm:start p ABC-3 A failed (1 in a row; next try in 30s): vm:start: abc-3-a would not start'), l.f.lines.join('\n'));
  writeFileSync(join(l.v.instances, 'abc-3-b', 'status'), 'Stopped');
  l.later(29_000);
  assert.deepEqual(await l.pass(), []);
  l.later(1000);
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A']);
  assert.ok(l.f.lines.some(l2 => /\(2 in a row; next try in 60s\)/.test(l2)), l.f.lines.join('\n'));
});

test('the tick runs the phase, even under a rate limit: a VM is stopped as its ticket leaves the states that need it', async () => {
  const l = lifecycle({ A: [at('done'), 'Running'] });
  writeFileSync(l.file('projects', 'p', 'rate-limit.json'), JSON.stringify({ 'resets-at': '2026-10-24T13:00:00Z' }));
  await tick(l.f.ctx);
  await Promise.all([...l.f.ctx.memory.vms.values()].map(r => r.job));
  assert.ok(l.calls.includes('vm:stop p abc-3-a'), l.calls.join('\n'));
});

// ASS-133: a ticket's steps wait for its VM. ABC-3's variations as lifecycle
// takes them, each with its run at the step of its sub-status (Setup's Check
// Setup Complete: a ticket re-entering Setup); agent.sh's vm:* recorded, vm:start leaving the
// VM Running, everything else run; vm:setup-complete answered as the real one
// is: it succeeds only when the VM is running (and set up: here, always);
// script steps recorded with them, exiting 0.
async function reentering(variations, options) {
  const l = lifecycle(variations, options), real = args => runCli(l.f.ctx, args);
  const status = name => { const file = join(l.v.instances, name, 'status'); return existsSync(file) && readFileSync(file, 'utf8'); };
  const recorded = l.f.ctx.cli;
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  l.f.ctx.cli = async args => {
    if (!args[0].startsWith('vm:')) return real(args);
    await recorded(args);
    if (args[0] === 'vm:start') await slow;
    if (args[0] === 'vm:start') writeFileSync(join(l.v.instances, `abc-3-${args[3].toLowerCase()}`, 'status'), 'Running');
    return '';
  };
  l.asked = [];
  l.f.ctx.succeeds = argv => { l.asked.push(argv.join(' ')); return argv[1] === 'vm:setup-complete' && status(`abc-3-${argv[4].toLowerCase()}`) === 'Running'; };
  l.f.ctx.script = async (argv, vm) => { l.calls.push(`${argv.join(' ').replace('./agent.sh ', '')}${vm ? ` in ${vm}` : ''}`); return { exitCode: 0, stdout: '' }; };   // script steps recorded, never run
  for (const [name, [status]] of Object.entries(variations)) await l.f.agent('transient-state-engine:create', 'p', status['sub-status']['state-engine'], status['sub-status'].state, JSON.stringify({ 'work-item': 'ABC-3', variation: name, 'state-engine': ENGINE, state: status.state }));
  // One tick's VM and steps phases, in the tick's order; a start (7–30 s) not done until `settle` lets it finish and awaits the job.
  l.tick = async () => { await superviseVms(l.f.ctx, l.f.ctx.load()); await runSteps(l.f.ctx, l.f.ctx.load()); };
  l.settle = () => { release(); return Promise.all([...l.f.ctx.memory.vms.values()].map(r => r.job)); };
  l.trail = name => (l.f.variation(name)['harness-status']['sub-status']?.state);
  l.runAt = name => l.f.assignments()['transient-state-engines'].find(r => r.parent?.variation === name)?.state;
  return l;
}
const SETTING_UP = at('setup', ['grouped-setup', 'check-setup-complete']);

test('ASS-133 AC1, AC2: a ticket re-entering Setup with its set-up VM stopped is not judged until control has started the VM, then leaves Setup at Check Setup Complete without running Create VM', async () => {
  const l = await reentering({ A: [SETTING_UP, 'Stopped'] });
  await l.tick();   // the start is under way beside the tick
  assert.equal(l.runAt('A'), 'check-setup-complete', l.f.lines.join('\n'));
  assert.deepEqual(l.asked, [], l.f.lines.join('\n'));
  await l.settle();
  assert.ok(l.calls.includes('vm:start p ABC-3 A'), l.calls.join('\n'));
  await l.tick();
  assert.equal(l.runAt('A'), 'done', l.f.lines.join('\n'));
  assert.ok(!l.calls.some(c => c.startsWith('vm:create')), l.calls.join('\n'));
});

test('ASS-133 AC1: so does any step of a run in its VM\'s group — Build\'s Automated Testing, a script run in the VM — not run until the VM is', async () => {
  const l = await reentering({ A: [at('build', ['grouped-build', 'automated-testing']), 'Stopped'] });
  await l.tick();
  assert.ok(!l.calls.some(c => c.includes(' in abc-3-a')), l.calls.join('\n'));
  assert.ok(l.f.lines.some(x => /^vm ABC-3 A build: waits for its VM abc-3-a to be running$/.test(x)), l.f.lines.join('\n'));
  await l.settle();
  await l.tick();
  assert.ok(l.calls.some(c => c.endsWith(' in abc-3-a')), l.calls.join('\n'));
});

test('ASS-133 AC3: a ticket with no VM is not delayed: Check Setup Complete is judged at once, and Setup goes on to Create VM', async () => {
  const l = await reentering({ A: [SETTING_UP, null, { vm: undefined }] });
  await l.tick();
  assert.equal(l.asked[0], './agent.sh vm:setup-complete p ABC-3 A');
  assert.ok(l.calls.includes('vm:create p ABC-3 A'), l.calls.join('\n'));
});

test('ASS-133 AC1: the wait is bounded — a VM that does not come up in two minutes (its start failing) leaves the step judged as it stands, logged once', async () => {
  const l = await reentering({ A: [SETTING_UP, 'Stopped'] }, { fail: args => args[0] === 'vm:start' && 'vm:start: abc-3-a would not start' });
  await l.tick();
  await l.settle();
  l.later(VM_WAIT - 1000);
  await l.tick();
  assert.deepEqual(l.asked, []);
  l.later(1000);
  await l.tick();
  assert.equal(l.asked[0], './agent.sh vm:setup-complete p ABC-3 A');
  assert.ok(l.calls.includes('vm:create p ABC-3 A'), l.calls.join('\n'));
  assert.equal(l.f.lines.filter(x => /its VM abc-3-a is not running after 2m; judged as it stands$/.test(x)).length, 1, l.f.lines.join('\n'));
});

// ASS-387: past VM_WAIT a step whose VM's start is still queued behind the
// project's other VM jobs, or under way, is not judged as it stands: it waits
// on until the VM is up, then is judged; or, past vmUpCeilingMs, the variation
// goes to Blocked naming its VM, as dispatch's ceiling (ASS-348) does.
test('ASS-387 AC1, AC2: a VM-dependent step whose VM start is queued (B, behind A\'s) or under way (A) past VM_WAIT is not judged — no script, no "judged as it stands" — and once the VMs are up the next tick runs its script in the VM, with no Blocked move', async () => {
  const l = await reentering({ A: [TESTING, 'Stopped'], B: [TESTING, 'Stopped'] });
  await l.tick();   // A's vm:start under way beside the tick, B's queued behind it in the project's job
  l.later(VM_WAIT); await l.tick();
  l.later(VM_WAIT); await l.tick();
  assert.ok(l.calls.includes('vm:start p ABC-3 A') && !l.calls.includes('vm:start p ABC-3 B'), l.calls.join('\n'));
  assert.ok(!l.calls.some(c => / in abc-3-[ab]$/.test(c)), l.calls.join('\n'));
  assert.ok(!l.f.lines.some(x => x.includes('judged as it stands')), l.f.lines.join('\n'));
  for (const name of ['abc-3-a', 'abc-3-b']) assert.ok(l.f.lines.some(x => x.endsWith(`: its VM ${name} is not running after 2m, its start still queued or under way; waits on, up to 30m`)), l.f.lines.join('\n'));
  await l.settle();   // both started, B's after A's
  await l.tick();
  assert.ok(l.calls.some(c => c.endsWith(' in abc-3-a')) && l.calls.some(c => c.endsWith(' in abc-3-b')), l.calls.join('\n'));
  for (const name of ['A', 'B']) assert.equal(l.f.variation(name)['harness-status'].state, 'build', l.f.lines.join('\n'));
  assert.ok(!l.f.lines.some(x => / → blocked/.test(x)), l.f.lines.join('\n'));
});

test('ASS-387 AC3: a VM whose start is still under way at vmUpCeilingMs sends its variation to Blocked, naming its VM and that it never came up, with no script run against it', async () => {
  const l = await reentering({ A: [TESTING, 'Stopped'] });
  await l.tick();   // the start never finishes
  l.later(VM_UP_CEILING - 1000); await l.tick();
  assert.equal(l.f.variation('A')['harness-status'].state, 'build', l.f.lines.join('\n'));
  l.later(1000); await l.tick();
  const v = l.f.variation('A');
  assert.equal(v['harness-status'].state, 'blocked', l.f.lines.join('\n'));
  assert.equal(v['ai-feedback-short'], 'VM abc-3-a never came up: not running and reachable after 30m');
  assert.ok(l.f.lines.some(x => /^steps ABC-3 A build → blocked .*\(its VM abc-3-a never came up\)$/.test(x)), l.f.lines.join('\n'));
  assert.ok(!l.calls.some(c => c.endsWith(' in abc-3-a')), l.calls.join('\n'));
  assert.ok(!l.f.lines.some(x => x.includes('judged as it stands')), l.f.lines.join('\n'));
  await l.settle();
});

// ASS-418 AC3: a step that needs no VM says vm stopped beneath its running
// group, so a ticket parked at a wait — Build's Await Sequential Merge, a
// forge poll on a timer — has its VM stopped by the lifecycle while it polls;
// once it moves on to a step that needs the VM (Refresh the Reference
// Repositories Before Testing) the VM is started again and the step waits for
// it (ASS-387), then runs once: no step re-run, no visit spent. One with an
// agent still at work on its variation is left till that ends (ASS-349).
const AWAITING_MERGE = at('build', ['grouped-build', 'await-dependencies']);

test('ASS-418 AC3: a ticket parked at Await Sequential Merge has its VM stopped while it polls; moving on to a step that needs it starts it again, the step waiting for it, then run once — no step re-run, no visit spent', async () => {
  const l = await reentering({ A: [AWAITING_MERGE, 'Running'] });
  let merged = false;
  l.f.ctx.script = async (argv, vm) => { l.calls.push(`${argv.join(' ').replace('./agent.sh ', '')}${vm ? ` in ${vm}` : ''}`); return { exitCode: argv[1] === 'merge-request:await-dependencies' && !merged ? 2 : 0, stdout: '' }; };
  const jobs = () => Promise.all([...l.f.ctx.memory.vms.values()].map(r => r.job));
  await l.tick(); await jobs();
  assert.ok(l.calls.includes('vm:stop p abc-3-a'), l.calls.join('\n'));
  assert.ok(l.f.lines.includes('vm p abc-3-a: stopped (ABC-3 A at build)'), l.f.lines.join('\n'));
  assert.equal(l.runAt('A'), 'await-dependencies', l.f.lines.join('\n'));
  writeFileSync(join(l.v.instances, 'abc-3-a', 'status'), 'Stopped');   // as vm:stop left it
  l.later(5 * 60_000); await l.tick(); await jobs();   // polled again, its VM stopped: nothing started
  assert.equal(l.calls.filter(c => c.startsWith('merge-request:await-dependencies')).length, 2, l.calls.join('\n'));
  assert.ok(!l.calls.some(c => c.startsWith('vm:start')), l.calls.join('\n'));
  merged = true;
  l.later(5 * 60_000); await l.tick();   // merged: on to Refresh the Reference Repositories Before Testing
  assert.equal(l.runAt('A'), 'refresh-before-testing', l.f.lines.join('\n'));
  await l.tick();   // its VM's start under way beside the tick: the step waits, not run
  assert.ok(l.calls.includes('vm:start p ABC-3 A'), l.calls.join('\n'));
  assert.ok(!l.calls.some(c => c.startsWith('vm:refresh-repositories')), l.calls.join('\n'));
  await l.settle(); await l.tick();
  assert.equal(l.calls.filter(c => c.startsWith('vm:refresh-repositories')).length, 1, l.calls.join('\n'));
  assert.equal(l.calls.filter(c => c.startsWith('merge-request:await-dependencies')).length, 3, l.calls.join('\n'));
  const run = l.f.assignments()['transient-state-engines'].find(r => r.parent?.variation === 'A');
  assert.equal((run?.['state-changes'] ?? []).filter(c => c['to-state'] === 'refresh-before-testing').length, 1, JSON.stringify(run));
  assert.equal((run?.['state-changes'] ?? []).filter(c => c['to-state'] === 'await-dependencies').length, 0, JSON.stringify(run));
  assert.equal(l.f.variation('A')['harness-status'].state, 'build', l.f.lines.join('\n'));
  assert.ok(!l.f.lines.some(x => / → blocked|judged as it stands/.test(x)), l.f.lines.join('\n'));
});

test('ASS-418 AC3: a VM at a wait with an agent still at work on its variation is left running till the agent ends (ASS-349), then stopped', async () => {
  const l = lifecycle({ A: [AWAITING_MERGE, 'Running'] });
  pauseWith(l, {}, [working('A')]);
  assert.deepEqual(await l.pass(), []);
  assert.ok(l.f.lines.some(x => x.startsWith('vm p abc-3-a: to stop (ABC-3 A at build)') && x.endsWith('waits until its agent finishes')), l.f.lines.join('\n'));
  pauseWith(l, {}, []);
  assert.deepEqual(await l.pass(), ['vm:stop p abc-3-a']);
});

// ASS-225: a paused variation's sub-engine runs are held with it — the
// pause is recorded on the variation, so runSteps asks isPaused with the
// run's variation. A sibling variation, not paused, works on.
const TESTING = at('build', ['grouped-build', 'automated-testing']);

test('ASS-225 AC1, AC3, AC4: a paused variation\'s run at a VM step does not run, and does not log its VM wait every tick; its unpaused sibling waits once, then runs', async () => {
  const l = await reentering({ A: [TESTING, 'Stopped', { 'is-paused': true }], B: [TESTING, 'Stopped'] });
  await l.tick(); await l.tick(); await l.tick();
  await l.settle();
  await l.tick();
  assert.ok(!l.calls.some(c => c.endsWith(' in abc-3-a')), l.calls.join('\n'));
  assert.ok(l.f.lines.filter(x => x.includes('waits for its VM abc-3-a')).length <= 1, l.f.lines.join('\n'));
  assert.equal(l.f.lines.filter(x => x.includes('waits for its VM abc-3-b')).length, 1, l.f.lines.join('\n'));
  assert.ok(l.calls.some(c => c.endsWith(' in abc-3-b')), l.calls.join('\n'));
});

test('ASS-225 AC2, AC4: a paused variation\'s run at a script step without a VM (Setup\'s Create VM) does not run its script; its unpaused sibling\'s does', async () => {
  const CREATING = at('setup', ['grouped-setup', 'create-vm']);
  const l = await reentering({ A: [CREATING, null, { vm: undefined, 'is-paused': true }], B: [CREATING, null, { vm: undefined }] });
  await l.tick(); await l.tick();
  assert.ok(!l.calls.includes('vm:create p ABC-3 A'), l.calls.join('\n'));
  assert.ok(l.calls.includes('vm:create p ABC-3 B'), l.calls.join('\n'));
});

// ASS-159: an agent is dispatched into a VM only once it is up — the same wait
// (awaitsVm) a step is judged under. ASS-158's review-plan, a vm prompt step of
// a run, went to three agents while its VM was down after an outage, each
// failing in seconds, and blocked the ticket. Here Build's Generate Solution, a
// vm prompt step of the ticket's Build run; agent.sh a fake in the VM.
async function dispatching(variations, options) {
  const l = await reentering(variations, options);
  l.v.inVm('agent.sh', 'echo "{}"');
  for (const name of readdirSync(join(ROOT, 'prompts'))) if (!existsSync(l.file('prompts', name))) cpSync(join(ROOT, 'prompts', name), l.file('prompts', name), { recursive: true });
  const steps = l.tick;
  l.tick = async () => { await steps(); await dispatch(l.f.ctx, l.f.ctx.load()); };
  l.agents = () => l.f.assignments().assignments.filter(a => a.state === 'generate-solution');
  return l;
}
const GENERATING = at('build', ['grouped-build', 'generate-solution']);

test('ASS-159 AC1, AC2: a run\'s vm prompt step whose VM is not running gets no agent until the VM is up — its wait logged once, as a ticket step\'s, and no retry spent', async () => {
  const l = await dispatching({ A: [GENERATING, 'Stopped'] });
  try {
    await l.tick();
    await l.tick();
    assert.deepEqual(l.agents(), [], l.f.lines.join('\n'));
    assert.equal(l.f.lines.filter(x => x === 'vm ABC-3 A build: waits for its VM abc-3-a to be running').length, 1, l.f.lines.join('\n'));
    await l.settle();
    await l.tick();
    assert.equal(l.agents().length, 1, l.f.lines.join('\n'));
    assert.ok(!l.f.lines.some(x => /^error |tried again/.test(x)), l.f.lines.join('\n'));
  } finally {
    l.f.ctx.stopAgents();
  }
});

test('ASS-159 AC2: the ASS-158 shape — a VM control saw running goes down (an outage): the next tick\'s dispatch waits for it, not sending an agent into the down VM', async () => {
  const l = await dispatching({ A: [GENERATING, 'Running'] });
  await superviseVms(l.f.ctx, l.f.ctx.load());
  await Promise.all([...l.f.ctx.memory.vms.values()].map(r => r.job));
  assert.ok(l.f.ctx.memory.vmsUp.has('abc-3-a'));
  writeFileSync(join(l.v.instances, 'abc-3-a', 'status'), 'Stopped');   // the outage
  try {
    await l.tick();
    assert.deepEqual(l.agents(), [], l.f.lines.join('\n'));
    assert.ok(l.f.lines.includes('vm ABC-3 A build: waits for its VM abc-3-a to be running'), l.f.lines.join('\n'));
  } finally {
    l.f.ctx.stopAgents();
  }
});

// ASS-169: a Running VM is up (memory.vmsUp) only once a probe has reached
// it too, so dispatch (and step-judging) wait the same as for a down VM;
// the probe runs beside the tick, in match, and is silent either way.
test('ASS-169 AC1-AC4: a VM Running but not yet reachable is probed in the match job, not marked up until the probe succeeds, no dispatch meanwhile, no error or backoff; once reachable it is probed again and dispatched into, silently', async () => {
  const l = await dispatching({ A: [GENERATING, 'Running'] });
  l.v.unreachable('abc-3-a');
  try {
    await l.tick(); await l.settle(); await l.tick(); await l.settle();
    assert.ok(l.v.calls().some(c => c.vm === 'abc-3-a' && JSON.stringify(c.argv) === '["true"]'), l.v.calls().map(c => JSON.stringify(c)).join('\n'));
    assert.ok(!l.f.ctx.memory.vmsUp.has('abc-3-a'), l.f.lines.join('\n'));
    assert.deepEqual(l.agents(), [], l.f.lines.join('\n'));
    assert.equal(l.f.lines.filter(x => x === 'vm ABC-3 A build: waits for its VM abc-3-a to be running').length, 1, l.f.lines.join('\n'));
    assert.ok(!l.f.lines.some(x => /^error /.test(x)), l.f.lines.join('\n'));
    assert.ok(!l.f.ctx.memory.vms.get('p').held.has('abc-3-a'), l.f.lines.join('\n'));
    assert.ok(!l.f.lines.some(x => /tried again/.test(x)), l.f.lines.join('\n'));

    rmSync(join(l.v.instances, 'abc-3-a', 'unreachable'));
    await l.tick(); await l.settle();
    assert.ok(l.f.ctx.memory.vmsUp.has('abc-3-a'), l.f.lines.join('\n'));
    assert.ok(!l.f.lines.some(x => /^vm p abc-3-a: /.test(x)), l.f.lines.join('\n'));

    await l.tick();
    assert.equal(l.agents().length, 1, l.f.lines.join('\n'));
    assert.ok(!l.f.lines.some(x => /^error /.test(x)), l.f.lines.join('\n'));
  } finally {
    l.f.ctx.stopAgents();
  }
});

// ASS-348: past VM_WAIT a step is judged as it stands (ASS-133), but an agent
// still waits for its VM until control has seen it up — one sent into a VM
// whose vm:start has not written its credentials yet fails "Not logged in" in
// seconds and spends a try — and, past VM_UP_CEILING, its variation goes to
// Blocked, its ai-feedback naming the VM.
const DISPATCH_WAIT = 'dispatch ABC-3 A generate-solution: waits for its VM abc-3-a to be up before an agent is dispatched into it';

// ASS-387: a VM whose start is still under way past VM_WAIT keeps its step unjudged too, so the dispatch wait is not reached.
test('ASS-348 AC1, AC2, AC4, ASS-387: a VM still starting past VM_WAIT gets no agent — the step not judged, its wait on logged once — and the tick after it is up dispatches one', async () => {
  const l = await dispatching({ A: [GENERATING, 'Stopped'] });
  try {
    await l.tick();   // vm:start under way beside the tick, not done
    l.later(VM_WAIT);
    await l.tick(); await l.tick(); await l.tick();
    assert.deepEqual(l.agents(), [], l.f.lines.join('\n'));
    assert.ok(!l.f.lines.some(x => x.includes('judged as it stands')), l.f.lines.join('\n'));
    assert.equal(l.f.lines.filter(x => x.endsWith(': its VM abc-3-a is not running after 2m, its start still queued or under way; waits on, up to 30m')).length, 1, l.f.lines.join('\n'));
    await l.settle();   // vm:start done: the VM is up
    assert.ok(l.f.ctx.memory.vmsUp.has('abc-3-a'));
    await l.tick();
    assert.equal(l.agents().length, 1, l.f.lines.join('\n'));
    assert.ok(!l.f.lines.some(x => /^error |tried again/.test(x)), l.f.lines.join('\n'));
  } finally {
    l.f.ctx.stopAgents();
  }
});

test('ASS-348 AC1, AC3: a VM whose vm:start failed and is backed off gets no agent past VM_WAIT; at VM_UP_CEILING (30 minutes, harness.json vm-up-ceiling-seconds) the variation goes to Blocked, its ai-feedback naming the VM', async () => {
  assert.equal(VM_UP_CEILING, 30 * 60_000);
  assert.equal(vmUpCeilingMs({ harness: {} }), VM_UP_CEILING);
  assert.equal(vmUpCeilingMs({ harness: { 'vm-up-ceiling-seconds': 600 } }), 600_000);
  const l = await dispatching({ A: [GENERATING, 'Stopped'] }, { fail: args => args[0] === 'vm:start' && 'vm:start: limactl list failed' });
  try {
    await l.tick(); await l.settle();
    assert.ok(l.f.lines.some(x => /^error vm p abc-3-a: vm:start p ABC-3 A failed \(1 in a row; next try in 30s\)/.test(x)), l.f.lines.join('\n'));
    l.later(VM_WAIT);
    await l.tick(); await l.tick();
    assert.deepEqual(l.agents(), [], l.f.lines.join('\n'));
    assert.equal(l.f.lines.filter(x => x === DISPATCH_WAIT).length, 1, l.f.lines.join('\n'));
    l.later(VM_UP_CEILING - VM_WAIT - 1000);
    await l.tick();
    assert.equal(l.f.variation('A')['harness-status'].state, 'build', l.f.lines.join('\n'));
    l.later(1000);
    await l.tick();
    assert.deepEqual(l.agents(), [], l.f.lines.join('\n'));
    const v = l.f.variation('A');
    assert.equal(v['harness-status'].state, 'blocked', l.f.lines.join('\n'));
    assert.equal(v['ai-feedback-short'], 'VM abc-3-a never came up: not running and reachable after 30m');
    assert.match(v['ai-feedback-long'], /^VM abc-3-a never came up: .*no agent was sent/);
    assert.ok(l.f.lines.some(x => /^dispatch ABC-3 A build → blocked .*\(its VM abc-3-a never came up\)$/.test(x)), l.f.lines.join('\n'));
    assert.equal(l.f.lines.filter(x => x === DISPATCH_WAIT).length, 1, l.f.lines.join('\n'));
  } finally {
    l.f.ctx.stopAgents();
  }
});

test('ASS-166 AC2: a ticket worked by hand has its VMs stopped, as a paused one does', async () => {
  const l = lifecycle({ A: [at('build', ['grouped-build', 'generate-solution']), 'Running'] });
  l.edit(t => { t['worked-manually'] = { by: 'alice', since: '2026-10-27T10:00:00Z', note: null }; });
  assert.deepEqual(await l.pass(), ['vm:stop p abc-3-a']);
});

// ASS-215 AC1: a Running VM whose recorded credential kind (vms.json) is not
// the one its project declares now (~/.harness/vm-credentials.json) is
// refreshed through vm:start — once idle. Here vm:start answers as the real
// one does: it records the kind it injected on the VM's row and prints it.
const BUILDING = at('build', ['grouped-build', 'generate-solution']);
function switched(variations, rows, opts = {}) {
  const { declared, printed } = { declared: { p: { anthropic: { 'keychain-service': 'Anthropic API Key (Test)' } } }, ...opts };   // declared: undefined, no file
  let l;
  const vmsFile = () => l.file('projects', 'p', 'vms.json');
  const answer = args => {
    if (args[0] !== 'vm:start') return '';
    const name = `abc-3-${args[3].toLowerCase()}`, kind = printed ?? 'anthropic';
    const vms = JSON.parse(readFileSync(vmsFile(), 'utf8'));
    if (!printed) vms[name] = { ...vms[name], 'credential-kind': kind };   // record_vm's 6th argument
    writeFileSync(vmsFile(), JSON.stringify(vms));
    return JSON.stringify({ name, ip: '192.168.64.9', 'credential-kind': kind });
  };
  l = lifecycle(variations, { answer });
  writeFileSync(vmsFile(), JSON.stringify(Object.fromEntries(Object.entries(rows).map(([name, kind]) => [`abc-3-${name.toLowerCase()}`,
    { ticket: 'ABC-3', variation: name, state: 'Running', 'disk-bytes': 0, 'last-accessed': '2026-10-24T00:00:00Z', ...(kind ? { 'credential-kind': kind } : {}) }]))));
  if (declared !== undefined) writeFileSync(join(l.home, 'vm-credentials.json'), typeof declared === 'string' ? declared : JSON.stringify(declared));
  l.assign = (variation, on = true) => {
    const file = l.f.ctx.paths.assignments, data = JSON.parse(readFileSync(file, 'utf8'));
    data.assignments = on ? [{ 'agent-name': 'Zed', project: 'p', 'work-item': 'ABC-3', variation, 'state-engine': 'grouped-build', state: 'generate-solution', status: 'Starting', 'process-id': null }] : [];
    writeFileSync(file, JSON.stringify(data));   // an assignment written, its agent not yet started (no ctx.agents entry)
  };
  return l;
}

test('ASS-215 AC1: a Running VM whose recorded kind is not the declared one is refreshed through vm:start, its row taking the kind vm:start printed; one with an assignment on its variation waits (logged once) until idle; one already matching, and one recording no kind yet, as their rows say', async () => {
  const l = switched({ A: [BUILDING, 'Running'], B: [BUILDING, 'Running'], C: [BUILDING, 'Running'], D: [BUILDING, 'Running'] }, { A: 'claude', B: 'claude', C: 'anthropic', D: null });
  l.assign('B');
  assert.equal(l.f.ctx.agents.size, 0);
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A', 'vm:start p ABC-3 D']);
  assert.ok(l.f.lines.some(x => /^vm p abc-3-a: credentials refreshed \(.*claude → anthropic\)$/.test(x)), l.f.lines.join('\n'));
  assert.ok(l.f.lines.some(x => /^vm p abc-3-d: credentials refreshed \(.*no recorded kind → anthropic\)$/.test(x)), l.f.lines.join('\n'));
  const row = name => JSON.parse(readFileSync(l.file('projects', 'p', 'vms.json'), 'utf8'))[name];
  assert.equal(row('abc-3-a')['credential-kind'], 'anthropic');
  assert.equal(row('abc-3-b')['credential-kind'], 'claude');
  assert.deepEqual(await l.pass(), []);   // B still busy; A, C, D match
  assert.equal(l.f.lines.filter(x => /abc-3-b/.test(x) && /idle/.test(x)).length, 1, l.f.lines.join('\n'));
  l.assign('B', false);
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 B']);
  assert.equal(row('abc-3-b')['credential-kind'], 'anthropic');
  assert.deepEqual(await l.pass(), []);
  assert.ok(!l.f.lines.some(x => /^error /.test(x)), l.f.lines.join('\n'));
});

test('ASS-217 AC2: a project declaring both claude and anthropic refreshes a VM holding one kind once, to both; a VM holding both is never refreshed, whichever kind its agents are paid by', async () => {
  const both = { p: { claude: { 'keychain-service': 'Claude Token (Test)' }, anthropic: { 'keychain-service': 'Anthropic API Key (Test)' } } };
  const l = switched({ A: [BUILDING, 'Running'], B: [BUILDING, 'Running'] }, { A: 'claude', B: 'both' }, { declared: both, printed: 'both' });
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A']);
  assert.ok(l.f.lines.some(x => /^vm p abc-3-a: credentials refreshed \(.*claude → both\)$/.test(x)), l.f.lines.join('\n'));
  assert.ok(!l.f.lines.some(x => /^error /.test(x)), l.f.lines.join('\n'));
});

for (const [why, declared] of [['declares neither kind', { p: { github: { 'keychain-service': 'GitHub PAT (Test)' } } }], ['is not in vm-credentials.json', { q: { anthropic: { 'keychain-service': 'K' } } }], ['has no vm-credentials.json', undefined], ['has a vm-credentials.json that is not JSON', '{ not json']]) {
  test(`ASS-215 AC1: a project that ${why} is never compared — no VM refreshed, whatever its row records, and nothing thrown`, async () => {
    const l = switched({ A: [BUILDING, 'Running'], B: [BUILDING, 'Running'] }, { A: 'claude', B: null }, { declared });
    assert.deepEqual(await l.pass(), []);
    assert.ok(!l.f.lines.some(x => /^error /.test(x)), l.f.lines.join('\n'));
  });
}

test('ASS-215 AC1: a refresh whose vm:start prints a kind other than the declared one (its record did not take) is logged under error and backed off, not tried every pass', async () => {
  const l = switched({ A: [BUILDING, 'Running'] }, { A: 'claude' }, { printed: 'claude' });
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A']);
  assert.ok(l.f.lines.some(x => /^error vm p abc-3-a: /.test(x)), l.f.lines.join('\n'));
  l.later(29_000);
  assert.deepEqual(await l.pass(), []);
  l.later(1000);
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A']);
});

// ASS-233: a VM runs only for a variation that holds its seat (plan.js
// planFor) — ex-2280-a and ex-2493-a, waiting for a slot, held 32 of the
// host's 48 GiB. One in-progress slot here (the fixture's harness.json).
const ONE_SEAT = { limits: { 'max-tickets-in-progress': 1 } };
// ASS-314: grouped-review's Human Review is gone; its Payment Gate is the human step a variation waits at there.
const PAYMENT_GATE = at('review', ['grouped-review', 'payment-gate']);

test('ASS-233 AC1, AC3: a variation waiting for a slot has its VM stopped, logged with the reason, and not started; the seat holder\'s runs', async () => {
  const l = lifecycle({ A: [BUILDING, 'Stopped'], B: [BUILDING, 'Running'], C: [BUILDING, 'Stopped'] }, ONE_SEAT);
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A', 'vm:stop p abc-3-b']);
  assert.ok(l.f.lines.includes('vm p abc-3-b: stopped (ABC-3 B at build; waits for a slot)'), l.f.lines.join('\n'));
});

// ASS-418: the seat holder keeps its seat at a human step (ASS-203), but no longer its VM: Payment Gate says vm stopped.
test('ASS-233 AC1, AC3, ASS-418: a seat holder waiting at a human step (ASS-203) keeps its seat, its VM stopped there; the variation behind it waits for the slot without one', async () => {
  const l = lifecycle({ A: [PAYMENT_GATE, 'Running'], B: [BUILDING, 'Running'] }, ONE_SEAT);
  assert.deepEqual(await l.pass(), ['vm:stop p abc-3-a', 'vm:stop p abc-3-b']);
  assert.ok(l.f.lines.includes('vm p abc-3-a: stopped (ABC-3 A at review)'), l.f.lines.join('\n'));
  assert.ok(l.f.lines.includes('vm p abc-3-b: stopped (ABC-3 B at build; waits for a slot)'), l.f.lines.join('\n'));
});

test('ASS-233 AC2, AC3: once the seat holder leaves, the waiting variation\'s VM is started, and its step waits for it (awaitsVm) — not judged while it waits for its slot', async () => {
  const l = await reentering({ A: [PAYMENT_GATE, 'Running'], B: [TESTING, 'Running'] }, ONE_SEAT);
  await l.tick(); await l.settle();
  assert.ok(l.calls.includes('vm:stop p abc-3-b'), l.calls.join('\n'));
  writeFileSync(join(l.v.instances, 'abc-3-b', 'status'), 'Stopped');   // as vm:stop left it
  l.later(VM_WAIT); await l.tick(); await l.tick();
  assert.ok(!l.calls.some(c => c.endsWith(' in abc-3-b')), l.calls.join('\n'));
  l.edit(t => { t.variations[0]['harness-status'] = at('done'); });
  await l.tick();
  assert.ok(l.calls.includes('vm:start p ABC-3 B'), l.calls.join('\n'));
  await l.settle(); await l.tick();
  assert.ok(l.calls.some(c => c.endsWith(' in abc-3-b')), l.calls.join('\n'));
});

// ASS-362 AC5: a finished plan (grouped Plan at done) holds no seat while it waits for one in progress: its VM is stopped
// as one waiting for a slot is, so the queue for Build costs no RAM; it needs none to move on, so once a seat frees it goes.
test('ASS-362 AC5: a finished plan waiting for a build seat has its VM stopped, said so; once a seat frees it moves on to Build without waiting for its VM', async () => {
  const l = await reentering({ A: [PAYMENT_GATE, 'Running'], B: [at('plan', ['grouped-plan', 'done']), 'Running'] }, ONE_SEAT);
  const runs = l.file('assignments.json'), data = JSON.parse(readFileSync(runs, 'utf8'));
  for (const r of data['transient-state-engines']) if (r.parent.variation === 'B') r['is-done'] = true;   // its Plan run over
  writeFileSync(runs, JSON.stringify(data));
  await l.tick(); await l.settle();
  assert.ok(l.calls.includes('vm:stop p abc-3-b'), l.calls.join('\n'));
  assert.ok(l.f.lines.includes('vm p abc-3-b: stopped (ABC-3 B at plan; planned, waits for a build seat)'), l.f.lines.join('\n'));
  const stateOfB = () => l.f.sprint().features[0].variations.find(v => v.name === 'B')['harness-status'].state;
  assert.equal(stateOfB(), 'plan');
  writeFileSync(join(l.v.instances, 'abc-3-b', 'status'), 'Stopped');   // as vm:stop left it
  l.edit(t => { t.variations[0]['harness-status'] = at('done'); });   // A's seat freed
  await l.tick();
  assert.equal(stateOfB(), 'build', l.f.lines.join('\n'));
});

test('ASS-288 AC4: while the disk hold is on (disk-space.json level hold) no VM is started or recreated — said once each — while stops go on; once it lifts they are', async () => {
  const l = lifecycle({
    A: [at('setup', ['grouped-setup', 'mark-setup-complete']), 'Stopped'],
    B: [at('setup', ['grouped-setup', 'mark-setup-complete']), null],                     // deleted to make room
    E: [at('release', ['grouped-release-example', 'team-code-review']), 'Running'],
  });
  const record = level => writeFileSync(l.f.env.DISK_SPACE_FILE, JSON.stringify({ level, 'free-bytes': 1e9, 'warn-bytes': 50e9, 'hold-bytes': 15e9 }));
  record('hold');
  assert.deepEqual(await l.pass(), ['vm:stop p abc-3-e']);
  assert.deepEqual(await l.pass(), ['vm:stop p abc-3-e']);                                // the recorder stops nothing: asked again
  assert.deepEqual(l.f.lines.filter(line => /the disk is nearly full/.test(line)), ['vm p abc-3-a: not started: the disk is nearly full', 'vm p abc-3-b: not recreated: the disk is nearly full']);
  record('ok');
  assert.deepEqual(await l.pass(), ['vm:create p ABC-3 B', 'vm:start p ABC-3 A', 'vm:stop p abc-3-e']);
});

// ASS-297: a human pause of a project (assignments.json pauses: its own scope
// or "all", `human`) holds its VMs too — each running one stopped once no
// assignment is on its variation, none started — so a paused project neither
// keeps its VMs up nor starts again those stopped by hand. An AI pause, self-
// healing and a rate limit are brief holds, and stop none.
const pauseWith = (l, pauses, assignments = [], extra = {}) => {
  const file = l.f.ctx.paths.assignments, data = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...data, pauses, assignments, status: Object.keys(pauses).length ? 'Paused' : 'Running', ...extra }));
};
const HUMAN = { human: { since: '2026-10-24T11:00:00Z' } };
const AI = { ai: { since: '2026-10-24T11:00:00Z', reason: 'rotating a token', eta: '2099-01-01T00:00:00Z', agent: 'Ripley', project: 'p', run: 'hc' } };
const working = variation => ({ 'agent-name': 'Zed', project: 'p', 'work-item': 'ABC-3', variation, 'state-engine': 'grouped-build', state: 'generate-solution', status: 'Starting', 'process-id': null });

for (const scope of ['p', 'all']) {
  test(`ASS-297 AC1, AC4: a human pause on ${scope} stops the project's idle running VMs, logged with the reason, and starts none; the VMs are kept`, async () => {
    const l = lifecycle({ A: [BUILDING, 'Running'], B: [BUILDING, 'Stopped'], C: [at('done'), 'Stopped'] });
    pauseWith(l, { [scope]: HUMAN });
    assert.deepEqual(await l.pass(), ['vm:stop p abc-3-a']);
    const why = scope === 'all' ? 'all projects are paused' : 'p is paused';
    assert.ok(l.f.lines.includes(`vm p abc-3-a: stopped (ABC-3 A at build; ${why})`), l.f.lines.join('\n'));
    writeFileSync(join(l.v.instances, 'abc-3-a', 'status'), 'Stopped');   // as vm:stop left it
    assert.deepEqual(await l.pass(), []);
    assert.equal(l.f.lines.filter(x => /paused\)$/.test(x)).length, 1, l.f.lines.join('\n'));
    assert.ok(!l.calls.some(c => /^vm:(start|create|delete)/.test(c)), l.calls.join('\n'));
  });
}

test('ASS-297 AC1: a paused project\'s VM with an assignment running on its variation is kept until it ends, then stopped; a stopped one with an assignment is not started', async () => {
  const l = lifecycle({ A: [BUILDING, 'Running'], B: [BUILDING, 'Stopped'] });
  pauseWith(l, { p: HUMAN }, [working('A'), working('B')]);
  assert.deepEqual(await l.pass(), []);
  pauseWith(l, { p: HUMAN }, [working('B')]);
  assert.deepEqual(await l.pass(), ['vm:stop p abc-3-a']);
  assert.ok(l.f.lines.includes('vm p abc-3-a: stopped (ABC-3 A at build; p is paused)'), l.f.lines.join('\n'));
});

test('ASS-297 AC1, AC2: no VM started while paused, one stopped by hand included; once the pause is released those due to run are started', async () => {
  const l = lifecycle({ A: [BUILDING, 'Stopped'], B: [at('setup', ['grouped-setup', 'mark-setup-complete']), 'Stopped'], C: [at('done'), 'Stopped'] });
  pauseWith(l, { p: HUMAN });
  assert.deepEqual(await l.pass(), []);
  assert.deepEqual(await l.pass(), []);
  pauseWith(l, {});
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A', 'vm:start p ABC-3 B']);
});

test('ASS-297 AC3: another project\'s human pause, an AI pause (its own or "all") and self-healing stop no VM and hold no start; a rate limit with no API fallback (ASS-400) stops a VM at a prompt step and starts none', async () => {
  for (const [pauses, extra, limited] of [[{ q: HUMAN }], [{ p: AI }], [{ all: AI }], [{}, { 'self-healing': { 'ABC-9': { since: '2026-10-24T11:00:00Z' } } }], [{}, {}, true]]) {
    const l = lifecycle({ A: [BUILDING, 'Running'], B: [BUILDING, 'Stopped'] });
    pauseWith(l, pauses, [], extra);
    if (limited) writeFileSync(l.file('projects', 'p', 'rate-limit.json'), JSON.stringify({ claude: { 'resets-at': '2026-10-24T13:00:00Z' }, anthropic: { 'resets-at': '2026-10-24T13:00:00Z' } }));
    const vmCalls = (await l.pass()).filter(c => c.startsWith('vm:'));
    assert.deepEqual(vmCalls, limited ? ['vm:stop p abc-3-a'] : ['vm:start p ABC-3 B'], JSON.stringify({ pauses, extra, limited }));
  }
});

// ASS-325: a step that sets `vm: released` (here example's QA, which needs no
// VM) has its variation's VM deleted at once — stopped first when running,
// then vm:delete (limactl delete and its vms.json row, as make_room deletes
// one) — so its disk goes back to the project's VM disk budget without
// waiting for a new VM to be short of room. Not while an assignment is on its
// variation, nor for a paused or held variation (stopped only, as today), nor
// a variation at a running or stopped step; golden images never.
const QA = at('qa');
const released = l => {
  const file = l.file('engines', ENGINE, 'state-engine.json'), engine = JSON.parse(readFileSync(file, 'utf8'));
  engine.steps.find(s => s.id === 'qa').vm = 'released';
  writeFileSync(file, JSON.stringify(engine));
  return l;
};

test('ASS-325 AC2: a variation at a vm: released step has its VM stopped (when running) and deleted, logged "deleted (<KEY> <variation> at <step>: released)"; one already gone is left; running and stopped steps\' VMs and golden images are not deleted', async () => {
  const l = released(lifecycle({
    A: [QA, 'Running'],
    B: [QA, 'Stopped'],
    C: [QA, null],                                                // deleted already
    D: [BUILDING, 'Running'],                                     // as it should be
    E: [at('blocked', ['grouped-blocked', 'wait-on']), 'Stopped'],   // kept, stopped
    F: [at('done'), 'Running'],                                   // stopped, kept till room is needed (out of scope)
  }));
  l.v.instance('golden-p', 'Stopped');
  assert.deepEqual(await l.pass(), ['vm:delete p abc-3-a', 'vm:delete p abc-3-b', 'vm:stop p abc-3-a', 'vm:stop p abc-3-f']);
  assert.ok(l.calls.indexOf('vm:stop p abc-3-a') < l.calls.indexOf('vm:delete p abc-3-a'), l.calls.join('\n'));
  assert.ok(l.f.lines.includes('vm p abc-3-a: deleted (ABC-3 A at qa: released)'), l.f.lines.join('\n'));
  assert.ok(l.f.lines.includes('vm p abc-3-b: deleted (ABC-3 B at qa: released)'), l.f.lines.join('\n'));
  assert.ok(!l.calls.some(c => /golden|abc-3-[cde]/.test(c)), l.calls.join('\n'));
});

test('ASS-325 AC2: a released variation\'s VM with an assignment on its variation is left — neither stopped nor deleted — until that ends', async () => {
  const l = released(lifecycle({ A: [QA, 'Running'], B: [QA, 'Stopped'] }));
  pauseWith(l, {}, [working('A'), working('B')]);
  assert.deepEqual(await l.pass(), []);
  pauseWith(l, {}, [working('B')]);
  assert.deepEqual(await l.pass(), ['vm:delete p abc-3-a', 'vm:stop p abc-3-a']);
});

test('ASS-325 AC3: a paused variation or ticket, a ticket worked by hand, and a human pause of the project have a released VM stopped as today, never deleted', async () => {
  for (const [extra, ticket, pauses] of [[{ 'is-paused': true }], [{}, { 'is-paused': true }], [{}, { 'worked-manually': { by: 'alice', since: '2026-10-27T10:00:00Z', note: null } }], [{}, {}, { p: HUMAN }]]) {
    const l = released(lifecycle({ A: [QA, 'Running', extra], B: [QA, 'Stopped', extra] }));
    l.edit(t => Object.assign(t, ticket));
    if (pauses) pauseWith(l, pauses);
    assert.deepEqual(await l.pass(), ['vm:stop p abc-3-a'], JSON.stringify({ extra, ticket, pauses }));
  }
});

test('ASS-325 AC2: a failed delete is logged and retried with the usual backoff, 30 seconds doubling', async () => {
  const l = released(lifecycle({ A: [QA, 'Stopped'] }, { fail: args => args[0] === 'vm:delete' && 'vm:delete: could not delete abc-3-a' }));
  assert.deepEqual(await l.pass(), ['vm:delete p abc-3-a']);
  assert.ok(l.f.lines.includes('error vm p abc-3-a: vm:delete p abc-3-a failed (1 in a row; next try in 30s): vm:delete: could not delete abc-3-a'), l.f.lines.join('\n'));
  l.later(29_000);
  assert.deepEqual(await l.pass(), []);
  l.later(1000);
  assert.deepEqual(await l.pass(), ['vm:delete p abc-3-a']);
  assert.ok(l.f.lines.some(x => /\(2 in a row; next try in 60s\)/.test(x)), l.f.lines.join('\n'));
});

test('ASS-325 AC3: QA → Blocked → Build: the VM deleted at QA is not recreated at Blocked, and is recreated (vm:create) at Build', async () => {
  const l = released(lifecycle({ A: [QA, 'Stopped'] }));
  assert.deepEqual(await l.pass(), ['vm:delete p abc-3-a']);
  rmSync(join(l.v.instances, 'abc-3-a'), { recursive: true });   // as vm:delete left it (agent.sh is a recorder here)
  assert.deepEqual(await l.pass(), []);
  l.edit(t => { t.variations[0]['harness-status'] = at('blocked', ['grouped-blocked', 'wait-on']); });
  assert.deepEqual(await l.pass(), []);
  l.edit(t => { t.variations[0]['harness-status'] = BUILDING; });
  assert.deepEqual(await l.pass(), ['vm:create p ABC-3 A']);
  assert.ok(l.f.lines.includes('vm p abc-3-a: recreated (ABC-3 A at build; it had been deleted)'), l.f.lines.join('\n'));
});
