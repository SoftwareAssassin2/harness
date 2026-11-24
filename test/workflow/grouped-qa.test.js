// ASS-282: grouped-qa's QA Testing waits while QA works the ticket (the ticket
// system at In Testing, the pairing of the parent's qa step) and ends at Done
// when QA says Done; any other status QA sets — On Hold, or one sending the
// ticket back — ends the group at Blocked, and the parent qa step sends the
// ticket to Blocked, rather than leaving it parked at QA Testing for ever. An
// unknown status (none synced yet) is no reason to block: it waits too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, answersGap } from '../../src/control/engine.js';
import { ticketFacts } from '../../src/control/facts.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { ROOT, loadEngines, walk } from '../support/engine-walk.js';
import { readEngine } from '../../src/workflow/engine-file.js';

const engines = loadEngines();
// A ticket walked from the example's qa step, the ticket system at `status` while QA Testing waits.
const fromQa = status => walk(engines, 'example-development-grouped', { from: 'qa', stop: ['blocked', 'blocked-for-human'], answers: { 'grouped-qa/qa-testing': { ticketSystemStatus: status } } });

test('ASS-282 AC1: qa-testing has an exit on any status but Done (and In Testing, its in-progress pairing) to blocked, after its Done exit', () => {
  const exits = readEngine(join(ROOT, 'engines', 'grouped-qa', 'workflow.yaml')).steps.find(s => s.id === 'qa-testing')['exit-events'];
  assert.deepEqual(exits[0], { condition: { 'ticket-system-status': 'Done' }, 'move-to-state': 'done' }, 'the Done exit stays first');
  const parked = exits.find(e => e['move-to-state'] === 'blocked');
  assert.ok(parked, JSON.stringify(exits));
  assert.ok(JSON.stringify(parked.condition).includes('"not":{"ticket-system-status":"Done"}'), JSON.stringify(parked.condition));
  assert.deepEqual(validateStateEngine(readEngine(join(ROOT, 'engines', 'grouped-qa', 'workflow.yaml')), ROOT, 'grouped-qa'), []);
});

test('ASS-282 AC2: at qa/qa-testing with the ticket system On Hold, grouped-qa ends at blocked and the parent qa moves to blocked', () => {
  const { trail, end, rests } = fromQa('On Hold');
  assert.deepEqual(trail, ['example-development-grouped/qa', 'grouped-qa/qa-testing', 'grouped-qa/blocked', 'example-development-grouped/blocked']);
  assert.equal(end, 'blocked');
  assert.equal(rests, false);
});

test('ASS-282 AC2: any other non-Done status QA sets blocks the same way', () => {
  for (const status of ['On Hold', 'In Progress', 'To Do', 'Backlog', 'In Review', 'Blocked', 'Won\'t Do']) {
    assert.deepEqual(fromQa(status).trail.slice(-2), ['grouped-qa/blocked', 'example-development-grouped/blocked'], status);
  }
});

test('ASS-282: In Testing — QA still at work, the qa step\'s pairing — and an unknown status leave the ticket waiting at qa-testing', () => {
  for (const status of ['In Testing', null, undefined]) {
    const { trail, end, rests } = fromQa(status);
    assert.deepEqual(trail, ['example-development-grouped/qa', 'grouped-qa/qa-testing'], String(status));
    assert.equal(end, 'qa-testing', String(status));
    assert.equal(rests, true, String(status));
  }
  assert.equal(stepOf(engines['example-development-grouped'], 'qa')['paired-ticket-system-status'], 'In Testing', 'the status the parent pairs with QA in progress');
});

test('ASS-282 AC3: at qa/qa-testing with the ticket system Done, it still goes to done', () => {
  const { trail, end } = walk(engines, 'example-development-grouped', { from: 'qa', answers: { 'grouped-qa/qa-testing': { ticketSystemStatus: 'Done' } } });
  assert.deepEqual(trail, ['example-development-grouped/qa', 'grouped-qa/qa-testing', 'grouped-qa/done', 'example-development-grouped/done']);
  assert.equal(end, 'done');
});

test('ASS-282: a non-Done status at qa-testing is its own run\'s to answer — no gap for gap resolution; In Testing is no gap at all', () => {
  const at = { 'harness-status': { 'state-engine': 'example-development-grouped', state: 'qa', 'sub-status': { 'state-engine': 'grouped-qa', state: 'qa-testing' } } };
  for (const status of ['On Hold', 'In Progress', 'Done']) assert.equal(answersGap(engines['example-development-grouped'], at, status, engines), true, status);
});

// ASS-576 AC4: the move to qa set In Testing in Jira but acli failed, so it is pending; a sync then read Jira's stale
// In Review. qa-testing reads the facts control builds (ticketFacts): it parks, not blocked. Without the pending, In
// Review still blocks (ASS-282); Done upstream (QA, or a human) still ends at done.
const factsOf = ticket => ticketFacts({ paths: { projects: '/nowhere' }, log: () => {} }, { id: 'p' }, ticket, { name: 'A' }, 0).ticketSystemStatus;
const pendingTesting = { status: 'In Testing', from: 'In Review', at: '2026-11-24T09:44:00Z', error: 'unauthorized' };

test('ASS-576 AC4: at qa/qa-testing with a transition to In Testing pending and the synced status a stale In Review, it waits — not blocked', () => {
  const { trail, end, rests } = fromQa(factsOf({ key: 'CLW-1', 'ticket-system-status': 'In Review', 'pending-ticket-system-status': pendingTesting }));
  assert.deepEqual(trail, ['example-development-grouped/qa', 'grouped-qa/qa-testing']);
  assert.equal(end, 'qa-testing');
  assert.equal(rests, true);
});

test('ASS-576 AC4: with no transition pending, In Review at qa-testing still blocks (ASS-282); Done still ends at done', () => {
  assert.equal(fromQa(factsOf({ key: 'CLW-1', 'ticket-system-status': 'In Review' })).end, 'blocked');
  const { end } = walk(engines, 'example-development-grouped', { from: 'qa', answers: { 'grouped-qa/qa-testing': { ticketSystemStatus: factsOf({ key: 'CLW-1', 'ticket-system-status': 'Done' }) } } });
  assert.equal(end, 'done');
});
