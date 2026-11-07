// Self-healing's pause: while a fix goes in, just the tickets it named are
// paused, one by one; everything else, and the self-healing run itself, goes
// on. A human's pause still holds everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { hs } from '../agent-cli/harness-fixture.js';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

// The control fixture with a second ticket, ABC-4, at backlog beside ABC-3.
function two() {
  const f = controlFixture();
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': hs('backlog'), 'state-changes': [] }] });
  });
  return { ...f, at: key => f.sprint().features.find(t => t.key === key).variations[0]['harness-status'].state };
}

test('tick: self-healing pauses only the tickets it named; the rest of the sprint and the self-healing run go on; a human\'s pause then holds them too', async () => {
  const f = two();
  try {
    edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {          // ABC-3 the fix ticket, its plan holding ABC-4
      s.features.find(t => t.key === 'ABC-3')['self-healing-plan'] = { summary: 'the dev container is broken', 'ticket-url': null, 'pause-tickets': ['ABC-4'] };
    });
    await f.agent('self-healing:start', 'p', 'ABC-3');
    await f.agent('transient-state-engine:create', 'p', 'self-healing', 'analyze', JSON.stringify({ trigger: 'self-healing' }));
    await tick(f.ctx);
    await tick(f.ctx);
    assert.equal(f.at('ABC-3'), 'plan', f.lines.join('\n'));                             // not named: moved and got its agent
    assert.equal(f.at('ABC-4'), 'backlog');                                                // named: paused
    assert.ok(f.lines.some(l => /^dispatch \S+ \(\S+\) on self-healing analyze,/.test(l)), f.lines.join('\n'));   // the run got its agent too
    assert.ok(f.lines.some(l => /^dispatch \S+ \(\S+\) on ABC-3 A plan,/.test(l)), f.lines.join('\n'));                  // ABC-3 got its agent
    assert.ok(!f.lines.some(l => /^dispatch .* on ABC-4 /.test(l)), f.lines.join('\n'));                                    // ABC-4 did not
    assert.ok(!f.lines.some(l => /asked to shut down/.test(l)), f.lines.join('\n'));
    await f.agent('assignments:pause', 'all', 'human');
    const before = f.lines.length;
    await tick(f.ctx);
    assert.ok(!f.lines.slice(before).some(l => /^dispatch \S+ \(/.test(l)), f.lines.slice(before).join('\n'));          // nothing more is dispatched
    assert.ok(f.assignments().assignments.every(a => a.status === 'Shutting Down'), JSON.stringify(f.assignments().assignments));   // what is still running is being shut down
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: an AI pause with no self-healing holds everything', async () => {
  const f = two();
  try {
    const file = join(f.dir, 'assignments.json');                                  // as a health check takes it
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pauses: { all: { ai: { since: '2026-10-08T00:00:00Z', reason: 'rotating a token', eta: '2099-01-01T00:00:00Z', agent: 'Ripley', project: 'q', run: 'hc' } } }, status: 'Paused' }));
    await tick(f.ctx);
    await tick(f.ctx);
    assert.equal(f.at('ABC-3'), 'backlog');
    assert.deepEqual(f.assignments().assignments, []);
  } finally {
    f.ctx.stopAgents();
  }
});
