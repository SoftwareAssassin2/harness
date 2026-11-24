// ASS-576 AC3: a ticket-system transition acli failed to make is recorded on the sprint ticket as
// pending-ticket-system-status; control retries it in the background (src/control/transition-retry.js), once a
// minute per project, by running ticket:set-ticket-system-status again, which clears it once acli succeeds; never
// with TRANSITION_RETRIES_DISABLED=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../../src/control/tick.js';

// Imported so a missing module fails these tests rather than erroring the file before they run.
const retry = await import('../../src/control/transition-retry.js').catch(() => ({}));
const MIN = 60e3;
const START = Date.parse('2026-11-24T10:00:00Z');
const pending = status => ({ 'pending-ticket-system-status': { status, from: 'In Review', at: '2026-11-24T09:44:00Z', error: 'unauthorized' } });
const state = () => ({ harness: {}, projects: [{ id: 'p', tickets: [
  { key: 'ABC-1', 'issue-type': 'Story', 'ticket-system-status': 'In Review', ...pending('In Testing'), variations: [{ name: 'A' }] },
  { key: 'ABC-2', 'issue-type': 'Story', 'ticket-system-status': 'In Progress', variations: [{ name: 'A' }] },
  { key: 'ABC-3', 'issue-type': 'Bug', 'ticket-system-status': 'In Progress', ...pending('In Review'), variations: [{ name: 'A' }] },
  { key: 'ABC-4', 'issue-type': 'Spike', 'ticket-system-status': 'To Do', ...pending('In Progress'), variations: [{ name: 'A' }] },
] }] });
function context(now, fail = new Set()) {
  const calls = [], logs = [];
  const ctx = { memory: { timers: new Map() }, paths: { projects: '/nowhere' }, now: () => new Date(now.at), log: (...a) => logs.push(a.join(' ')), transitionRetries: true,
    cli: async args => { calls.push(args.join(' ')); if (fail.has(args[2])) throw new Error('✗ Failure: unauthorized'); return ''; } };
  return { ctx, calls, logs };
}
const retryTransitions = (ctx, s) => {
  assert.equal(typeof retry.retryTransitions, 'function', 'src/control/transition-retry.js exports retryTransitions');
  return retry.retryTransitions(ctx, s);
};

test('ASS-576 AC3: retryTransitions runs ticket:set-ticket-system-status for each ticket with a pending transition — stories, bugs and spikes — and none without', async () => {
  const { ctx, calls } = context({ at: START });
  await retryTransitions(ctx, state());
  assert.deepEqual(calls.toSorted(), ['ticket:set-ticket-system-status p ABC-1 In Testing', 'ticket:set-ticket-system-status p ABC-3 In Review', 'ticket:set-ticket-system-status p ABC-4 In Progress']);
});

test('ASS-576 AC3: at most once a minute per project', async () => {
  const now = { at: START };
  const { ctx, calls } = context(now);
  const s = state();
  await retryTransitions(ctx, s);
  const first = calls.length;
  now.at += 30e3;
  await retryTransitions(ctx, s);
  assert.equal(calls.length, first, 'not again within the minute');
  now.at = START + (retry.CHECK_EVERY_MS ?? MIN);
  await retryTransitions(ctx, s);
  assert.equal(calls.length, 2 * first);
  assert.equal(retry.CHECK_EVERY_MS, MIN);
});

test('ASS-576 AC3: a retry that fails is logged and the rest go on, nothing thrown; one that succeeds is logged as retried', async () => {
  const { ctx, calls, logs } = context({ at: START }, new Set(['ABC-1']));
  await retryTransitions(ctx, state());
  assert.equal(calls.length, 3);
  assert.ok(logs.some(l => /ABC-1.*unauthorized/.test(l)), logs.join('\n'));
  assert.ok(logs.some(l => /ABC-3 ticket system status → In Review \(retried\)/.test(l)), logs.join('\n'));
  assert.ok(!logs.some(l => /ABC-1 ticket system status →/.test(l)), logs.join('\n'));
});

test('ASS-576 AC3: nothing is retried with ctx.transitionRetries off; a context made with TRANSITION_RETRIES_DISABLED=1 has it off, without it on', async () => {
  const { ctx, calls } = context({ at: START });
  ctx.transitionRetries = false;
  await retryTransitions(ctx, state());
  assert.deepEqual(calls, []);
  assert.equal(createContext({ root: '/nowhere', env: { TRANSITION_RETRIES_DISABLED: '1' } }).transitionRetries, false);
  assert.equal(createContext({ root: '/nowhere', env: {} }).transitionRetries, true);
});
