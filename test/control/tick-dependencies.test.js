// ASS-195: a ticket waits for the tickets it depends on. In a project whose
// project.json has wait-for-dependencies: true, a sprint ticket at Committed
// with a same-project dependency not Done — in the sprint or the backlog —
// does not leave Committed: no slot, no agent; one past Committed keeps
// going. While it waits, a backlog dependency is raised to
// manual-backlog-priority 1 and a sprint one, when the dependent has a
// manual-priority, to just above it — each only when it does not already
// rank above, recorded as priority-raised-by — and released (the raise and
// its record cleared, an operator's value never) once the hold ends or the
// backlog dependency joins the sprint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs, run } from '../agent-cli/harness-fixture.js';
import { tick } from '../../src/control/tick.js';
import { engineDir } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const AGENT = join(ROOT, 'agent.sh');
const OFF_BOARD = join(ROOT, 'off-board.sh');
const RAISED = 'priority-raised-by';
const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
// The fixture engine's paired ticket-system statuses, so no gap is found.
const STATUS = { committed: 'To Do', plan: 'In Progress', build: 'In Progress', done: 'Done' };
// A sprint ticket, its one variation at `state`.
const at = (key, state, extra = {}) => ({ key, title: key, 'ticket-system-status': STATUS[state], priority: Number(key.split('-')[1]), 'manual-priority': null, dependencies: [], variations: [{ name: 'A', 'harness-status': hs(state), 'state-changes': [] }], ...extra });
// A backlog ticket, its one variation at `state` of the refinement engine.
const later = (key, extra = {}, state = 'groom') => ({ key, title: key, 'ticket-system-status': 'Backlog', priority: Number(key.split('-')[1]), 'manual-backlog-priority': null, dependencies: [], variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'example-backlog-refinement' }, 'state-changes': [] }], ...extra });

// The control fixture with p's sprint `sprint` and backlog `backlog`, and
// wait-for-dependencies `flag` in its project.json (undefined: not there).
// Plus stateOf(key), inSprint(key), inBacklog(key) (backlog.json's row,
// joined ones' kept), dispatched(key), calls(pattern) (the cli lines
// matching) and ticks(n).
function waiting(options = {}) {
  const { sprint = [], backlog = [], flag = true } = options;
  const f = controlFixture();
  edit(join(f.dir, 'harness.json'), h => { h['max-tickets-in-planning'] = 5; });
  // flag: undefined asks for a project.json without the field at all; left out of the call, the flag is on.
  if (!('flag' in options && options.flag === undefined)) edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['wait-for-dependencies'] = flag; });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features = sprint; });
  const file = join(f.dir, 'projects', 'p', 'backlog.json');
  writeFileSync(file, JSON.stringify({ tickets: backlog }, null, 4));
  const inSprint = key => f.sprint().features.find(t => t.key === key);
  return {
    ...f, file,
    stateOf: key => inSprint(key).variations[0]['harness-status'].state,
    inSprint,
    inBacklog: key => JSON.parse(readFileSync(file, 'utf8')).tickets.find(t => t.key === key),
    dispatched: key => f.lines.some(l => new RegExp(`^cli agent\\.sh assignments:create p \\S+ \\S+ \\S+ \\S+ \\S+ ${key} A `).test(l)),
    calls: pattern => f.lines.filter(l => pattern.test(l)),
    ticks: async (n = 1) => { for (let i = 0; i < n; i++) await tick(f.ctx); },
  };
}
// The cli line setting `key`'s priority by `command` to `value` ('' to release) for `dependent`.
const raise = (command, key, value, dependent) => new RegExp(`^cli agent\\.sh ticket:${command} p ${key} ${value === '' ? '(?:""|)' : value} ${dependent}$`);
const anyRaise = (command, key) => new RegExp(`^cli agent\\.sh ticket:${command} p ${key} `);
// Holds: the dependent still at Committed, no agent on it.
const held = (f, key = 'ABC-1') => {
  assert.equal(f.stateOf(key), 'committed', f.lines.join('\n'));
  assert.equal(f.dispatched(key), false, f.lines.join('\n'));
};

test('ASS-195 AC1: a ticket at Committed with a sprint dependency not Done stays there — no move, no agent — its dependency key matched in any case', async () => {
  for (const dep of ['ABC-2', 'abc-2']) {
    const f = waiting({ sprint: [at('ABC-1', 'committed', { dependencies: [dep] }), at('ABC-2', 'plan')] });
    await f.ticks(2);
    held(f);
  }
});

test('ASS-195 AC1: a ticket at Committed with a backlog dependency not Done stays there', async () => {
  const f = waiting({ sprint: [at('ABC-1', 'committed', { dependencies: ['ABC-9'] })], backlog: [later('ABC-9')] });
  await f.ticks(2);
  held(f);
});

test('ASS-195 AC1: the dependency\'s ticket-system-status turning Done releases the dependent: it moves off Committed on the next tick', async () => {
  const f = waiting({ sprint: [at('ABC-1', 'committed', { dependencies: ['ABC-2'] }), at('ABC-2', 'plan')] });
  await f.ticks();
  held(f);
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[1]['ticket-system-status'] = 'Done'; });
  await f.ticks();
  assert.notEqual(f.stateOf('ABC-1'), 'committed', f.lines.join('\n'));
});

test('ASS-195 AC1: any non-deleted variation of the dependency reaching an is-done step releases the dependent', async () => {
  const f = waiting({ sprint: [at('ABC-1', 'committed', { dependencies: ['ABC-2'] }), at('ABC-2', 'plan')] });
  await f.ticks();
  held(f);
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[1].variations.push({ name: 'B', 'harness-status': hs('done'), 'state-changes': [] });
  });
  await f.ticks();
  assert.notEqual(f.stateOf('ABC-1'), 'committed', f.lines.join('\n'));
});

test('ASS-195 AC1: a variation already past Committed keeps going, its dependency not Done — no waits logged for it', async () => {
  const f = waiting({ sprint: [at('ABC-1', 'plan', { dependencies: ['ABC-2'] }), at('ABC-2', 'committed')] });
  await f.ticks();
  assert.equal(f.dispatched('ABC-1'), true, f.lines.join('\n'));
  assert.ok(!f.lines.some(l => /ABC-1\b.*waits on/.test(l)), f.lines.join('\n'));
});

test('ASS-195 AC1: a project without wait-for-dependencies, or with it false or "true", never holds', async () => {
  for (const flag of [undefined, false, 'true']) {
    const f = waiting({ flag, sprint: [at('ABC-1', 'committed', { dependencies: ['ABC-2'] }), at('ABC-2', 'plan')] });
    await f.ticks();
    assert.equal(f.stateOf('ABC-1'), 'plan', `${flag}\n${f.lines.join('\n')}`);
  }
});

test('ASS-301 AC4: dependencyHold sees the flag project:set-wait-for-dependencies sets — none, no hold; on, held; off, released', async () => {
  const sprint = () => [at('ABC-1', 'committed', { dependencies: ['ABC-2'] }), at('ABC-2', 'plan')];
  const f = waiting({ flag: undefined, sprint: sprint() });
  await f.ticks();
  assert.equal(f.stateOf('ABC-1'), 'plan', f.lines.join('\n'));
  const g = waiting({ flag: undefined, sprint: sprint() });
  await g.agent('project:set-wait-for-dependencies', 'p', 'on');
  await g.ticks(2);
  held(g);
  await g.agent('project:set-wait-for-dependencies', 'p', 'off');
  await g.ticks();
  assert.notEqual(g.stateOf('ABC-1'), 'committed', g.lines.join('\n'));
});

test('ASS-195 AC1: the wait is logged once per change of what it waits on, its keys in dependency order', async () => {
  const f = waiting({ sprint: [at('ABC-1', 'committed', { dependencies: ['ABC-4', 'ABC-2'] }), at('ABC-2', 'plan'), at('ABC-4', 'plan')] });
  await f.ticks(2);
  assert.equal(f.calls(/ABC-1\b.*: waits on ABC-4, ABC-2$/).length, 1, f.lines.join('\n'));
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[2]['ticket-system-status'] = 'Done'; });   // ABC-4
  await f.ticks(2);
  assert.equal(f.calls(/ABC-1\b.*: waits on ABC-2$/).length, 1, f.lines.join('\n'));
});

test('ASS-195 AC2: a holding backlog dependency is raised to manual-backlog-priority 1, recorded as raised for the dependent — once, however many ticks', async () => {
  const f = waiting({ sprint: [at('ABC-1', 'committed', { dependencies: ['ABC-9'] })], backlog: [later('ABC-8', { 'manual-backlog-priority': 1 }), later('ABC-9')] });
  await f.ticks(2);
  assert.equal(f.calls(raise('set-manual-backlog-priority', 'ABC-9', 1, 'ABC-1')).length, 1, f.lines.join('\n'));
  assert.equal(f.calls(anyRaise('set-manual-backlog-priority', 'ABC-9')).length, 1, f.lines.join('\n'));
  assert.equal(f.inBacklog('ABC-9')['manual-backlog-priority'], 1);
  assert.deepEqual(f.inBacklog('ABC-9')[RAISED], { field: 'manual-backlog-priority', value: 1, for: 'ABC-1' });
  assert.equal(f.inBacklog('ABC-8')['manual-backlog-priority'], 2);                               // made room
  held(f);
});

test('ASS-195 AC2: a holding sprint dependency is raised to the dependent\'s manual-priority, the dependent one down, recorded — once, however many ticks', async () => {
  const f = waiting({ sprint: [at('ABC-1', 'committed', { 'manual-priority': 4, priority: 4, dependencies: ['ABC-5'] }), at('ABC-5', 'plan', { priority: 5 })] });
  await f.ticks(2);
  assert.equal(f.calls(raise('set-manual-priority', 'ABC-5', 4, 'ABC-1')).length, 1, f.lines.join('\n'));
  assert.equal(f.calls(anyRaise('set-manual-priority', 'ABC-5')).length, 1, f.lines.join('\n'));
  assert.equal(f.inSprint('ABC-5')['manual-priority'], 4);
  assert.deepEqual(f.inSprint('ABC-5')[RAISED], { field: 'manual-priority', value: 4, for: 'ABC-1' });
  assert.equal(f.inSprint('ABC-1')['manual-priority'], 5);
  held(f);
});

test('ASS-195 AC2: no raise when the dependency already ranks above — first in the backlog, or before the dependent in the sprint — nor a sprint one when the dependent has no manual-priority', async () => {
  const f = waiting({ sprint: [at('ABC-1', 'committed', { dependencies: ['ABC-9'] })], backlog: [later('ABC-9', { 'manual-backlog-priority': 1 }), later('ABC-8')] });
  const g = waiting({ sprint: [at('ABC-1', 'committed', { 'manual-priority': 4, priority: 4, dependencies: ['ABC-5'] }), at('ABC-5', 'plan', { 'manual-priority': 3, priority: 3 })] });
  const h = waiting({ sprint: [at('ABC-1', 'committed', { priority: 1, dependencies: ['ABC-5'] }), at('ABC-5', 'plan', { priority: 5 })] });
  for (const x of [f, g, h]) await x.ticks(2);
  assert.deepEqual(f.calls(/ticket:set-manual-backlog-priority/), []);
  assert.deepEqual(g.calls(/ticket:set-manual-priority/), []);
  assert.deepEqual(h.calls(/ticket:set-manual-priority/), []);
  assert.equal(f.inBacklog('ABC-9')[RAISED], undefined);
  for (const x of [f, g, h]) held(x);
});

test('ASS-195 AC2: two backlog dependencies of one dependent are each raised once — no swapping slot 1 tick over tick', async () => {
  const f = waiting({ sprint: [at('ABC-1', 'committed', { dependencies: ['ABC-8', 'ABC-9'] })], backlog: [later('ABC-7'), later('ABC-8'), later('ABC-9')] });
  await f.ticks(3);
  assert.equal(f.calls(anyRaise('set-manual-backlog-priority', 'ABC-8')).length, 1, f.lines.join('\n'));
  assert.equal(f.calls(anyRaise('set-manual-backlog-priority', 'ABC-9')).length, 1, f.lines.join('\n'));
  assert.equal(f.inBacklog('ABC-8')[RAISED]?.for, 'ABC-1');
  assert.equal(f.inBacklog('ABC-9')[RAISED]?.for, 'ABC-1');
  held(f);
});

test('ASS-195 AC2: the dependency Done, a backlog raise is released — the field and record cleared', async () => {
  const record = { field: 'manual-backlog-priority', value: 1, for: 'ABC-1' };
  const f = waiting({ sprint: [at('ABC-1', 'committed', { dependencies: ['ABC-9'] })], backlog: [later('ABC-9', { 'manual-backlog-priority': 1, 'ticket-system-status': 'Done', [RAISED]: record }), later('ABC-8', { 'manual-backlog-priority': 2 })] });
  await f.ticks(2);
  assert.equal(f.calls(raise('set-manual-backlog-priority', 'ABC-9', '', 'ABC-1')).length, 1, f.lines.join('\n'));
  assert.equal(f.inBacklog('ABC-9')['manual-backlog-priority'], null);
  assert.equal(RAISED in f.inBacklog('ABC-9'), false);
});

test('ASS-195 AC2: the dependency Done, a sprint raise is released — the field and record cleared', async () => {
  const record = { field: 'manual-priority', value: 4, for: 'ABC-1' };
  const f = waiting({ sprint: [at('ABC-1', 'committed', { 'manual-priority': 5, priority: 5, dependencies: ['ABC-4'] }), at('ABC-4', 'done', { 'manual-priority': 4, priority: 4, [RAISED]: record })] });
  await f.ticks(2);
  assert.equal(f.calls(raise('set-manual-priority', 'ABC-4', '', 'ABC-1')).length, 1, f.lines.join('\n'));
  assert.equal(f.inSprint('ABC-4')['manual-priority'], null);
  assert.equal(RAISED in f.inSprint('ABC-4'), false);
});

test('ASS-195 AC2: a raise the operator set over (the plain command) is never released — their value stays though it equals the raise', async () => {
  const f = waiting({ sprint: [at('ABC-1', 'committed', { 'manual-priority': 4, priority: 4, dependencies: ['ABC-5'] }), at('ABC-5', 'plan', { priority: 5 })] });
  await f.ticks();
  assert.equal(f.inSprint('ABC-5')['manual-priority'], 4, f.lines.join('\n'));
  await run(AGENT, ['ticket:set-manual-priority', 'p', 'ABC-5', '4'], { env: f.env });           // the operator's
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features.find(t => t.key === 'ABC-5')['ticket-system-status'] = 'Done'; });
  await f.ticks(2);
  assert.deepEqual(f.calls(raise('set-manual-priority', 'ABC-5', '', 'ABC-1')), []);
  assert.equal(f.inSprint('ABC-5')['manual-priority'], 4);
  // The backlog's: an operator's 1, no record, kept when the dependency is Done.
  const g = waiting({ sprint: [at('ABC-1', 'committed', { dependencies: ['ABC-9'] })], backlog: [later('ABC-9', { 'manual-backlog-priority': 1, 'ticket-system-status': 'Done' })] });
  await g.ticks(2);
  assert.deepEqual(g.calls(/ticket:set-manual-backlog-priority/), []);
  assert.equal(g.inBacklog('ABC-9')['manual-backlog-priority'], 1);
});

test('ASS-195 AC2: a raise is released once its dependent is past Committed or gone', async () => {
  const record = { field: 'manual-priority', value: 4, for: 'ABC-1' };
  for (const dependent of [at('ABC-1', 'plan', { dependencies: ['ABC-4'] }), at('ABC-1', 'committed', { dependencies: ['ABC-4'], 'is-deleted': true })]) {
    const f = waiting({ sprint: [dependent, at('ABC-4', 'plan', { 'manual-priority': 4, priority: 4, [RAISED]: record })] });
    await f.ticks();
    assert.equal(f.calls(raise('set-manual-priority', 'ABC-4', '', 'ABC-1')).length, 1, f.lines.join('\n'));
    assert.equal(f.inSprint('ABC-4')['manual-priority'], null);
    assert.equal(RAISED in f.inSprint('ABC-4'), false);
  }
});

test('ASS-195 AC2: with the flag turned off raises are released and none written', async () => {
  const record = { field: 'manual-backlog-priority', value: 1, for: 'ABC-1' };
  const f = waiting({ flag: false, sprint: [at('ABC-1', 'committed', { dependencies: ['ABC-9', 'ABC-8'] })], backlog: [later('ABC-9', { 'manual-backlog-priority': 1, [RAISED]: record }), later('ABC-8')] });
  await f.ticks(2);
  assert.equal(f.calls(raise('set-manual-backlog-priority', 'ABC-9', '', 'ABC-1')).length, 1, f.lines.join('\n'));
  assert.deepEqual(f.calls(anyRaise('set-manual-backlog-priority', 'ABC-8')), []);
  assert.equal(f.inBacklog('ABC-9')['manual-backlog-priority'], null);
  assert.equal(RAISED in f.inBacklog('ABC-9'), false);
});

// waiting() with p refining its backlog through the real
// example-backlog-refinement engine, ready tickets joining the sprint at
// committed (ASS-44), and an off-board work source (prefix HD) with HD-1, so
// a ready HD-1 really joins. Its Committed pairs Committed, as the dependent's status.
async function joining({ sprint, ...options }) {
  const f = waiting({ ...options, sprint: sprint.map(t => (t.variations[0]['harness-status'].state === 'committed' ? { ...t, 'ticket-system-status': 'Committed' } : t)) });
  const engine = 'example-backlog-refinement';
  mkdirSync(join(f.dir, 'engines', engine), { recursive: true });
  writeFileSync(join(f.dir, 'engines', engine, 'state-engine.json'), readFileSync(join(engineDir(engine), 'state-engine.json')));
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e['backlog-refinement-steps'] = [{ id: 'backlog-refinement', sequence: 1, action: { type: 'state-engine', engine }, 'exit-events': [{ condition: { 'is-done': true } }] }];
    e['ready-tickets-join-sprint-at'] = 'committed';
    e.steps.find(x => x.id === 'committed')['paired-ticket-system-status'] = 'Committed';         // an off-board status
  });
  edit(join(f.dir, 'harness.json'), h => { h['max-tickets-in-grooming'] = 0; });
  f.env.OFF_BOARD_DIR = join(f.dir, 'off-board');                                               // ctx holds the same env object
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => p['work-sources'].push({ name: 'Harness', type: 'off-board', folder: 'p', 'key-prefix': 'HD' }));
  await run(OFF_BOARD, ['ticket:create', 'p', 'Story', 'Depended on'], { env: f.env });
  const questions = join(f.dir, 'projects', 'p', 'work', 'HD-1', 'questions-and-answers.json');
  mkdirSync(join(questions, '..'), { recursive: true });
  writeFileSync(questions, JSON.stringify({ list: [{ question: 'Ready?', status: 'Answer Accepted', 'answered-time-stamp': '2026-10-13T10:00:00Z' }] }));
  return f;
}

test('ASS-195 AC2: a holding backlog dependency joins the sprint once its refinement is ready, by the existing join; the dependent still held, now by a sprint dependency', async () => {
  const f = await joining({ sprint: [at('ABC-1', 'committed', { dependencies: ['HD-1'] })], backlog: [later('HD-1', {}, 'ready')] });
  await f.ticks();
  assert.ok(f.inSprint('HD-1'), f.lines.join('\n'));
  await f.ticks();
  held(f);
});

test('ASS-195 AC2: a raised backlog dependency that joins the sprint has its backlog raise released though its dependent still waits; then, the dependent having a manual-priority, it is raised in the sprint — each once', async () => {
  const record = { field: 'manual-backlog-priority', value: 1, for: 'ABC-1' };
  const f = await joining({ sprint: [at('ABC-1', 'committed', { 'manual-priority': 4, priority: 4, dependencies: ['HD-1'] })], backlog: [later('HD-1', { 'manual-backlog-priority': 1, [RAISED]: record }, 'ready')] });
  await f.ticks(4);
  assert.ok(f.inSprint('HD-1'), f.lines.join('\n'));
  assert.equal(f.calls(raise('set-manual-backlog-priority', 'HD-1', '', 'ABC-1')).length, 1, f.lines.join('\n'));
  assert.equal(f.calls(anyRaise('set-manual-backlog-priority', 'HD-1')).length, 1, f.lines.join('\n'));
  const row = f.inBacklog('HD-1');                                                              // kept on joining (ASS-42)
  assert.ok(row && row['manual-backlog-priority'] == null && !(RAISED in row), JSON.stringify(row));
  assert.equal(f.calls(raise('set-manual-priority', 'HD-1', 4, 'ABC-1')).length, 1, f.lines.join('\n'));
  assert.equal(f.calls(anyRaise('set-manual-priority', 'HD-1')).length, 1, f.lines.join('\n'));
  assert.deepEqual(f.inSprint('HD-1')[RAISED], { field: 'manual-priority', value: 4, for: 'ABC-1' });
  held(f);
});
