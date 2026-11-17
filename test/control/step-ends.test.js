// ASS-480: a step's end always runs on the machine it ran on. A VM a step's
// end is pending on (step-ends.json, or a lease in vm) is kept running —
// started when stopped, never stopped, deleted or recreated — until that end
// has succeeded, logged (AC1); a pending end whose VM is gone is dropped once,
// logged as an error naming the step and the plan's repositories and
// branches, and shown on its variation's Health until a later step ends
// cleanly (AC2); a stray branch a step's end set aside is reported on the
// Health of the ticket it belongs to, not the releasing one (AC3); a step
// waiting for its VM says so, never "Waiting for its workstation" (AC5); and
// the migration takes up the VM step ends a control before ASS-480 left
// failing, from its log. The VM lifecycle with fake-limactl and agent.sh a
// recorder; tendSteps with agent.sh a recorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { superviseVms } from '../../src/control/vm-lifecycle.js';
import { tendSteps, LOST_HEALTH, STRAY_HEALTH, ownerOf } from '../../src/control/workstation-steps.js';
import { healthOf } from '../../src/control/workstations.js';
import { loadEnds, recover, STEP_ENDS_FILE } from '../../src/control/step-ends.js';
import { fakeVm } from '../support/fake-vm.js';

const PLAN = [{ id: 1, repository: 'https://gitlab.example.com/o/example-api.git', branch: 'change/ABC-3-1', status: 'Open' }, { id: 2, repository: 'https://gitlab.example.com/o/example-web', branch: 'change/ABC-3-2', status: 'Merged' }];

// Project p: ABC-3 A at `state` (plan: a `vm: running` step; qa: a `vm: released` one; done: none), its VM abc-3-a in `status` (null: none);
// ABC-9 A beside it; agent.sh a recorder answering answer(args); HARNESS_HOME a folder of its own.
function fixture({ state = 'done', status = 'Stopped', answer = () => '{}' } = {}) {
  const c = controlFixture();
  const file = (...rest) => join(c.dir, ...rest);
  const engine = JSON.parse(readFileSync(file('engines', 'example-development', 'state-engine.json'), 'utf8'));
  engine.steps.find(x => x.id === 'plan').vm = 'running';
  engine.steps.push({ id: 'qa', sequence: 7, vm: 'released', 'paired-ticket-system-status': 'QA', action: { type: 'human' } });
  writeFileSync(file('engines', 'example-development', 'state-engine.json'), JSON.stringify(engine));
  const v = fakeVm(c.env);
  if (status) v.instance('abc-3-a', status);
  writeFileSync(file('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ number: 10, bugs: [], spikes: [], features: [
    { key: 'ABC-3', 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'example-development' }, 'state-changes': [], vm: { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-11-16T00:00:00Z' }, 'merge-request': PLAN }] },
    { key: 'ABC-9', 'ticket-system-status': 'In Progress', variations: [{ name: 'A', 'harness-status': { state: 'done', 'state-engine': 'example-development' }, 'state-changes': [] }] },
  ] }));
  const home = file('harness-home');
  mkdirSync(join(home, 'logs'), { recursive: true });
  c.ctx.env = { ...v.env, HARNESS_HOME: home };
  let now = Date.parse('2026-11-16T23:00:00Z');
  c.ctx.now = () => new Date(now);
  const calls = [];
  c.ctx.cli = async args => { calls.push(args.join(' ')); return answer(args); };
  const dir = file('projects', 'p');
  const project = () => c.ctx.load().projects.find(p => p.id === 'p');
  const pend = ends => writeFileSync(join(dir, STEP_ENDS_FILE), JSON.stringify({ ends, recovered: '2026-11-16T00:00:00Z' }));
  const health = [];
  return {
    c, v, calls, dir, home, pend, health, project,
    later: ms => { now += ms; },
    vmPass: async () => {
      const before = calls.length;
      await superviseVms(c.ctx, c.ctx.load());
      await Promise.all([...c.ctx.memory.vms.values()].map(r => r.job));
      return calls.slice(before).sort();
    },
    tend: async () => {
      const before = calls.length;
      await tendSteps(c.ctx, project(), { workstations: [] }, dir, (t, v2, why, kind) => { health.push([`${t.key} ${v2.name}`, why, kind]); });
      return calls.slice(before);
    },
    log: () => c.lines.join('\n'),
  };
}
const ABC3 = { 'ABC-3 A': { key: 'ABC-3', variation: 'A', vm: 'abc-3-a', step: 'Add Screenshots', completed: true, since: '2026-11-16T22:00:00Z' } };

test('AC1: a stopped VM a step\'s end is pending on is started for it, though its step would keep it stopped, logged once; once the end has run there its step\'s rules apply again', async () => {
  const s = fixture({ state: 'done', status: 'Stopped' });
  s.pend(ABC3);
  assert.deepEqual(await s.vmPass(), ['vm:start p ABC-3 A']);
  assert.ok(s.c.lines.includes('vm p abc-3-a: kept and started for ABC-3 A\'s step end ("Add Screenshots"), pending on it: not stopped or deleted until it has run there (ABC-3 A at done)'), s.log());
  assert.ok(s.c.lines.includes('vm p abc-3-a: started (ABC-3 A at done; for its step\'s end, pending on it)'), s.log());
  // vm:start is a recorder here: the VM up as the start would leave it. The end runs there, and the record goes.
  writeFileSync(join(s.v.instances, 'abc-3-a', 'status'), 'Running');
  assert.deepEqual(await s.vmPass(), []);
  assert.equal(s.c.lines.filter(l => /kept and started for ABC-3 A/.test(l)).length + s.c.lines.filter(l => /: kept for ABC-3 A/.test(l)).length, 1, 'logged once');
  s.c.ctx.memory.vmsUp.add('abc-3-a');
  const answer = '{"pushed":[{"repository":"example-api","branch":"change/ABC-3-1","commits":2}],"push-failed":[],"committed":[],"discarded":[],"master-reset":[],"unclean":[],"set-aside":[]}';
  s.c.ctx.cli = async args => { s.calls.push(args.join(' ')); return args[0] === 'vm:step-end' ? answer : '{}'; };
  assert.deepEqual(await s.tend(), ['vm:step-end p ABC-3 A --completed Add Screenshots']);
  assert.deepEqual(loadEnds(s.dir).ends, {});
  assert.ok(s.c.lines.includes('workstation ABC-3 A: its step ended on its VM: pushed example-api change/ABC-3-1 (2); its repositories back on master'), s.log());
  assert.deepEqual(await s.vmPass(), ['vm:stop p abc-3-a'], 'its step\'s rules again: stopped at done');
});

test('AC1: a VM at a `vm: released` step (QA) is neither stopped nor deleted while a step\'s end is pending on it, nor while a lease in vm holds it; deleted once the end has succeeded', async () => {
  const s = fixture({ state: 'qa', status: 'Running' });
  s.pend(ABC3);
  assert.deepEqual(await s.vmPass(), []);
  assert.ok(s.c.lines.includes('vm p abc-3-a: kept for ABC-3 A\'s step end ("Add Screenshots"), pending on it: not stopped or deleted until it has run there (ABC-3 A at qa)'), s.log());
  // The record gone but a lease still in vm (its step mid-run): still kept.
  s.pend({});
  s.c.ctx.memory.workstationSteps = new Map([['p/ABC-3/A', { project: 'p', key: 'ABC-3', variation: 'A', state: 'vm', vm: 'abc-3-a', step: 'Add Screenshots', scripts: new Set(), dispatching: 0 }]]);
  assert.deepEqual(await s.vmPass(), []);
  s.c.ctx.memory.workstationSteps = new Map();
  assert.deepEqual(await s.vmPass(), ['vm:delete p abc-3-a', 'vm:stop p abc-3-a']);
  assert.ok(s.c.lines.includes('vm p abc-3-a: deleted (ABC-3 A at qa: released)'), s.log());
});

test('AC1: a VM gone with a step\'s end pending on it is not recreated for it; the end is dropped (AC2), and the VM then recreated as its step says', async () => {
  const s = fixture({ state: 'plan', status: null });
  s.pend(ABC3);
  assert.deepEqual(await s.vmPass(), [], 'not recreated while its end is pending');
  assert.ok(!(await s.tend()).some(x => x.startsWith('vm:step-end')), 'no vm:step-end against a VM that is gone');
  assert.deepEqual(loadEnds(s.dir).ends, {});
  assert.deepEqual(await s.vmPass(), ['vm:create p ABC-3 A'], 'at plan its step wants it: recreated');
});

test('AC2: a pending end whose VM is gone is dropped once — an error naming the step and the plan\'s repositories and branches, on its Health — never retried; a later step\'s clean end clears the Health', async () => {
  const s = fixture({ state: 'qa', status: null });
  s.pend(ABC3);
  await s.vmPass();   // limactl list read: abc-3-a is not there
  const calls = await s.tend();
  assert.equal(calls.length, 1, calls.join('\n'));
  const errors = s.c.lines.filter(l => /could not run: its VM abc-3-a is gone/.test(l));
  assert.deepEqual(errors, ['error workstation ABC-3 A: the end of its step "Add Screenshots" could not run: its VM abc-3-a is gone (deleted before the end ran); any commits that step had not pushed were lost with it (its plan\'s repositories and branches: example-api change/ABC-3-1); the pending end is dropped'], s.log());
  assert.match(calls[0], /^ticket:set-ai-feedback p ABC-3 A Step end lost with its VM abc-3-a/);
  assert.ok(calls[0].includes(`${LOST_HEALTH} the end of its step "Add Screenshots"`), calls[0]);
  assert.deepEqual(loadEnds(s.dir).ends, {});
  assert.equal(s.c.ctx.memory.workstationSteps.size, 0, 'its lease gone');
  s.later(60 * 60_000);
  assert.deepEqual(await s.tend(), [], 'never retried');
  assert.equal(s.c.lines.filter(l => /could not run: its VM abc-3-a is gone/.test(l)).length, 1);
});

test('AC2: the Health a lost end left is cleared by a later step\'s clean end on its machine; a step end with a push that failed keeps it', async () => {
  const s = fixture({ state: 'plan', status: 'Running' });
  const long = `${LOST_HEALTH} the end of its step "Add Screenshots" never ran.`;
  const edit = change => { const f = join(s.c.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp = JSON.parse(readFileSync(f, 'utf8')); change(sp.features[0].variations[0]); writeFileSync(f, JSON.stringify(sp)); };
  edit(v => { v['ai-feedback-long'] = long; });
  s.c.ctx.memory.vmsUp = new Set(['abc-3-a']);
  const out = failed => JSON.stringify({ pushed: [], 'push-failed': failed ? [{ repository: 'example-api', branch: 'change/ABC-3-1', why: 'rejected' }] : [], committed: [], discarded: [], 'master-reset': [], unclean: [], 'set-aside': [] });
  for (const failed of [true, false]) {
    s.c.ctx.cli = async args => { s.calls.push(args.join(' ')); return args[0] === 'vm:step-end' ? out(failed) : '{}'; };
    s.c.ctx.memory.workstationSteps = new Map([['p/ABC-3/A', { project: 'p', key: 'ABC-3', variation: 'A', state: 'vm', vm: 'abc-3-a', step: 'Build', used: true, scripts: new Set(), dispatching: 0, failures: 0, until: 0 }]]);
    const calls = await s.tend();
    assert.equal(calls.some(x => x.startsWith('ticket:clear-ai-feedback p ABC-3 A') && x.includes(LOST_HEALTH)), !failed, calls.join('\n'));
  }
});

test('AC3: a stray branch a step\'s end set aside is reported — logged, and on the Health of the ticket it belongs to, never the releasing one\'s', async () => {
  const s = fixture({ state: 'plan', status: 'Running' });
  s.c.ctx.memory.vmsUp = new Set(['abc-3-a']);
  const ref = 'refs/harness/stray/change/ABC-9-1/20261116T230000Z';
  s.c.ctx.cli = async args => { s.calls.push(args.join(' ')); return args[0] === 'vm:step-end' ? JSON.stringify({ pushed: [{ repository: 'example-api', branch: 'change/ABC-3-1', commits: 1 }], 'push-failed': [], committed: [], discarded: [], 'master-reset': [], unclean: [], 'set-aside': [{ repository: 'example-corpus', branch: 'change/ABC-9-1', ref, commits: 2, why: 'not this ticket variation\'s branch' }] }) : '{}'; };
  s.c.ctx.memory.workstationSteps = new Map([['p/ABC-3/A', { project: 'p', key: 'ABC-3', variation: 'A', state: 'vm', vm: 'abc-3-a', step: 'Build', used: true, scripts: new Set(), dispatching: 0, failures: 0, until: 0 }]]);
  const calls = await s.tend();
  assert.ok(s.c.lines.includes(`error workstation ABC-3 A's step end: set aside example-corpus change/ABC-9-1, 2 commit(s) GitLab lacks, under ${ref} (not this ticket variation's branch); never pushed, its local branch deleted so it is checked out fresh from GitLab; it is ABC-9 A's`), s.log());
  const set = calls.filter(x => x.startsWith('ticket:set-ai-feedback'));
  assert.equal(set.length, 1, calls.join('\n'));
  assert.match(set[0], /^ticket:set-ai-feedback p ABC-9 A Stray commits set aside: example-corpus change\/ABC-9-1/);
  assert.ok(set[0].includes(`${STRAY_HEALTH} example-corpus change/ABC-9-1 (2 commit(s), kept under ${ref}), found by ABC-3 A's step`), set[0]);
  assert.deepEqual([ownerOf('change/ABC-9-1'), ownerOf('change/ABC-9.B-12'), ownerOf('feature/x')], [{ key: 'ABC-9', variation: 'A' }, { key: 'ABC-9', variation: 'B' }, null]);
});

test('AC5: a step waiting for its VM to be made — a planning step\'s in vm+workstation mode — says "Waiting for its VM", never "Waiting for its workstation"', async () => {
  const s = fixture({ state: 'plan', status: null });
  const f = join(s.c.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sp = JSON.parse(readFileSync(f, 'utf8'));
  delete sp.features[0].variations[0].vm;
  writeFileSync(f, JSON.stringify(sp));
  s.c.ctx.memory.workstationSteps = new Map([['p/ABC-3/A', { project: 'p', key: 'ABC-3', variation: 'A', state: 'vm-wanted', want: '0', wantedAt: Date.parse('2026-11-16T23:00:00Z'), who: 'ABC-3 A plan', step: 'Plan', scripts: new Set(), dispatching: 0, failures: 0, until: 0 }]]);
  assert.deepEqual(await s.tend(), ['vm:create p ABC-3 A --vm']);
  assert.deepEqual(s.health, [['ABC-3 A', 'it is being made for its step', 'vm']]);
  const h = healthOf('it is being made for its step', 'vm');
  assert.equal(h.short, 'Waiting for its VM: it is being made for its step');
  assert.ok(h.long.startsWith('Waiting for its VM: it is being made for its step.') && !/workstation/.test(h.long), h.long);
  assert.match(healthOf('ada-dev is starting').short, /^Waiting for its workstation: /, 'a workstation\'s wait unchanged');
});

test('the migration: at the first start, the VM step ends the old control\'s log shows failing and never succeeding are taken up again — one whose VM is gone dropped as AC2 says, one ended since left — once', async () => {
  const s = fixture({ state: 'qa', status: null });
  const fail = (key, step) => `2026-11-16T23:54:16.484Z  2026-11-16T23:54:16.415Z error workstation ${key} A: ending its step on its VM failed (8 in a row; next try in 30m): agent.sh vm:step-end p ${key} A --completed "${step}": vm:step-end: ${key.toLowerCase()}-a is not running`;
  writeFileSync(join(s.home, 'logs', 'control-p.log'), [
    fail('ABC-3', 'Add Screenshots'),
    fail('ABC-9', 'Build'),
    '2026-11-16T23:56:04.691Z  2026-11-16T23:56:04.691Z workstation ABC-9 A: its step ended on its VM: nothing to push; its repositories back on master',
    fail('XYZ-1', 'Other').replace('vm:step-end p XYZ-1', 'vm:step-end q XYZ-1'),   // another project's
    '',
  ].join('\n'));
  assert.equal(recover(s.c.ctx, s.project(), s.dir), 1);
  assert.deepEqual(Object.keys(loadEnds(s.dir).ends), ['ABC-3 A']);
  assert.equal(loadEnds(s.dir).ends['ABC-3 A'].vm, 'abc-3-a');
  assert.equal(recover(s.c.ctx, s.project(), s.dir), 0, 'once');
  await s.vmPass();
  await s.tend();
  assert.ok(s.c.lines.some(l => /^error workstation ABC-3 A: the end of its step "Add Screenshots" could not run: its VM abc-3-a is gone/.test(l)), s.log());
  assert.deepEqual(loadEnds(s.dir).ends, {});
  assert.ok(existsSync(join(s.dir, STEP_ENDS_FILE)) && loadEnds(s.dir).recovered, 'marked done');
});

test('a pending end recorded before control restarted is taken up as a lease: it waits, uncounted, for its stopped VM to be up, then runs there', async () => {
  const s = fixture({ state: 'done', status: 'Stopped' });
  s.pend(ABC3);
  await s.vmPass();
  s.c.ctx.cli = async args => { s.calls.push(args.join(' ')); return args[0] === 'vm:step-end' ? '{"pushed":[],"push-failed":[],"committed":[],"discarded":[],"master-reset":[],"unclean":[],"set-aside":[]}' : '{}'; };
  s.c.ctx.memory.vmsUp = new Set();
  assert.deepEqual(await s.tend(), [], 'waits for its VM');
  assert.ok(s.c.lines.includes('workstation ABC-3 A: its step "Add Screenshots"\'s end is pending on its VM abc-3-a (since 2026-11-16T22:00:00Z): it runs there before anything else of it does'), s.log());
  assert.ok(s.c.lines.includes('workstation ABC-3 A: its step\'s end waits for its VM abc-3-a to be up (the VM lifecycle starts it for the end)'), s.log());
  assert.equal(s.c.ctx.memory.workstationSteps.get('p/ABC-3/A').failures, 0, 'no failure counted');
  s.c.ctx.memory.vmsUp.add('abc-3-a');
  assert.deepEqual(await s.tend(), ['vm:step-end p ABC-3 A --completed Add Screenshots']);
  assert.deepEqual(loadEnds(s.dir).ends, {});
});
