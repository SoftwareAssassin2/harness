// ticket:accept-ticket-system-status — a gap resolved the ticket system's
// way: the variation goes to the first step its engine pairs with the
// ticket's status, as ticket:change-state moves it; the ticket system, matching
// already, is left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './harness-fixture.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));

// The fixture with paired statuses on its execution engine (generate-solution In Progress, local-testing In Testing, done Done) and ABC-3's ticket-system-status set to `status`.
function gapped(status) {
  const f = fixture();
  const engineFile = join(f.dir, 'engines', 'example-development', 'state-engine.json');
  const engine = JSON.parse(readFileSync(engineFile, 'utf8'));
  const paired = { 'generate-solution': 'In Progress', 'local-testing': 'In Testing', done: 'Done' };
  engine.steps = engine.steps.map(s => ({ ...s, 'paired-ticket-system-status': paired[s.id] }));
  writeFileSync(engineFile, JSON.stringify(engine));
  const sprintFile = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const sprint = JSON.parse(readFileSync(sprintFile, 'utf8'));
  sprint.features[0]['ticket-system-status'] = status;
  writeFileSync(sprintFile, JSON.stringify(sprint));
  return f;
}

test('ticket:accept-ticket-system-status moves the variation to the step paired with the ticket system\'s status, recording the change and leaving the ticket system alone; done again, it changes nothing', async () => {
  const f = gapped('Done');
  const { stdout, stderr } = await f.agent('ticket:accept-ticket-system-status', 'p', 'abc-3', 'A');
  assert.deepEqual(JSON.parse(stdout), { from: 'generate-solution', to: 'done', status: 'Done', changed: true });
  assert.ok(!/transition/.test(stderr), stderr);                                   // the status matches the new step: no call to the ticket system
  const v = f.sprint().features[0].variations[0];
  assert.equal(v['harness-status'].state, 'done');
  assert.deepEqual(v['state-changes'].at(-1), { ...v['state-changes'].at(-1), 'from-state': 'generate-solution', 'to-state': 'done' });
  assert.equal(f.sprint().features[0]['ticket-system-status'], 'Done');
  const changes = v['state-changes'].length;
  const again = await f.agent('ticket:accept-ticket-system-status', 'p', 'ABC-3', 'A');
  assert.deepEqual(JSON.parse(again.stdout), { from: 'done', to: 'done', status: 'Done', changed: false });
  assert.equal(f.sprint().features[0].variations[0]['state-changes'].length, changes);
});

test('ticket:accept-ticket-system-status fails, changing nothing, when no step pairs with the status, the ticket has none, or the variation is missing', async () => {
  await fails(gapped('Nonsense').agent('ticket:accept-ticket-system-status', 'p', 'ABC-3', 'A'), /no step of example-development pairs with "Nonsense"/);
  const none = gapped(null);
  await fails(none.agent('ticket:accept-ticket-system-status', 'p', 'ABC-3', 'A'), /ABC-3 has no ticket-system-status/);
  assert.equal(none.sprint().features[0].variations[0]['harness-status'].state, 'generate-solution');
  await fails(gapped('Done').agent('ticket:accept-ticket-system-status', 'p', 'ABC-3', 'Z'), /no ABC-3 variation Z/);
});
