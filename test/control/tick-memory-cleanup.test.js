// Every project's memory kept true (ASS-62 AC6): an engine with
// check-memory-steps — the grouped and v2 engines' run engines/check-memory,
// whose agent checks the bank against the project as it stands now — starts
// them every check-memory-interval-seconds, as it does its health check, one
// at a time; background work, which it is, off holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };

function cleanupFixture({ background = true } = {}) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e['check-memory-interval-seconds'] = 600;
    e['check-memory-steps'] = [{ id: 'check-memory', sequence: 1, action: { type: 'state-engine', engine: 'investigate-gap' }, 'exit-events': [{ condition: { 'is-done': true } }] }];
  });
  if (!background) edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['background-work'] = false; });
  let clock = f.ctx.started.getTime();
  f.ctx.now = () => new Date(clock);
  const runs = () => f.assignments()['transient-state-engines'].filter(r => r.parent.trigger === 'check-memory').map(r => [r.project, r['state-engine']]);
  return { f, runs, later: ms => { clock += ms; } };
}

test('AC6: check-memory-steps start every check-memory-interval-seconds, one run at a time', async () => {
  const { f, runs, later } = cleanupFixture();
  try {
    await tick(f.ctx);
    assert.deepEqual(runs(), []);
    later(600_000);
    await tick(f.ctx);
    assert.deepEqual(runs(), [['p', 'example-development/check-memory-steps']]);
    assert.ok(f.lines.includes('timers p: started check-memory'), f.lines.join('\n'));
    later(600_000);
    await tick(f.ctx);
    assert.equal(runs().length, 1, 'not while one runs');
  } finally {
    f.ctx.stopAgents();
  }
});

test('AC6: a project with its background work off starts no memory cleanup', async () => {
  const { f, runs, later } = cleanupFixture({ background: false });
  try {
    later(600_000);
    await tick(f.ctx);
    assert.deepEqual(runs(), []);
  } finally {
    f.ctx.stopAgents();
  }
});
