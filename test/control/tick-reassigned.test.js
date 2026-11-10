// ASS-345 AC6: a sprint ticket ticket:sync holds because it was reassigned
// away from the signed-in account is held by control as any paused variation
// is (engine.js isHeld): no agent is dispatched for the held variation, one
// already running on it is asked to shut down and removed, and the ticket
// stays at its step; assigned back, the step runs again. Control has no code
// of its own for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
const turnsEnd = ctx => until(() => [...ctx.agents.values()].every(a => a.result));
const ME = { 'ticket-system-assignment': 'Me', 'ticket-system-assignment-id': 'acc-me' };
const BEA = { 'ticket-system-assignment': 'Bea Other', 'ticket-system-assignment-id': 'acc-bea' };

// ABC-3 as the downloader fetches it, assigned to `who`, synced into p's sprint.
async function fetchedAs(f, who) {
  const t = f.ticket();
  const file = join(f.dir, 'fetched.json');
  writeFileSync(file, JSON.stringify({ tickets: [{ key: 'ABC-3', title: t.title ?? 'T', description: t.description ?? 'D', url: 'https://x.atlassian.net/browse/ABC-3',
    'ticket-system-status': t['ticket-system-status'], 'ticket-system-priority': 'High', points: 3, 'issue-type': 'Story', dependencies: [], overlaps: [], ...who }] }));
  await f.agent('ticket:sync', 'p', 'sprint', file);
}

test('ASS-345 AC6: control dispatches nothing for a reassigned ticket\'s held variation and ends the agent already running on it; assigned back, the step runs again', async () => {
  const f = controlFixture();
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => Object.assign(s.features[0], { title: 'T', description: 'D', ...ME }));
  writeFileSync(join(f.dir, 'projects', 'p', 'ticket-system-account-id'), 'acc-me');
  let clock = Date.now();
  f.ctx.now = () => new Date(clock);
  try {
    await tick(f.ctx);                                                                          // backlog → committed → plan, an agent dispatched
    const [record] = f.assignments().assignments;
    assert.deepEqual([record['work-item'], record.variation, f.variation()['harness-status'].state], ['ABC-3', 'A', 'plan']);
    assert.ok(await turnsEnd(f.ctx));
    f.ctx.agents.get(record['agent-name']).result = null;                                       // as though still mid-turn when the ticket is reassigned
    await fetchedAs(f, BEA);
    assert.deepEqual([f.ticket().reassigned['paused-variations'], f.variation()['is-paused']], [['A'], true]);
    const before = f.lines.length;
    assert.ok(f.lines.some(l => l.startsWith('dispatch ')), f.lines.join('\n'));                 // the first dispatch is logged so
    await tick(f.ctx);
    assert.equal(f.assignments().assignments[0].status, 'Shutting Down');
    assert.ok(await turnsEnd(f.ctx));
    for (let i = 0; i < 3; i++) { clock += 2000; await tick(f.ctx); }
    assert.deepEqual(f.assignments().assignments, []);                                          // ended, and nothing dispatched again
    assert.equal(f.variation()['harness-status'].state, 'plan');                                // held where it was
    assert.ok(!f.lines.slice(before).some(l => l.startsWith('dispatch ')), f.lines.join('\n'));
    // Assigned back: the hold lifts and plan runs again.
    await fetchedAs(f, ME);
    assert.deepEqual(['reassigned' in f.ticket(), f.variation()['is-paused']], [false, false]);
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments.map(a => [a['work-item'], a.variation, a.state]), [['ABC-3', 'A', 'plan']]);
  } finally {
    f.ctx.stopAgents();
  }
});
