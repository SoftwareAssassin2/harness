// ASS-400: while a project's Claude kind is rate limited with no API fallback
// for a variation's next agent (state.js payWith, the rule dispatch.js
// paymentFor uses), the VM of each variation at a prompt step is stopped —
// one with an assignment on it left till that ends (ASS-349) — its variation
// waits as for a slot (awaitsVm), its health says it waits on the rate limit,
// and it is dropped from the memory hold's VMs. A script step in the VM and a
// human step keep their VM as their `vm` says. Once the limit resets, or a
// fallback is there, the VM is started again and the health cleared. Driven
// as tick-vm-hold.test.js: the real grouped engines; agent.sh a recorder;
// limactl a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { superviseVms, awaitsVm, rateLimitStop } from '../../src/control/vm-lifecycle.js';
import { payWith } from '../../src/control/state.js';
import { fakeVm } from '../support/fake-vm.js';
import { engineDir, engineNames } from '../support/engine-walk.js';

const ENGINE = 'example-development-grouped';
const at = (state, sub) => ({ state, 'state-engine': ENGINE, ...(sub ? { 'sub-status': { state: sub[1], 'state-engine': sub[0] } } : {}) });
const BUILDING = at('build', ['grouped-build', 'generate-solution']);   // a prompt step in the VM
const TESTING = at('build', ['grouped-build', 'automated-testing']);   // a script step in the VM
const ANSWERING = at('plan', ['grouped-plan', 'awaiting-plan-answer']);   // a human step
const RESETS = '2026-11-15T03:00:00Z';
const SUBSCRIPTION = { claude: { since: '2026-11-12T10:00:00Z', type: 'seven_day', 'resets-at': RESETS } };
const STOPPED = `vm p abc-3-a: stopped (ABC-3 A at build; rate-limited until ${RESETS}, no API fallback)`;

// p on example-development-grouped, ticket ABC-3's variations as `variations` gives them ({ name: [harness-status, VM
// status, extra fields] }), each VM abc-3-<name>; its rate-limit.json `limits`; agent.sh calls recorded.
function lifecycle(variations, limits = SUBSCRIPTION) {
  const f = controlFixture();
  const file = (...rest) => join(f.dir, ...rest);
  writeFileSync(file('harness.json'), JSON.stringify({ ...JSON.parse(readFileSync(file('harness.json'), 'utf8')), 'max-tickets-in-progress': null }));
  for (const name of engineNames()) if (!existsSync(file('engines', name)) && existsSync(join(engineDir(name), 'state-engine.json'))) cpSync(engineDir(name), file('engines', name), { recursive: true });
  const project = file('projects', 'p', 'project.json');
  writeFileSync(project, JSON.stringify({ ...JSON.parse(readFileSync(project, 'utf8')), 'execution-state-engine': ENGINE }));
  if (limits) writeFileSync(file('projects', 'p', 'rate-limit.json'), JSON.stringify(limits));
  const v = fakeVm(f.env);
  const sprint = file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  writeFileSync(sprint, JSON.stringify({ number: 10, bugs: [], spikes: [], features: [{ key: 'ABC-3', 'ticket-system-status': 'In Progress', variations: Object.entries(variations).map(([name, [status, vm, extra]]) => {
    v.instance(`abc-3-${name.toLowerCase()}`, vm);
    return { name, 'harness-status': status, 'state-changes': [], vm: { name: `abc-3-${name.toLowerCase()}`, ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' }, ...extra };
  }) }] }));
  const home = file('harness-home');
  mkdirSync(home, { recursive: true });
  f.ctx.env = { ...v.env, HARNESS_HOME: home };
  f.ctx.now = () => new Date('2026-11-12T14:00:00Z');
  const calls = [];
  f.ctx.cli = async args => { calls.push(args); return ''; };
  const edit = change => { const json = JSON.parse(readFileSync(sprint, 'utf8')); change(json.features[0]); writeFileSync(sprint, JSON.stringify(json)); };
  return {
    f, v, calls, edit, file,
    // vms.json: each VM's credential kind.
    kinds: kinds => writeFileSync(file('projects', 'p', 'vms.json'), JSON.stringify(Object.fromEntries(Object.entries(kinds).map(([name, kind]) => [name, { ticket: 'ABC-3', variation: name.slice(-1).toUpperCase(), state: 'Running', 'credential-kind': kind }])))),
    projectJson: extra => writeFileSync(project, JSON.stringify({ ...JSON.parse(readFileSync(project, 'utf8')), ...extra })),
    assign: on => {
      const path = f.ctx.paths.assignments, data = JSON.parse(readFileSync(path, 'utf8'));
      data.assignments = on.map(([key, variation]) => ({ 'agent-name': 'Donkey', project: 'p', 'work-item': key, variation, 'state-engine': 'grouped-build', state: 'generate-solution', status: 'Running', 'process-id': 4242 }));
      writeFileSync(path, JSON.stringify(data));
    },
    // One pass of the phase, its work awaited; the VM calls it made (vm:…), and the rest (the health's).
    pass: async () => {
      const before = calls.length;
      await superviseVms(f.ctx, f.ctx.load());
      await Promise.all([...f.ctx.memory.vms.values()].map(r => r.job));
      const made = calls.slice(before);
      return { vm: made.filter(c => c[0].startsWith('vm:')).map(c => c.join(' ')).sort(), health: made.filter(c => !c[0].startsWith('vm:')) };
    },
  };
}

test('ASS-400: payWith is dispatch\'s billing rule — one credential waits while its kind (or, unrecorded, any) is held; both pay api while only claude is held, wait with the API key held or a cap', () => {
  assert.deepEqual(payWith({ held: [], kind: 'claude' }), { payment: null });
  assert.equal(payWith({ held: ['claude'], kind: 'claude' }), null);
  assert.deepEqual(payWith({ held: ['anthropic'], kind: 'claude' }), { payment: null });
  assert.equal(payWith({ held: ['anthropic'], kind: null }), null);
  assert.equal(payWith({ held: [], kind: 'claude', weekly: true }), null);
  assert.deepEqual(payWith({ held: [], both: true }), { payment: 'subscription' });
  assert.deepEqual(payWith({ held: ['claude'], both: true }), { payment: 'api' });
  assert.equal(payWith({ held: ['claude', 'anthropic'], both: true }), null);
  assert.equal(payWith({ held: ['claude'], both: true, capHold: { cap: 'day' } }), null);
  assert.deepEqual(payWith({ held: [], both: true, weekly: true }), { payment: 'api' });
});

test('ASS-400 AC1: a Running VM at a prompt step, its project rate-limited with no API fallback, is stopped, logged with why once; its health says it waits on the rate limit; its variation waits as for a slot', async () => {
  const l = lifecycle({ A: [BUILDING, 'Running'] });
  l.kinds({ 'abc-3-a': 'claude' });
  const first = await l.pass();
  assert.deepEqual(first.vm, ['vm:stop p abc-3-a']);
  assert.deepEqual(first.health.map(c => c.slice(0, 5)), [['ticket:set-ai-feedback', 'p', 'ABC-3', 'A', 'Waiting for the rate limit to reset at 2026-11-15 03:00 UTC (no API fallback)']]);
  assert.match(first.health[0][5], /^Waiting on the rate limit: ABC-3's next step needs an agent, and p's Claude subscription is rate limited until 2026-11-15 03:00 UTC with no API fallback: its VM holds no API key\. .*Nothing for you to do\.$/);
  assert.deepEqual(l.f.lines.filter(line => line.includes('rate-limited')), [STOPPED]);
  // Stopped now, with its health written: nothing more done or said.
  l.v.instance('abc-3-a', 'Stopped');
  l.edit(t => { t.variations[0]['ai-feedback-short'] = first.health[0][4]; t.variations[0]['ai-feedback-long'] = first.health[0][5]; });
  assert.deepEqual(await l.pass(), { vm: [], health: [] });
  assert.deepEqual(l.f.lines.filter(line => line.includes('rate-limited')), [STOPPED]);
  const state = l.f.ctx.load(), project = state.projects.find(p => p.id === 'p'), variation = project.tickets[0].variations[0];
  assert.equal(awaitsVm(l.f.ctx, state, project, variation, 'ABC-3 A build'), true);
  assert.ok(!l.f.lines.some(line => line.includes('waits for its VM')), l.f.lines.join('\n'));   // no VM_WAIT: never judged as down, never Blocked for it
});

test('ASS-400 AC1: no API fallback — a VM recording no kind, an API cap holding a VM with both, or its API key limited too — each stopped; a VM with both and the key free is not', async () => {
  for (const [kind, limits, json, until, why] of [
    [null, SUBSCRIPTION, {}, RESETS, 'its VM records no credential kind'],
    ['both', SUBSCRIPTION, { 'api-cap-hold': { cap: 'day', 'spend-usd': 51, 'limit-usd': 50 } }, RESETS, 'the API day cap holds it'],
    ['both', { ...SUBSCRIPTION, anthropic: { type: 'unknown', 'resets-at': '2026-11-12T18:00:00Z' } }, {}, '2026-11-12T18:00:00Z', 'the API key is rate limited too'],
  ]) {
    const l = lifecycle({ A: [BUILDING, 'Running'] }, limits);
    if (kind) l.kinds({ 'abc-3-a': kind });
    l.projectJson(json);
    const c = JSON.stringify({ kind, limits, json });
    assert.deepEqual((await l.pass()).vm, ['vm:stop p abc-3-a'], c);
    assert.ok(l.f.lines.includes(`vm p abc-3-a: stopped (ABC-3 A at build; rate-limited until ${until}, no API fallback)`), `${c}\n${l.f.lines.join('\n')}`);
    const state = l.f.ctx.load(), project = state.projects.find(p => p.id === 'p');
    assert.match(rateLimitStop(l.f.ctx, state, project, project.tickets[0].variations[0]).why, new RegExp(`^${why}`), c);
  }
  const l = lifecycle({ A: [BUILDING, 'Running'] });
  l.kinds({ 'abc-3-a': 'both' });
  assert.deepEqual(await l.pass(), { vm: [], health: [] });
});

test('ASS-400 AC2: a VM with its agent at work is left till the agent ends (ASS-349), its health unwritten meanwhile; a script step in the VM and a human step keep theirs', async () => {
  const l = lifecycle({ A: [BUILDING, 'Running'], B: [TESTING, 'Running'], C: [ANSWERING, 'Running'] });
  l.kinds({ 'abc-3-a': 'claude', 'abc-3-b': 'claude', 'abc-3-c': 'claude' });
  l.assign([['ABC-3', 'A']]);
  assert.deepEqual(await l.pass(), { vm: [], health: [] });
  assert.ok(l.f.lines.includes(`vm p abc-3-a: to stop (ABC-3 A at build; rate-limited until ${RESETS}, no API fallback); waits until its agent finishes`), l.f.lines.join('\n'));
  l.assign([]);
  const next = await l.pass();
  assert.deepEqual(next.vm, ['vm:stop p abc-3-a']);
  assert.deepEqual(next.health.map(c => c.slice(0, 4)), [['ticket:set-ai-feedback', 'p', 'ABC-3', 'A']]);
});

test('ASS-400 AC3: once the limit resets, or a fallback is there, the stopped VM is started again and the health control wrote cleared; nothing else moves', async () => {
  for (const lift of ['reset', 'fallback']) {
    const l = lifecycle({ A: [BUILDING, 'Stopped'] });
    l.kinds({ 'abc-3-a': 'claude' });
    const first = await l.pass();
    assert.deepEqual(first.vm, [], lift);
    assert.ok(l.f.lines.includes(`vm p abc-3-a: stays stopped (ABC-3 A at build; rate-limited until ${RESETS}, no API fallback)`), l.f.lines.join('\n'));
    const long = first.health[0][5];
    l.edit(t => { t.variations[0]['ai-feedback-short'] = first.health[0][4]; t.variations[0]['ai-feedback-long'] = long; });
    if (lift === 'reset') l.f.ctx.now = () => new Date('2026-11-15T03:00:01Z');
    else l.kinds({ 'abc-3-a': 'both' });
    const after = await l.pass();
    assert.deepEqual(after.vm, ['vm:start p ABC-3 A'], lift);
    assert.deepEqual(after.health, [['ticket:clear-ai-feedback', 'p', 'ABC-3', 'A', long]], lift);
    assert.ok(!l.calls.some(c => /^ticket:(move|change-state|change-sub-state)/.test(c[0])), lift);
  }
});

test('ASS-400 AC4: a VM stopped for the rate limit is dropped from the memory hold\'s VMs and never started for it', async () => {
  const l = lifecycle({ A: [BUILDING, 'Stopped'] });
  l.kinds({ 'abc-3-a': 'claude' });
  l.f.ctx.availableMemory = async () => 0;
  l.f.ctx.memory.memoryHolds = new Map([['p', { since: 0, need: 1, available: 0, first: 'abc-3-a', vms: new Set(['abc-3-a']) }]]);
  assert.deepEqual((await l.pass()).vm, []);
  assert.deepEqual([...l.f.ctx.memory.memoryHolds.get('p').vms], []);
});

test('ASS-400: ticket:clear-ai-feedback clears a variation\'s health only while it is still the one given', async () => {
  const f = controlFixture();
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  writeFileSync(sprint, JSON.stringify({ number: 10, bugs: [], spikes: [], features: [{ key: 'ABC-3', variations: [{ name: 'A', 'ai-feedback-short': 's', 'ai-feedback-long': 'mine' }, { name: 'B', 'ai-feedback-short': 's', 'ai-feedback-long': 'other' }] }] }));
  await f.ctx.cli(['ticket:clear-ai-feedback', 'p', 'ABC-3', 'A', 'mine']);
  await f.ctx.cli(['ticket:clear-ai-feedback', 'p', 'ABC-3', 'B', 'mine']);
  const [a, b] = JSON.parse(readFileSync(sprint, 'utf8')).features[0].variations;
  assert.deepEqual([a['ai-feedback-short'], a['ai-feedback-long'], b['ai-feedback-long']], [null, null, 'other']);
  await assert.rejects(f.ctx.cli(['ticket:clear-ai-feedback', 'p', 'ABC-3', 'C', 'mine']), /no ABC-3 variation C/);
});
