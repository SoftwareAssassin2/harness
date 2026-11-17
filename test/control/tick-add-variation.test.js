// ASS-499 AC2: a variation ticket:add-variation adds is taken by control like
// any other — moved on from Committed and given an agent of its own, its
// record naming it — while A, elsewhere, is left exactly as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { hs } from '../agent-cli/harness-fixture.js';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';

const sprintFile = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');

test('ASS-499 AC2: control takes an added variation like any other — B leaves Committed for Plan with its own agent — and A (its state, merge requests, VM and files) is undisturbed', async () => {
  const f = controlFixture();
  const data = JSON.parse(readFileSync(sprintFile(f), 'utf8'));
  // A waits at a human step (blocked), with a merge request, a VM and a report of its own.
  Object.assign(data.features[0], { 'ticket-system-status': 'Blocked' });
  Object.assign(data.features[0].variations[0], {
    'harness-status': hs('blocked'), vm: { name: 'abc-3-a' },
    'merge-request': [{ id: 1, repository: 'https://gitlab.com/g/app', branch: 'change/ABC-3-1', status: 'Open', key: '!1', url: 'https://gitlab.com/g/app/-/merge_requests/1', 'build-status': 'Running' }],
  });
  writeFileSync(sprintFile(f), JSON.stringify(data, null, 4));
  const work = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'execution-plan-A.md'), 'A\'s plan\n');
  const a = JSON.parse(readFileSync(sprintFile(f), 'utf8')).features[0].variations[0];

  const { stdout } = await f.agent('ticket:add-variation', 'p', 'ABC-3');
  assert.deepEqual(JSON.parse(stdout), { key: 'ABC-3', variation: 'B', state: 'committed' });
  try {
    await tick(f.ctx);
    const [va, vb] = f.sprint().features[0].variations;
    assert.equal(vb['harness-status'].state, 'plan', f.lines.join('\n'));
    assert.deepEqual(vb['state-changes'].map(c => [c['from-state'], c['to-state']]), [['committed', 'plan']]);
    const records = f.assignments().assignments;
    assert.deepEqual(records.map(r => [r['work-item'], r.variation, r.state]), [['ABC-3', 'B', 'plan']]);
    assert.deepEqual(vb['state-changes'][0]['agent-dispatch-log'].map(d => d['dispatched-to']), [records[0]['agent-name']]);
    assert.deepEqual(va, a);                                                                   // A untouched
    // The ticket's one status follows B's move; neither variation is then in a gap (pairedByAnother).
    assert.equal(f.ticket()['ticket-system-status'], 'In Progress');
    assert.ok(!f.lines.some(l => /gap/.test(l)), f.lines.join('\n'));
    assert.deepEqual(f.assignments()['transient-state-engines'], []);
    assert.equal(readFileSync(join(work, 'execution-plan-A.md'), 'utf8'), 'A\'s plan\n');
    assert.equal(JSON.parse(readFileSync(join(work, 'ticket-B.json'), 'utf8')).variation.name, 'B');
    assert.ok(await until(() => [...f.ctx.agents.values()].every(x => x.result)));
  } finally {
    f.ctx.stopAgents();
  }
});
