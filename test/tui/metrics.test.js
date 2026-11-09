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

// ASS-331: a sub-flow's stations, from the changes made under its parent path. inside(parents, from, to, minutes)
// — a change made within the steps `parents` names, top first: each a change within its step, the last one's
// sub-state-change from `from` to `to`.
const inside = (parents, from, to, minutes, dispatches = []) => ({
  ...change(parents[0], parents[0], minutes, dispatches),
  'sub-state-change': parents.slice(1).reduceRight((below, step) => ({ 'from-state': step, 'to-state': step, 'sub-state-change': below }), { 'from-state': from, 'to-state': to }),
});
const SUB = [{ id: 'draft', sequence: 1 }, { id: 'code', sequence: 2 }, { id: 'check', sequence: 3 }];

test('ASS-331 AC2: a sub-state\'s visit ends when its parent step is left, not when the sub-flow is next entered; its first state in each parent visit arrives with the parent', () => {
  const twice = { 'state-changes': [
    change('committed', 'plan', 0), inside(['plan'], 'draft', 'code', 10), change('plan', 'review', 30),         // draft 0–10, code 10–30
    change('review', 'plan', 100), inside(['plan'], 'draft', 'code', 105), change('plan', 'review', 125),        // draft 100–105, code 105–125
  ] };
  const { draft, code } = stateMetrics([twice], SUB, ['plan']);
  assert.equal(draft.visits, 2);
  assert.equal(draft.timePerVisit, (10 + 5) / 2 * MIN);
  assert.equal(code.visits, 2);
  assert.equal(code.timePerVisit, 20 * MIN);
  assert.equal(draft.tickets, 1);
});

test('ASS-331 AC2: a sub-flow entered with a change from no state: its first state arrives with that change', () => {
  const entered = { 'state-changes': [change('committed', 'plan', 0), inside(['plan'], null, 'draft', 2), inside(['plan'], 'draft', 'code', 10), change('plan', 'review', 30)] };
  const { draft, code } = stateMetrics([entered], SUB, ['plan']);
  assert.equal(draft.timePerVisit, 8 * MIN);
  assert.equal(code.timePerVisit, 20 * MIN);
  assert.equal(draft.visitsPerTicket, 1);
});

test('ASS-331 AC2, AC3: a sub-state\'s dispatches are its own visit\'s, a deeper one\'s joining it; the parent step\'s stay as they were, its sub-steps\' among them', () => {
  const run = { 'state-changes': [
    change('committed', 'plan', 0, [sent(0, 1, 1, [1, 1, 1, 1])]),
    inside(['plan'], 'draft', 'code', 10, [sent(10, 6, 2, [1, 1, 1, 1])]),
    inside(['plan', 'code'], null, 'deep', 12, [sent(12, 4, 4, [1, 1, 1, 1])]),                              // deeper, within code's visit
    change('plan', 'review', 30),
  ] };
  const { draft, code } = stateMetrics([run], SUB, ['plan']);
  assert.equal(draft.dispatchesPerVisit, 0);                           // the change into plan is plan's own
  assert.equal(code.dispatchesPerVisit, 2);
  assert.equal(code.agentPerVisit, 10 * MIN);
  assert.equal(code.costPerDispatch, 3);
  const { plan } = stateMetrics([run], STEPS);
  assert.deepEqual([plan.visits, plan.timePerVisit, plan.dispatchesPerVisit, plan.costPerDispatch], [1, 30 * MIN, 3, 7 / 3]);
});

test('ASS-331 AC2: two levels deep, a sub-sub-state\'s visit ends when its own parent sub-state is left, and again when the top step is', () => {
  const deep = { 'state-changes': [
    change('committed', 'plan', 0), inside(['plan'], null, 'check', 1),
    inside(['plan', 'check'], null, 'inspect', 2), inside(['plan', 'check'], 'inspect', 'magnify', 5),
    inside(['plan'], 'check', 'code', 9),                                                                     // magnify 5–9: check left
    inside(['plan'], 'code', 'check', 20), inside(['plan', 'check'], null, 'inspect', 21),
    change('plan', 'review', 24),                                                                             // inspect 21–24: plan left
  ] };
  const metrics = stateMetrics([deep], [{ id: 'inspect', sequence: 1 }, { id: 'magnify', sequence: 2 }], ['plan', 'check']);
  assert.equal(metrics.inspect.timePerVisit, (3 + 3) / 2 * MIN);
  assert.equal(metrics.magnify.timePerVisit, 4 * MIN);
  assert.equal(stateMetrics([deep], SUB, ['plan']).check.timePerVisit, (8 + 4) / 2 * MIN);
});

test('ASS-331 AC2: a variation still inside the sub-flow: its open visit counts as a visit, not a finished one', () => {
  const still = { 'state-changes': [change('committed', 'plan', 0), inside(['plan'], null, 'draft', 1), inside(['plan'], 'draft', 'code', 10)] };
  const { draft, code } = stateMetrics([still], SUB, ['plan']);
  assert.equal(draft.timePerVisit, 9 * MIN);
  assert.deepEqual([code.tickets, code.visitsPerTicket, code.visits, code.timePerVisit], [1, 1, null, null]);
  const untracked = { 'harness-status': { ...hs('plan'), 'sub-status': { state: 'code', 'state-engine': 'sub' } } };   // in it with no history
  assert.equal(stateMetrics([untracked], SUB, ['plan']).code.tickets, 1);
  assert.equal(stateMetrics([untracked], SUB, ['review']).code.tickets, 0);
});

test('ASS-331 AC3: the same sub-engine under two parent steps, or at two depths, has each station\'s metrics from its own parent path alone', () => {
  const both = { 'state-changes': [
    change('committed', 'plan', 0), inside(['plan'], null, 'draft', 0), inside(['plan'], 'draft', 'code', 10),   // draft 10 minutes under plan
    change('plan', 'review', 20), inside(['review'], null, 'draft', 20), change('review', 'done', 60),          // 40 under review
    inside(['done', 'check'], null, 'draft', 60), inside(['done', 'check'], 'draft', 'code', 61),              // 1 under done › check
  ] };
  assert.equal(stateMetrics([both], SUB, ['plan']).draft.timePerVisit, 10 * MIN);
  assert.equal(stateMetrics([both], SUB, ['review']).draft.timePerVisit, 40 * MIN);
  assert.equal(stateMetrics([both], SUB, ['done', 'check']).draft.timePerVisit, 1 * MIN);
  assert.equal(stateMetrics([both], SUB, ['done']).draft.tickets, 0);
});
