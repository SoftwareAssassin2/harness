// Blocked (ASS-6): an AI troubleshoots, creates a ticket for the fix, and the
// ticket waits there until that ticket lands; a fix closed unmerged sends it
// round Blocked again, whose max-visits hand it to a human after three.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineDir } from '../support/engine-walk.js';
import { inOrder } from '../support/engine-walk.js';

const read = path => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const blocked = read('engines/blocked/state-engine.json');
const step = id => blocked.steps.find(s => s.id === id);
const to = (id, condition) => step(id)['exit-events'].find(e => JSON.stringify(e.condition) === JSON.stringify(condition))?.['move-to-state'];

test('the blocked engine troubleshoots, creates the fix ticket, records the wait on it and waits until it lands', () => {
  assert.ok(inOrder(blocked.steps.map(s => s.id), ['troubleshoot', 'create-fix-ticket', 'wait-on', 'await-fix', 'done']));
  assert.equal(step('troubleshoot').action.prompt, 'troubleshoot-block');
  assert.equal(to('troubleshoot', { 'turn-complete': true }), 'create-fix-ticket');
  assert.equal(step('create-fix-ticket').action.engine, 'create-ticket');
  assert.equal(step('wait-on').action.command, './agent.sh ticket:wait-on {project} {work-item} {variation} {ticket}');
  const wait = step('await-fix');
  assert.deepEqual([wait.action.command, wait.action.mode, wait['record-script-output']], ['./agent.sh ticket:fix-landed {project} {work-item} {variation}', 'timer', true]);
  assert.equal(to('await-fix', { 'exit-code': 0 }), 'done');                                 // landed
  assert.equal(to('await-fix', { 'exit-code': 3 }), 'done');                                 // closed unmerged: done, landed false
});

test('in both development engines, a fix closed unmerged sends the ticket round Blocked again — three visits hand it to a human; a landed fix returns it', () => {
  for (const engine of ['example-development', 'harness-development']) {
    const b = JSON.parse(readFileSync(join(engineDir(engine), 'state-engine.json'), 'utf8')).steps.find(s => s.id === 'blocked');
    assert.deepEqual([b['max-visits'], b['on-max-visits']], [3, 'blocked-for-human'], engine);
    assert.deepEqual(b['exit-events'][0], { condition: { all: [{ 'is-done': true }, { 'structured-output': { landed: false } }] }, 'move-to-state': 'blocked' }, engine);
    assert.deepEqual(b['exit-events'][1], { condition: { 'is-done': true }, 'follow-return-to-state': true }, engine);
  }
});
