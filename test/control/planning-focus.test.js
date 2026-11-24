// ASS-531: the focus-on-planning switch — project:set-planning-focus <project> on|off, kept in
// data/projects/<p>/planning-focus.json (planning-focus-file.js). While it is on, control ranks every variation at a
// planning step ahead of every other when giving seats and dispatching agents (plan.js planDispatch, sprintOrder;
// dispatch.js runOrder), rank order within each group, nothing running cut off, and max-tickets-ready-for-build does
// not hold planning back; off, ranking is exactly as without it. Read every tick: no restart either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planDispatch, planFor, sprintOrder, atPlanningStep } from '../../src/control/plan.js';
import { planningFirst, rankSprint } from '../../src/control/rank.js';
import { runOrder } from '../../src/control/dispatch.js';
import { statusIn } from '../../src/control/engine.js';
import { loadPlanningFocus, planningFocusOn, PLANNING_FOCUS_FILE } from '../../src/control/planning-focus-file.js';
import { seatQueue } from '../../src/control/seat-queue.js';
import { runSteps } from '../../src/control/steps.js';
import { controlFixture } from './control-fixture.js';
import { hs, STAMP } from '../agent-cli/harness-fixture.js';
import { loadEngines } from '../support/engine-walk.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const ON = { on: true, by: 'ada', at: '2026-11-22T01:00:00Z' };

// The real grouped engine: Plan (grouped-plan) is planning, Build (grouped-build) in progress.
const engines = loadEngines();
const ENGINE = 'example-development-grouped', engine = engines[ENGINE];
const at = (state, sub, extra = {}) => ({ name: 'A', 'harness-status': { state, 'state-engine': ENGINE, ...(sub ? { 'sub-status': { state: sub[1], 'state-engine': sub[0] } } : {}) }, 'state-changes': [], ...extra });
const ticket = (key, ...variations) => ({ key, variations });
const seat = key => ({ key, variation: 'A' });
const PLANNING = ['grouped-plan', 'write-execution-plan'], BUILDING = ['grouped-build', 'generate-solution'], PLANNED = ['grouped-plan', 'done'];
const plan = (ranked, extra = {}) => planDispatch({ ranked, engine, engines, ...extra });

test('AC3: on, a variation at a planning step takes the seat ahead of a higher-ranked one in progress; off, rank order', () => {
  const ranked = [ticket('T-1', at('build', BUILDING)), ticket('T-2', at('plan', PLANNING))];
  const off = plan(ranked, { seats: { mac: 1, remote: 0 } });
  assert.deepEqual([off.reserved, off.inPlanning, off.waiting], [[seat('T-1')], [], [seat('T-2')]]);
  const on = plan(ranked, { seats: { mac: 1, remote: 0 }, planningFocus: true });
  assert.deepEqual([on.reserved, on.inPlanning, on.waiting], [[], [seat('T-2')], [seat('T-1')]]);
});

test('AC3: within each group the usual ranking applies — two planning, two building, one seat each way', () => {
  const ranked = [ticket('T-1', at('build', BUILDING)), ticket('T-2', at('plan', PLANNING)), ticket('T-3', at('build', BUILDING)), ticket('T-4', at('plan', PLANNING))];
  const on = plan(ranked, { seats: { mac: 3, remote: 0 }, planningFocus: true });
  assert.deepEqual(on.inPlanning, [seat('T-2'), seat('T-4')]);
  assert.deepEqual(on.reserved, [seat('T-1')]);
  assert.deepEqual(on.waiting, [seat('T-3')]);
});

test('AC3: running work is not cut off — a seat already recorded is kept, focus or not', () => {
  const ranked = [ticket('T-1', at('build', BUILDING)), ticket('T-2', at('plan', PLANNING))];
  const seated = t => (t.key === 'T-1' ? { key: 'T-1', variation: 'A', kind: 'vm' } : false);
  const on = plan(ranked, { seats: { mac: 1, remote: 0 }, planningFocus: true, seated });
  assert.deepEqual([on.reserved, on.inPlanning, on.waiting], [[seat('T-1')], [], [seat('T-2')]]);
  // Two recorded and the seats shrunk to one: the recorded keep plain rank order (no planning holder pushes one out).
  const both = t => ({ key: t.key, variation: 'A', kind: 'vm' });
  const shrunk = plan(ranked, { seats: { mac: 1, remote: 0 }, planningFocus: true, seated: both });
  assert.deepEqual(shrunk.reserved, [seat('T-1')]);
});

test('AC3: on, a ticket at committed may enter planning ahead of one waiting in progress (free.planning); off, it may not', () => {
  const ranked = [ticket('T-1', at('build', BUILDING)), ticket('T-3', at('committed'))];
  const off = plan(ranked, { seats: { mac: 1, remote: 0 } });
  assert.deepEqual([off.reserved, off.free], [[seat('T-1')], { planning: false, progress: false }]);
  const on = plan(ranked, { seats: { mac: 1, remote: 0 }, planningFocus: true });
  assert.equal(on.free.planning, true);
  assert.equal(on.free.progress, false);
  // A planning holder unseated still comes first: then no more may enter planning than the seats allow.
  const full = plan([ticket('T-2', at('plan', PLANNING)), ...ranked], { seats: { mac: 1, remote: 0 }, planningFocus: true });
  assert.deepEqual([full.inPlanning, full.free.planning], [[seat('T-2')], false]);
});

test('AC3: on, the agents go to planning steps first when max-agents is short; off, in rank order', () => {
  const flat = { steps: [
    { id: 'committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' }, 'exit-events': [{ condition: { 'agent-needs-work': true }, 'move-to-state': 'plan' }] },
    { id: 'plan', sequence: 2, 'is-planning-stage': true, action: { type: 'prompt', prompt: 'p' } },
    { id: 'build', sequence: 3, action: { type: 'prompt', prompt: 'b' } },
  ] };
  const v = state => ({ name: 'A', 'harness-status': { state, 'state-engine': 'e' } });
  const ranked = [ticket('T-1', v('build')), ticket('T-2', v('plan'))];
  const off = planDispatch({ ranked, engine: flat, harness: { 'max-agents': 1 } });
  assert.deepEqual([off.dispatch.map(d => d.key), off.short.map(s => s.key)], [['T-1'], ['T-2']]);
  const on = planDispatch({ ranked, engine: flat, harness: { 'max-agents': 1 }, planningFocus: true });
  assert.deepEqual([on.dispatch.map(d => d.key), on.short.map(s => s.key)], [['T-2'], ['T-1']]);
  assert.equal(on.dispatch[0].planning, true);
});

test('AC4: on, max-tickets-ready-for-build does not hold planning back (readyFull false); off, it does', () => {
  const ranked = [ticket('T-5', at('plan', PLANNED)), ticket('T-6', at('committed'))];
  const off = plan(ranked, { project: { 'max-tickets-ready-for-build': 1 } });
  assert.deepEqual([off.readyFull, off.free.planning], [true, false]);
  const on = plan(ranked, { project: { 'max-tickets-ready-for-build': 1 }, planningFocus: true });
  assert.deepEqual([on.readyFull, on.free.planning], [false, true]);
  // harness.json's, every project's together, too.
  const all = plan(ranked, { harness: { 'max-tickets-ready-for-build': 1 }, planningFocus: true });
  assert.deepEqual([all.readyFull, all.free.planning], [false, true]);
});

test('AC5: off, the plan is exactly as without the switch — planningFocus false, or a file saying off, or none', () => {
  const ranked = [ticket('T-1', at('build', BUILDING)), ticket('T-2', at('plan', PLANNING)), ticket('T-5', at('plan', PLANNED)), ticket('T-6', at('committed')), ticket('T-7', at('build', BUILDING))];
  const base = { seats: { mac: 2, remote: 0 }, project: { 'max-tickets-ready-for-build': 1 }, harness: { 'max-agents': 1 } };
  assert.deepEqual(plan(ranked, { ...base, planningFocus: false }), plan(ranked, base));
  // planFor reads the project's loaded switch: off or missing alike.
  const project = focus => ({ id: 'p', engine, engines, json: {}, tickets: ranked.map(t => ({ ...t, type: 'feature' })), planningFocus: focus });
  const state = { harness: {}, assignments: [], transient: [], engines, projects: [] };
  assert.deepEqual(planFor(state, project({ on: false, by: 'ada', at: ON.at })), planFor(state, project(null)));
  assert.notDeepEqual(planFor(state, project(ON)), planFor(state, project(null)));
  // The walk order too: off, rankSprint's, ticket by ticket.
  const flat = rankSprint(project(null).tickets, { engine }).flatMap(t => t.variations.map(v => `${t.key} ${v.name}`));
  assert.deepEqual(sprintOrder(state, project(null)).map(({ ticket: t, variation: v }) => `${t.key} ${v.name}`), flat);
  assert.deepEqual(sprintOrder(state, project({ on: false })).map(({ ticket: t, variation: v }) => `${t.key} ${v.name}`), flat);
});

test('AC3: sprintOrder, on — in planning and at committed first, rank order within; a finished plan, Blocked and Build after', () => {
  const tickets = [
    ticket('T-1', at('build', BUILDING)), ticket('T-2', at('plan', PLANNED)), ticket('T-3', at('blocked')), ticket('T-4', at('committed')), ticket('T-5', at('plan', PLANNING)),
  ].map((t, i) => ({ ...t, type: 'feature', 'manual-priority': i + 1 }));
  const state = { engines }, project = { id: 'p', engine, engines, tickets, planningFocus: ON };
  assert.deepEqual(sprintOrder(state, project).map(({ ticket: t }) => t.key), ['T-4', 'T-5', 'T-1', 'T-2', 'T-3']);
  const atPlanning = v => atPlanningStep(statusIn(engine, v, engines));
  assert.deepEqual([at('setup', ['grouped-setup', 'done']), at('plan', PLANNING), at('committed'), at('plan', PLANNED), at('build', BUILDING), at('blocked')].map(atPlanning), [true, true, true, false, false, false]);
  assert.deepEqual(planningFirst([1, 2, 3, 4, 5], n => n % 2 === 0), [2, 4, 1, 3, 5]);   // stable, each group in its order
});

test('AC3: runOrder — a focused project\'s runs for a variation at a planning step get their agents first; no switch on, state.transient as it is', () => {
  const runFor = (id, key, state) => ({ id, project: 'p', 'state-engine': state === 'plan' ? 'grouped-plan' : 'grouped-build', state: 'x', parent: { 'work-item': key, variation: 'A', 'state-engine': ENGINE, state } });
  const transient = [runFor('r1', 'T-1', 'build'), { id: 'hc', project: 'p', 'state-engine': 'check-health', state: 'x', parent: { trigger: 'check-health' } }, runFor('r2', 'T-2', 'plan')];
  const tickets = [ticket('T-1', at('build', BUILDING)), ticket('T-2', at('plan', PLANNING))];
  const state = focus => ({ engines, transient, projects: [{ id: 'p', engine, engines, tickets, planningFocus: focus }] });
  assert.equal(runOrder(state(null)), transient);
  assert.deepEqual(runOrder(state(ON)).map(r => r.id), ['r2', 'r1', 'hc']);
});

// ---- through control: the tick-ready-for-build engine, the switch written by the command ----

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const ok = to => [{ condition: { 'exit-code': 0 }, 'move-to-state': to }];
const planning = { 'is-planning-stage': true };
const steps = [
  { id: 'committed', sequence: 2, ...planning, action: { type: 'none' }, 'exit-events': [{ condition: { 'agent-needs-work': true }, 'move-to-state': 'setup' }] },
  { id: 'setup', sequence: 3, ...planning, action: { type: 'script', command: 'true' }, 'exit-events': ok('plan') },
  { id: 'plan', sequence: 4, ...planning, action: { type: 'prompt', prompt: 'review-plan' } },
  { id: 'prepare', sequence: 6, ...planning, action: { type: 'state-engine', engine: 'test' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'build' }] },
  { id: 'build', sequence: 7, action: { type: 'script', command: 'true' }, 'exit-events': ok('review') },
  { id: 'review', sequence: 8, action: { type: 'prompt', prompt: 'test' } },
  { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } },
];
function queue(tickets, { own = {}, seats = Infinity } = {}) {
  const f = controlFixture();
  f.seats(seats);
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  edit(join(f.dir, 'engines', 'example-development', 'workflow.yaml'), e => { e.steps = steps; });
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => Object.assign(p, own));
  edit(sprint, s => {
    s.features = tickets.map(([key, state, rank]) => ({ key, title: `Title ${key}`, 'manual-priority': rank, variations: [{ name: 'A', 'harness-status': state === 'planned' ? { ...hs('prepare'), 'sub-status': { state: 'done', 'state-engine': 'test' } } : hs(state), 'state-changes': [] }] }));
  });
  edit(join(f.dir, 'assignments.json'), a => {
    a['transient-state-engines'] = tickets.filter(([, state]) => state === 'planned').map(([key]) => ({ id: `run-${key}`, project: 'p', 'state-engine': 'test', state: 'done', 'is-done': true, 'structured-output': null, parent: { 'work-item': key, variation: 'A', 'state-engine': 'example-development', state: 'prepare' } }));
  });
  const state = key => f.sprint().features.find(t => t.key === key).variations[0]['harness-status'].state;
  const focus = value => run(AGENT, ['project:set-planning-focus', 'p', value], { env: f.env });
  const line = () => { const s = f.ctx.load(); return seatQueue(s, s.projects.find(p => p.id === 'p')).map(q => `${q.key} ${q.waits}${q.full ? ' full' : ''}`); };
  return { ...f, state, focus, line, steps: () => runSteps(f.ctx, f.ctx.load()) };
}
const SCENE = [['T-1', 'review', 1], ['T-2', 'planned', 2], ['T-3', 'committed', 3]];

test('AC3, AC6 through control: off, the free seat goes to the finished plan (rank order); on, the ticket at committed enters planning first', async () => {
  const off = queue(SCENE, { seats: 2 });
  assert.deepEqual(off.line(), ['T-2 build', 'T-3 planning']);
  await off.steps();
  assert.deepEqual(['T-2', 'T-3'].map(off.state), ['review', 'committed'], off.lines.join('\n'));
  const on = queue(SCENE, { seats: 2 });
  await on.focus('on');
  assert.deepEqual(on.line(), ['T-3 planning', 'T-2 build'], 'the footer queue box shows planning first');   // ASS-525's seat-queue.json
  await on.steps();
  assert.deepEqual(['T-2', 'T-3'].map(on.state), ['prepare', 'plan'], on.lines.join('\n'));
  // Off again with no restart: the next load reads it, and ranking is rank order again.
  await on.focus('off');
  assert.equal(planningFocusOn(on.ctx.load().projects.find(p => p.id === 'p')), false);
  assert.deepEqual(on.line(), ['T-2 build']);
});

test('AC4 through control: on, a ticket at committed enters planning though max-tickets-ready-for-build is reached', async () => {
  // T-3 ranked first, so it asks before the finished plan T-2 leaves the ready queue; seats enough for all.
  const capped = [['T-3', 'committed', 1], ['T-2', 'planned', 2]];
  const off = queue(capped, { own: { 'max-tickets-ready-for-build': 1 } });
  await off.steps();
  assert.equal(off.state('T-3'), 'committed', off.lines.join('\n'));
  assert.ok(off.lines.some(l => l.includes('max-tickets-ready-for-build reached')), off.lines.join('\n'));
  const on = queue(capped, { own: { 'max-tickets-ready-for-build': 1 } });
  await on.focus('on');
  await on.steps();
  assert.equal(on.state('T-3'), 'plan', on.lines.join('\n'));
  assert.ok(!on.lines.some(l => l.includes('max-tickets-ready-for-build reached')), on.lines.join('\n'));
});

test('AC6: the switch is a file control loads each tick — it survives a restart (a fresh load) and needs none either way', async () => {
  const f = queue(SCENE);
  assert.equal(f.ctx.load().projects.find(p => p.id === 'p').planningFocus, null);
  await f.focus('on');
  const dir = join(f.dir, 'projects', 'p');
  assert.equal(planningFocusOn({ planningFocus: loadPlanningFocus(dir) }), true);
  assert.equal(planningFocusOn(f.ctx.load().projects.find(p => p.id === 'p')), true);
  // Caught half-written: off for that read, never a failed tick.
  writeFileSync(join(dir, PLANNING_FOCUS_FILE), '{"on": tr');
  assert.equal(loadPlanningFocus(dir), null);
});

// ---- the command ----

function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'focus-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), `${JSON.stringify({ name: 'P' }, null, 4)}\n`);
  return dir;
}
const set = (dir, ...args) => run(AGENT, ['project:set-planning-focus', ...args], { env: { ...process.env, PROJECTS_DIR: dir, USER: 'ada' } });

test('AC1: project:set-planning-focus on|off writes planning-focus.json whole — on, who, when — under its lock; project.json untouched', async () => {
  const dir = projects(), before = readFileSync(join(dir, 'p', 'project.json'), 'utf8');
  assert.match((await set(dir, 'p', 'on')).stdout, /^p: planning focus on$/m);
  const on = JSON.parse(readFileSync(join(dir, 'p', PLANNING_FOCUS_FILE), 'utf8'));
  assert.deepEqual(Object.keys(on), ['on', 'by', 'at']);
  assert.equal(on.on, true);
  assert.equal(on.by, 'ada');
  assert.match(on.at, STAMP);
  assert.ok(existsSync(join(dir, 'p', `${PLANNING_FOCUS_FILE}.lock`)), 'taken under the file\'s lock (json-file.bash update_json)');
  assert.match((await set(dir, 'p', 'off')).stdout, /^p: planning focus off$/m);
  assert.equal(JSON.parse(readFileSync(join(dir, 'p', PLANNING_FOCUS_FILE), 'utf8')).on, false);
  assert.equal(readFileSync(join(dir, 'p', 'project.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(join(dir, 'p')).toSorted(), ['planning-focus.json', 'planning-focus.json.lock', 'project.json'], 'no temp file left');
});

test('AC1: project:set-planning-focus refuses, writing nothing, an unknown project or value', async () => {
  const dir = projects();
  await assert.rejects(set(dir, 'q', 'on'), /project:set-planning-focus: invalid project 'q'/);
  await assert.rejects(set(dir, '../p', 'on'), /invalid project/);
  await assert.rejects(set(dir, 'p', 'yes'), /project:set-planning-focus: the value must be on or off, got 'yes'/);
  await assert.rejects(set(dir, 'p'), /usage: project:set-planning-focus <project> <on\|off>/);
  assert.equal(existsSync(join(dir, 'p', PLANNING_FOCUS_FILE)), false);
});

test('AC1: the command is listed in agent.sh --help', async () => {
  assert.match((await run(AGENT, ['--help'])).stdout, /project:set-planning-focus\s+Switch a project's focus on planning/);
});
