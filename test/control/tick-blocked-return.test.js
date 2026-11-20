// ASS-522: a variation whose Blocked run has finished moves back to the step
// it returns to in the same tick, seat or not, and waits for its seat there:
// nothing runs at the step (no script, no sub-engine run, no agent) until it
// is seated, then it carries on as any waiting variation does. Driven tick by
// tick on the control fixture and a fake agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { tick } from '../../src/control/tick.js';
import { planFor } from '../../src/control/plan.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const STATUS = { blocked: 'Blocked', plan: 'In Progress', build: 'In Progress', 'local-testing': 'In Progress', done: 'Done' };
const was = (from, to) => ({ 'state-engine': 'example-development', 'from-state': from, 'to-state': to, timestamp: '2026-11-20T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': true });
// A sprint ticket, its one variation at `state` with `changes` (state-changes).
const at = (key, state, changes = []) => ({ key, title: key, 'ticket-system-status': STATUS[state], priority: Number(key.split('-')[1]), dependencies: [], variations: [{ name: 'A', 'harness-status': hs(state), 'state-changes': changes }] });
// Blocked's run for `key`, finished: its one-step engine at done.
const doneRun = (key, id = `run-${key}`) => ({ id, project: 'p', 'state-engine': 'unblock', state: 'done', 'is-done': true, 'structured-output': null, parent: { 'work-item': key, variation: 'A', 'state-engine': 'example-development', state: 'blocked' } });

// The control fixture with: Blocked a state-engine step on a one-step engine
// (unblock: done at once), its is-done exit following the return-to step (as
// grouped-blocked's does); a sprint of ABC-1 A at blocked, come from `from`,
// its Blocked run done; `holders` (default ABC-2 at build, holding the one
// in-progress seat) after it; and harness.json's `limits`.
function blockedReturn({ from = 'build', holders = [at('ABC-2', 'build')], limits = {} } = {}) {
  const f = controlFixture();
  const engine = join(f.dir, 'engines', 'example-development', 'state-engine.json');
  edit(engine, e => Object.assign(e.steps.find(s => s.id === 'blocked'), {
    action: { type: 'state-engine', engine: 'unblock' },
    'follow-return-to-state': true, 'exit-events': [{ condition: { 'is-done': true }, 'follow-return-to-state': true }],
  }));
  mkdirSync(join(f.dir, 'engines', 'unblock'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'unblock', 'state-engine.json'), JSON.stringify({ steps: [{ id: 'done', sequence: 1, 'is-done': true, action: { type: 'none' } }] }));
  edit(join(f.dir, 'harness.json'), h => Object.assign(h, limits));
  const sprintFile = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const into = from === 'plan' ? [was('committed', 'plan')] : from === 'build' ? [was('plan', 'build')] : [was('plan', 'build'), was('build', 'local-testing')];
  edit(sprintFile, s => { s.features = [at('ABC-1', 'blocked', [...into, was(from, 'blocked')]), ...holders]; });
  writeFileSync(join(f.dir, 'projects', 'p', 'backlog.json'), JSON.stringify({ tickets: [] }));
  edit(join(f.dir, 'assignments.json'), a => { a['transient-state-engines'] = [doneRun('ABC-1')]; });
  const inSprint = key => f.sprint().features.find(t => t.key === key);
  return {
    ...f,
    editSprint: change => edit(sprintFile, change),
    inSprint,
    stateOf: key => inSprint(key).variations[0]['harness-status'].state,
    calls: pattern => f.lines.filter(l => pattern.test(l)),
    plan: () => { const state = f.ctx.load(); const plan = planFor(state, state.projects[0]); return { reserved: plan.reserved.map(r => r.key), waiting: plan.waiting.map(r => r.key) }; },
    ticks: async (n = 1) => { for (let i = 0; i < n; i++) await tick(f.ctx); },
  };
}
