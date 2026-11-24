// ASS-584: runs whose ticket or variation is gone were dispatched and failed forever. Seen live: investigate-gap runs
// whose tickets had left the sprint failing every try with `assignments:create: no ASS-351 in the active sprint`, and
// runs whose parent run had been ended under them failing with `undefined undefined test runs in its VM, and the
// variation has none` (vm.js vmOf), each retried with backoff for days. AC1: whole ticks (real tick(), the state loaded
// deep-frozen as loadState leaves it): a run whose ticket left the sprint, was deleted, or whose variation is deleted,
// is ended once, logged, never dispatched. AC2: one whose ticket can't be resolved at all (its parent run gone) is
// ended the same way, and no log line says "undefined". AC3: a live run, and a memory review of a deleted ticket, go
// on as before (and the rest of the suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tick } from '../../src/control/tick.js';
import { orphanOf } from '../../src/control/moves.js';
import { deepFreeze } from '../../src/control/read.js';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { until } from '../support/until.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const id = n => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;
const run = (n, engine, state, parent) => ({ id: id(n), project: 'p', 'state-engine': engine, state, 'start-time': '2026-11-23T00:00:00Z', parent, 'is-done': false, 'structured-output': null, 'state-changes': [] });

// The fixture's project p: ABC-3 A live (and its variation B deleted), ABC-4 deleted; runs at prompt steps for each
// case. Returns the runs by name.
function setup(f) {
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0].variations.push({ name: 'B', 'is-deleted': true, 'harness-status': hs('backlog'), 'state-changes': [] });
    s.features.push({ key: 'ABC-4', 'is-deleted': true, 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': hs('backlog'), 'state-changes': [] }] });
  });
  const runs = {
    leftSprint: run(1, 'investigate-gap', 'investigate', { trigger: 'gap-resolution', 'work-item': 'ZZZ-9', variation: 'A' }),
    parentGone: run(2, 'test', 'test', { 'transient-state-engine': id('d'), 'state-engine': 'example-development', state: 'local-testing' }),
    variationDeleted: run(3, 'investigate-gap', 'investigate', { trigger: 'gap-resolution', 'work-item': 'ABC-3', variation: 'B' }),
    ticketDeleted: run(4, 'investigate-gap', 'investigate', { trigger: 'gap-resolution', 'work-item': 'ABC-4', variation: 'A' }),
    memoryReview: run(5, 'investigate-gap', 'investigate', { trigger: 'check-memory', 'work-item': 'ABC-4' }),
    live: run(6, 'investigate-gap', 'investigate', { trigger: 'gap-resolution', 'work-item': 'ABC-3', variation: 'A' }),
  };
  edit(join(f.dir, 'assignments.json'), a => { a['transient-state-engines'] = Object.values(runs); });
  f.seats(4);
  return runs;
}

async function ticks(f, n) {
  for (let i = 0; i < n; i++) {
    await tick(f.ctx);
    await until(() => [...f.ctx.agents.values()].every(a => a.result || a.exited));
  }
}

const runIds = f => JSON.parse(readFileSync(join(f.dir, 'assignments.json'), 'utf8'))['transient-state-engines'].map(r => r.id);

test('AC1, AC2: orphan runs are ended once, logged, and never dispatched; no log line says undefined', { timeout: 120_000 /* hang guard: the ticks themselves are awaited */ }, async () => {
  const f = controlFixture();
  const runs = setup(f);
  const state = f.ctx.load();
  assert.ok(Object.isFrozen(state.projects[0].tickets[0]), 'the loaded state is frozen');
  await ticks(f, 3);
  const log = f.lines.join('\n'), left = runIds(f);
  const ended = {
    leftSprint: 'run 11111111 (investigate-gap/investigate): ended — its ticket ZZZ-9 A is no longer in the sprint (left the sprint or was deleted)',
    parentGone: `run 22222222 (test/test): ended — its ticket unknown is no longer in the sprint (its parent run dddddddd is gone)`,
    variationDeleted: 'run 33333333 (investigate-gap/investigate): ended — its ticket ABC-3 B is no longer in the sprint (its variation B is gone or deleted)',
    ticketDeleted: 'run 44444444 (investigate-gap/investigate): ended — its ticket ABC-4 A is no longer in the sprint (left the sprint or was deleted)',
  };
  for (const [name, line] of Object.entries(ended)) {
    assert.equal(f.lines.filter(l => l.endsWith(line)).length, 1, `${name}: logged once\n${log}`);
    assert.ok(!left.includes(runs[name].id), `${name}: removed`);
    assert.doesNotMatch(log, new RegExp(`dispatch run ${runs[name].id.slice(0, 8)}`), `${name}: never dispatched`);
    assert.ok(!f.ctx.load().assignments.some(a => a['transient-state-engine'] === runs[name].id), `${name}: no agent`);
  }
  assert.doesNotMatch(log, /undefined/, log);
  // AC3: the live run and the memory review of a deleted ticket are left be (dispatched as before).
  assert.doesNotMatch(log, /run (55555555|66666666) \([^)]*\): ended/);
  for (const name of ['memoryReview', 'live']) {
    const dispatched = !left.includes(runs[name].id) || f.ctx.load().assignments.some(a => a['transient-state-engine'] === runs[name].id) || f.lines.some(l => l.includes(runs[name].id.slice(0, 8)) && /investigate/.test(l));
    assert.ok(dispatched, `${name}: worked as before\n${log}`);
  }
});

test('orphanOf over frozen state: each case, and what is never an orphan', () => {
  const r = (parent, extra = {}) => ({ id: 'r', project: 'p', 'state-engine': 'e', state: 's', parent, ...extra });
  const project = { id: 'p', sprint: {}, tickets: [{ key: 'K-1', variations: [{ name: 'A' }, { name: 'B', 'is-deleted': true }] }], backlog: [{ key: 'K-2', variations: [{ name: 'A' }] }] };
  const at = (run, transient = [], p = project) => orphanOf(deepFreeze({ projects: [p], transient: [run, ...transient] }), run);
  assert.equal(at(r({ 'work-item': 'K-1', variation: 'A', state: 's' })), null, 'a sprint ticket\'s');
  assert.equal(at(r({ trigger: 'gap-resolution', 'work-item': 'K-2', variation: 'A' })), null, 'a backlog ticket\'s');
  assert.equal(at(r({ trigger: 'check-health' })), null, 'a run for no ticket');
  assert.equal(at(r({ trigger: 'check-variation-appeal', 'work-item': 'K-1' })), null, 'a ticket, no variation named');
  assert.equal(at(r({ trigger: 'check-memory', 'work-item': 'GONE-1' })), null, 'a memory review of a deleted ticket');
  assert.equal(at({ ...r({ 'work-item': 'K-1', variation: 'A' }), project: 'other' }), null, 'another control\'s project');
  assert.equal(at(r({ trigger: 'gap-resolution', 'work-item': 'GONE-1', variation: 'A' }), [], { ...project, sprint: null }), null, 'no active sprint read: can\'t tell');
  assert.deepEqual(at(r({ trigger: 'gap-resolution', 'work-item': 'GONE-1', variation: 'A' })), { key: 'GONE-1', variation: 'A', why: 'left the sprint or was deleted' });
  assert.deepEqual(at(r({ 'work-item': 'K-1', variation: 'B', state: 's' })), { key: 'K-1', variation: 'B', why: 'its variation B is gone or deleted' });
  assert.deepEqual(at(r({ 'work-item': 'K-1', variation: 'C', state: 's' })), { key: 'K-1', variation: 'C', why: 'its variation C is gone or deleted' });
  // A sub-engine's run: its ticket from the run above it; that run's parent gone, the ticket can't be told.
  const parent = { id: 'top', project: 'p', 'state-engine': 'e', state: 'x', parent: { 'transient-state-engine': 'missing-1', state: 'y' } };
  assert.deepEqual(at(r({ 'transient-state-engine': 'top', state: 'x' }), [parent]), { key: null, variation: null, why: 'its parent run missing- is gone' });
  const live = { id: 'top', project: 'p', 'state-engine': 'e', state: 'x', parent: { 'work-item': 'K-1', variation: 'A', state: 'z' } };
  assert.equal(at(r({ 'transient-state-engine': 'top', state: 'x' }), [live]), null, 'a live chain');
  const gone = { ...live, parent: { 'work-item': 'K-9', variation: 'A', state: 'z' } };
  assert.deepEqual(at(r({ 'transient-state-engine': 'top', state: 'x' }), [gone]), { key: 'K-9', variation: 'A', why: 'left the sprint or was deleted' }, 'a chain whose ticket left');
});
