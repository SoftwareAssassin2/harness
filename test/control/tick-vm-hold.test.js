// ASS-349: a Running VM that should not run — waiting for a slot (ASS-233),
// its ticket gone from the sprint, Done, Blocked or Blocked for Human, its
// variation not linked — is not stopped while an assignment is on its
// variation: its agent is at work in it, and a stop under it kills it (exit
// 255), the step losing an attempt. The stop is logged once as waiting until
// the agent finishes, and made by the first VM job after the assignment ends.
// A paused project's VM (vm.keep, ASS-297) and a released one (ASS-325) are
// left as their own rules say. Driven as tick-vm-lifecycle.test.js: the real
// grouped engines; agent.sh a recorder; limactl a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { superviseVms } from '../../src/control/vm-lifecycle.js';
import { fakeVm } from '../support/fake-vm.js';
import { engineDir, engineNames } from '../support/engine-walk.js';

const ENGINE = 'example-development-grouped';
const at = (state, sub) => ({ state, 'state-engine': ENGINE, ...(sub ? { 'sub-status': { state: sub[1], 'state-engine': sub[0] } } : {}) });
const BUILDING = at('build', ['grouped-build', 'generate-solution']);
const ONE_SEAT = { 'max-tickets-in-progress': 1 };
const HOLDS = /waits until its agent finishes$/;

// p on example-development-grouped, ticket ABC-3's variations as `variations` gives them ({ name: [harness-status, VM
// status or null, extra fields] }), each VM abc-3-<name>; agent.sh calls recorded; harness.json's ticket limits `limits`.
function lifecycle(variations, limits = { 'max-tickets-in-progress': null }) {
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
  f.ctx.now = () => new Date('2026-11-10T14:09:52Z');
  const calls = [];
  f.ctx.cli = async args => { calls.push(args.join(' ')); return ''; };
  const edit = change => { const json = JSON.parse(readFileSync(sprint, 'utf8')); change(json.features[0]); writeFileSync(sprint, JSON.stringify(json)); };
  return {
    f, v, calls, edit, file,
    // assignments.json: these assignments (agents at work, as [ticket, variation]), and these pauses.
    assign: (on, pauses = {}) => {
      const path = f.ctx.paths.assignments, data = JSON.parse(readFileSync(path, 'utf8'));
      data.assignments = on.map(([key, variation]) => ({ 'agent-name': 'Donkey', project: 'p', 'work-item': key, variation, 'state-engine': 'grouped-build', state: 'generate-solution', status: 'Running', 'process-id': 4242 }));
      writeFileSync(path, JSON.stringify({ ...data, pauses, status: Object.keys(pauses).length ? 'Paused' : 'Running' }));
    },
    holds: () => f.lines.filter(line => HOLDS.test(line)),
    // One pass of the phase, its work awaited; the calls it made.
    pass: async () => {
      const before = calls.length;
      await superviseVms(f.ctx, f.ctx.load());
      await Promise.all([...f.ctx.memory.vms.values()].map(r => r.job));
      return calls.slice(before).sort();
    },
  };
}

test('ASS-349 AC1, AC2: a Running VM waiting for a slot with an agent at work in it is not stopped — logged once — and is stopped by the first job after the assignment ends', async () => {
  const l = lifecycle({ A: [BUILDING, 'Stopped'], B: [BUILDING, 'Running'] }, ONE_SEAT);
  l.assign([['ABC-3', 'B']]);
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A']);
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A']);   // the recorder starts nothing: asked again; B still held
  assert.deepEqual(l.holds(), ['vm p abc-3-b: to stop (ABC-3 B at build; waits for a slot); waits until its agent finishes']);
  l.assign([]);
  assert.deepEqual(await l.pass(), ['vm:start p ABC-3 A', 'vm:stop p abc-3-b']);
  assert.ok(l.f.lines.includes('vm p abc-3-b: stopped (ABC-3 B at build; waits for a slot)'), l.f.lines.join('\n'));
  assert.equal(l.holds().length, 1, l.f.lines.join('\n'));
});

test('ASS-349 AC1: a second hold of the same VM, after it ran again, is logged again', async () => {
  const l = lifecycle({ A: [BUILDING, 'Stopped'], B: [BUILDING, 'Running'] }, ONE_SEAT);
  l.assign([['ABC-3', 'B']]);
  await l.pass();
  l.edit(t => { t.variations[0]['harness-status'] = at('done'); });   // A done: B holds the seat and runs
  assert.deepEqual(await l.pass(), []);
  l.edit(t => { t.variations[1]['harness-status'] = at('done'); });   // B done, its agent still at work
  assert.deepEqual(await l.pass(), []);
  assert.deepEqual(l.holds(), [
    'vm p abc-3-b: to stop (ABC-3 B at build; waits for a slot); waits until its agent finishes',
    'vm p abc-3-b: to stop (ABC-3 B at done); waits until its agent finishes',
  ]);
});

test('ASS-349 AC3: Done, Blocked, Blocked for Human, a paused or set-aside variation, a ticket worked by hand — each held while an agent is at work in its VM, then stopped', async () => {
  for (const [status, extra, ticket, why] of [
    [at('done'), {}, {}, 'at done'],
    [at('blocked', ['grouped-blocked', 'wait-on']), {}, {}, 'at blocked'],
    [at('blocked-for-human'), {}, {}, 'at blocked-for-human'],
    [at('release', ['grouped-release-example', 'team-code-review']), {}, {}, 'at release'],
    [BUILDING, { 'is-paused': true }, {}, 'at build'],
    [BUILDING, { 'is-deleted': true }, {}, 'at build'],
    [BUILDING, {}, { 'worked-manually': { by: 'alice', since: '2026-10-27T10:00:00Z', note: null } }, 'at build'],
  ]) {
    const l = lifecycle({ A: [status, 'Running', extra] });
    l.edit(t => Object.assign(t, ticket));
    l.assign([['ABC-3', 'A']]);
    const c = JSON.stringify({ status, extra, ticket });
    assert.deepEqual(await l.pass(), [], c);
    assert.deepEqual(l.holds(), [`vm p abc-3-a: to stop (ABC-3 A ${why}); waits until its agent finishes`], c);
    l.assign([]);
    assert.deepEqual(await l.pass(), ['vm:stop p abc-3-a'], c);
  }
});

test('ASS-349 AC3: a VM only the inventory knows — its ticket gone from the sprint, or not linked to its variation — is held while an agent is at work on that ticket and variation', async () => {
  const l = lifecycle({ A: [at('setup', ['grouped-setup', 'create-vm']), 'Running'] });
  l.edit(t => { delete t.variations[0].vm; });
  l.v.instance('abc-1-a', 'Running');
  writeFileSync(l.file('projects', 'p', 'vms.json'), JSON.stringify({
    'abc-1-a': { ticket: 'ABC-1', variation: 'A', state: 'Running', 'disk-bytes': 0, 'last-accessed': '2026-10-01T00:00:00Z' },
    'abc-3-a': { ticket: 'ABC-3', variation: 'A', state: 'Running', 'disk-bytes': 0, 'last-accessed': '2026-10-01T00:00:00Z' },
  }));
  l.assign([['ABC-1', 'A'], ['ABC-3', 'A']]);
  assert.deepEqual(await l.pass(), []);
  assert.deepEqual(l.holds().sort(), [
    'vm p abc-1-a: to stop (ABC-1 A is not in the sprint); waits until its agent finishes',
    'vm p abc-3-a: to stop (ABC-3 A not linked to its variation); waits until its agent finishes',
  ]);
  l.assign([['ABC-1', 'B']]);   // another variation's agent does not hold it
  assert.deepEqual(await l.pass(), ['vm:stop p abc-1-a', 'vm:stop p abc-3-a']);
});

test('ASS-349 AC3: precedence — a paused project\'s busy VM is kept as ASS-297 says, a released busy VM left as ASS-325 says; neither logged as a held stop, and each goes its own way once idle', async () => {
  const l = lifecycle({ A: [BUILDING, 'Running'] });
  l.assign([['ABC-3', 'A']], { p: { human: { since: '2026-11-10T14:00:00Z' } } });
  assert.deepEqual(await l.pass(), []);
  l.assign([], { p: { human: { since: '2026-11-10T14:00:00Z' } } });
  assert.deepEqual(await l.pass(), ['vm:stop p abc-3-a']);
  assert.ok(l.f.lines.includes('vm p abc-3-a: stopped (ABC-3 A at build; p is paused)'), l.f.lines.join('\n'));

  const r = lifecycle({ A: [at('qa'), 'Running'] });
  const engine = r.file('engines', ENGINE, 'state-engine.json'), json = JSON.parse(readFileSync(engine, 'utf8'));
  json.steps.find(s => s.id === 'qa').vm = 'released';
  writeFileSync(engine, JSON.stringify(json));
  r.assign([['ABC-3', 'A']]);
  assert.deepEqual(await r.pass(), []);
  r.assign([]);
  assert.deepEqual(await r.pass(), ['vm:delete p abc-3-a', 'vm:stop p abc-3-a']);
  assert.deepEqual([...l.holds(), ...r.holds()], []);
});
