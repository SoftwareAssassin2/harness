// A pause holds everything: while a pause in assignments.json holds (the
// human's, or an AI's), the steps phase moves no ticket and starts no run —
// so the ticket system is left alone — and nothing is dispatched; once it is
// released, the moves resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';

test('tick: while the human pause holds, no ticket moves and nothing is dispatched; released, the moves resume', async () => {
  const f = controlFixture();
  try {
    await f.agent('assignments:pause', 'all', 'human');
    await tick(f.ctx);
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'backlog');
    assert.equal(f.ticket()['ticket-system-status'], 'Backlog');
    assert.deepEqual(f.assignments().assignments, []);
    assert.ok(!f.lines.some(l => /^(steps|dispatch) /.test(l)), f.lines.join('\n'));
    await f.agent('assignments:start', 'all', 'human');
    await tick(f.ctx);
    assert.notEqual(f.variation()['harness-status'].state, 'backlog');
    assert.ok(f.lines.some(l => /^steps ABC-3 A backlog → committed$/.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a pause on another project holds nothing here; one on this project holds it as one on all does', async () => {
  for (const [scope, held] of [['x', false], ['p', true]]) {
    const f = controlFixture();
    mkdirSync(join(f.dir, 'projects', 'x'));
    writeFileSync(join(f.dir, 'projects', 'x', 'project.json'), JSON.stringify({ name: 'X' }));   // another project, no engine
    try {
      await f.agent('assignments:pause', scope, 'human');
      await tick(f.ctx);
      assert.equal(f.variation()['harness-status'].state === 'backlog', held, scope);
    } finally {
      f.ctx.stopAgents();
    }
  }
});

test('tick: an AI pause past its eta is released, said on the control screen; one not yet due stays', async () => {
  const f = controlFixture();
  const file = join(f.dir, 'assignments.json');
  const pause = eta => ({ ai: { since: '2026-10-08T00:00:00Z', reason: 'Rotating a token', eta, agent: 'Ripley', project: 'q', run: 'hc' } });
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pauses: { all: pause('2000-01-01T00:00:00Z'), p: pause('2999-01-01T00:00:00Z') }, status: 'Paused' }));
  try {
    await tick(f.ctx);
    assert.deepEqual(Object.keys(f.assignments().pauses), ['p']);
    assert.ok(f.lines.some(l => l === 'agents the AI pause on all (Rotating a token, Ripley) is past its eta: released'), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});
