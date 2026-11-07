import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateMetrics, metricLines } from '../../src/tui/metrics.js';
// A harness-status at `state` of the example-development engine.
const hs = state => ({ state, 'state-engine': 'example-development' });

const MIN = 60000;
const at = minutes => new Date(Date.UTC(2026, 8, 21, 9) + minutes * MIN).toISOString().replace('.000', '');
const change = (from, to, minutes, dispatches = []) => ({ 'from-state': from, 'to-state': to, timestamp: at(minutes), 'agent-dispatch-log': dispatches });

// A finished dispatch: sent at `minutes`, running `ran` minutes.
const sent = (minutes, ran, cost, [input, output, cacheRead, cacheWrite]) => ({
  'dispatched-to': 'Peter-Pan', timestamp: at(minutes), 'completed-timestamp': at(minutes + ran), 'cost-usd': cost,
  tokens: { input, output, 'cache-read': cacheRead, 'cache-write': cacheWrite },
});

// plan twice, then once on another ticket; a third ticket still in plan.
const back = (dispatches = []) => ({ 'state-changes': [change('committed', 'plan', 0, dispatches), change('plan', 'review', 30), change('review', 'plan', 40), change('plan', 'review', 50)] });
const once = (dispatches = []) => ({ 'state-changes': [change('committed', 'plan', 0, dispatches), change('plan', 'review', 30)] });
const fresh = { 'state-changes': [change('committed', 'plan', 0)] };
const STEPS = [{ id: 'committed', sequence: 2 }, { id: 'plan', sequence: 3 }, { id: 'review', sequence: 4 }, { id: 'done', sequence: 5 }];

test('a visit runs from a change into a state to the next change; one still open, or one whose arrival is unknown, is left out', () => {
  const metrics = stateMetrics([back()], STEPS);
  assert.equal(metrics.plan.timePerVisit, 20 * MIN);                  // 30 and 10 minutes
  assert.equal(metrics.review.timePerVisit, 10 * MIN);                // the second review is still open
  assert.equal(metrics.committed.visits, null);                        // where it started: no arrival time
});

test('a change within a state (a sub-state-change) is part of its visit: no new visit, its dispatches the visit\'s', () => {
  const within = { ...change('plan', 'plan', 10, [sent(10, 5, 1, [1, 1, 1, 1])]), 'sub-state-change': { 'state-engine': 'sub', 'from-state': 'a', 'to-state': 'b' } };
  const { plan } = stateMetrics([{ 'state-changes': [change('committed', 'plan', 0, [sent(0, 5, 1, [1, 1, 1, 1])]), within, change('plan', 'review', 30)] }], STEPS);
  assert.equal(plan.visits, 1);
  assert.equal(plan.timePerVisit, 30 * MIN);
  assert.equal(plan.dispatchesPerVisit, 2);
});

test('subset that visited: the finished visits over the tickets that finished one', () => {
  assert.equal(stateMetrics([back(), once(), fresh], STEPS).plan.visits, 1.5);   // 3 visits, 2 tickets
});

test('tickets visited: the tickets ever in the state, where they started, are now, or passed through', () => {
  const metrics = stateMetrics([back(), once(), fresh, { 'harness-status': hs('committed') }], STEPS);
  assert.deepEqual(STEPS.map(s => metrics[s.id].tickets), [4, 3, 2, 0]);
});

test('visits per ticket: every visit, open or finished, over the tickets that visited the state or one of higher sequence; none such, none to show', () => {
  const skipped = { 'state-changes': [change('committed', 'review', 0)] };
  const metrics = stateMetrics([back(), once(), fresh, skipped], STEPS);
  assert.equal(metrics.plan.visitsPerTicket, 1);                       // 2 + 1 + 1 visits over 4 tickets, the one that skipped it among them
  assert.equal(metrics.review.visitsPerTicket, 4 / 3);
  assert.equal(metrics.committed.visitsPerTicket, 1);
  assert.equal(metrics.done.visitsPerTicket, null);
});

test('per visit: time in the state, agent time and dispatches, a visit without dispatches counting as none; a running dispatch is sent but has run no time yet', () => {
  const running = { 'dispatched-to': 'Spock', timestamp: at(0) };
  const { plan } = stateMetrics([back([sent(0, 6, 1, [1, 1, 1, 1]), running]), once([sent(0, 3, 1, [1, 1, 1, 1])])], STEPS);
  assert.equal(plan.timePerVisit, (30 + 10 + 30) / 3 * MIN);
  assert.equal(plan.agentPerVisit, (6 + 0 + 3) / 3 * MIN);
  assert.equal(plan.dispatchesPerVisit, 1);                            // 3 dispatches over 3 visits
});

test('cost, tokens and cache reads per dispatch: the finished visits\' totals over their finished dispatches; none finished, none to show', () => {
  const back = { 'state-changes': [change('committed', 'plan', 0, [sent(0, 6, 3, [100, 2000, 300000, 20000]), sent(10, 4, 1, [100, 1000, 100000, 10000])]), change('plan', 'review', 30), change('review', 'plan', 40), change('plan', 'review', 50)] };
  const running = { 'state-changes': [change('committed', 'plan', 0, [{ 'dispatched-to': 'Spock', timestamp: at(0) }]), change('plan', 'review', 30), change('review', 'done', 31)] };
  const { plan, review } = stateMetrics([back, running], STEPS);
  assert.equal(plan.costPerDispatch, 2);                               // $4 over 2 finished dispatches; the running one is not counted
  assert.equal(plan.tokensPerDispatch, (100 + 2000 + 20000 + 100 + 1000 + 10000) / 2);
  assert.equal(plan.cacheReadPerDispatch, 200000);
  assert.deepEqual([review.costPerDispatch, review.tokensPerDispatch, review.cacheReadPerDispatch], [null, null, null]);
});

test('metric lines fit a station, their labels left and values right, counts kept to four characters', () => {
  const big = { tickets: 12, visitsPerTicket: 1.5, visits: 1.03, timePerVisit: 90061e3, agentPerVisit: 3599e3, dispatchesPerVisit: 1.17, costPerDispatch: 12.346, tokensPerDispatch: 66749, cacheReadPerDispatch: 1074000 };
  const lines = metricLines(big, true, 29);
  assert.deepEqual(lines, [
    'tickets visited            12',
    'visits per ticket         1.5',
    '↳ subset that visited    1.03',
    'in state per visit      1d 1h',
    'agent time per visit  59m 59s',
    'dispatches per visit     1.17',
    'cost per dispatch      $12.35',
    'tokens per dispatch       67k',
    'cache reads per dispatch 1.1M',
  ]);
  assert.deepEqual(metricLines({ ...big, costPerDispatch: null, tokensPerDispatch: null, cacheReadPerDispatch: null }, true, 29).slice(6).map(l => l.at(-1)), ['—', '—', '—']);
  assert.deepEqual(metricLines(big, false, 29), lines.slice(0, 4));
  assert.deepEqual(metricLines({ tickets: 0, visitsPerTicket: null, visits: null }, true, 29),
    ['tickets visited             0', 'visits per ticket           —', 'no finished visits']);
});

test('a dispatch that finished without a result (killed, or died mid-turn) has no cost or tokens recorded: it counts as none, it does not break the metrics', () => {
  const unrecorded = { 'dispatched-to': 'Superman', timestamp: at(0), 'completed-timestamp': at(4), 'cost-usd': null, tokens: null };
  const { plan } = stateMetrics([{ 'state-changes': [change('committed', 'plan', 0, [sent(0, 6, 2, [100, 200, 50, 10]), unrecorded]), change('plan', 'review', 30)] }], STEPS);
  assert.equal(plan.costPerDispatch, 1);                                // $2 over the 2 finished dispatches
  assert.equal(plan.tokensPerDispatch, 155);                            // (100 + 200 + 10) over 2
  assert.equal(plan.cacheReadPerDispatch, 25);
});
