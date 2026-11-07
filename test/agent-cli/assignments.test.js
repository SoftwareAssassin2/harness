// The assignments:* commands control uses to create, track and end agent
// assignments in assignments.json (status-update has its own test file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, ASSIGNMENT_ID, STAMP, UUID } from './harness-fixture.js';

// What a command may write, parsed: a write taken back leaves the same data, if not the same bytes.
const written = f => [f.assignments(), f.harness(), f.lastModelUsed(), f.sprint()];
const fails = (f, promise, message) => assert.rejects(promise, e => message.test(e.stderr)).then(() => f);

test('assignments:create makes agent-count records sharing one assignment-id, the first the pen-holder, named by the first free names and modelled round robin from after last-model-used', async () => {
  const f = fixture();
  const { stdout } = await f.agent('assignments:create', 'p', 'example-development', 'generate-solution', 'generate-solution', '2', 'true', 'ABC-3', 'A', '-');
  const created = JSON.parse(stdout);
  assert.equal(created.length, 2);
  const [hulk, thor] = created;
  assert.match(hulk['assignment-id'], UUID);
  assert.notEqual(hulk['assignment-id'], ASSIGNMENT_ID);
  assert.match(hulk['start-time'], STAMP);
  assert.deepEqual(hulk, {
    'process-id': null, 'session-id': null, model: 'claude-sonnet-5', 'start-time': hulk['start-time'], 'last-heartbeat': hulk['start-time'],
    'agent-name': 'Hulk', project: 'p', 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'example-development', state: 'generate-solution', prompt: 'generate-solution',
    status: 'Starting', 'is-lead': true, 'assignment-id': hulk['assignment-id'], 'agent-count': 2, 'pen-holder': 'Hulk', approvals: {},
    'ai-feedback-short': null, 'ai-feedback-long': null, 'working-in-dev-container': true, 'ai-status-update-short': null, 'last-ai-status-update': null,
  });
  assert.deepEqual({ ...thor, 'start-time': 'T', 'last-heartbeat': 'T' }, { ...hulk, 'agent-name': 'Thor', model: 'claude-opus-4-8', 'is-lead': false, 'start-time': 'T', 'last-heartbeat': 'T' });
  assert.deepEqual(f.assignments().assignments.slice(3), created);              // appended after the existing three
  assert.equal(f.lastModelUsed(), 'claude-opus-4-8');
  assert.equal('last-model-used' in f.harness(), false);                       // its own file, not harness.json
  // Each agent is logged as dispatched on the variation's latest state change.
  const log = f.variation('A')['state-changes'][1]['agent-dispatch-log'];
  assert.deepEqual(log.slice(2).map(d => ({ ...d, timestamp: 'T' })), [
    { 'dispatched-to': 'Hulk', timestamp: 'T', 'completed-timestamp': null, 'cost-usd': null, tokens: null },
    { 'dispatched-to': 'Thor', timestamp: 'T', 'completed-timestamp': null, 'cost-usd': null, tokens: null },
  ]);
  assert.match(log[2].timestamp, STAMP);
  assert.equal(f.variation('A')['state-changes'][0]['agent-dispatch-log'].length, 1);  // the earlier change untouched
  // The round robin wraps, and skips the names just handed out.
  const more = JSON.parse((await f.agent('assignments:create', 'p', 'example-development', 'generate-solution', 'generate-solution', '1', 'false', 'ABC-3', 'A', '-')).stdout);
  assert.deepEqual(more.map(r => [r['agent-name'], r.model, r['working-in-dev-container']]), [['Yoda', 'claude-opus-5', false]]);
});

test('assignments:create rotates only over the claude models the step prompt\'s supported-models names, in harness.json order, and over them all when it names none of them or has none (ASS-85)', async () => {
  const f = fixture();
  const setModels = (prompt, models) => {
    const file = join(f.dir, 'prompts', prompt, 'prompt.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'supported-models': models }));
  };
  const models = async (prompt, count) => JSON.parse((await f.agent('assignments:create', 'p', 'self-healing', 'analyze', prompt, String(count), 'false', '-', '-', 'eeeeeeee-0000-4000-8000-000000000009')).stdout).map(r => r.model);
  const free = () => writeFileSync(join(f.dir, 'assignments.json'), JSON.stringify({ ...f.assignments(), assignments: [] }));
  // last-model-used is claude-opus-5: claude-sonnet-5 is skipped, and the turn wraps in harness.json's order, not the prompt's.
  setModels('find-existing-ticket', ['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5']);
  assert.deepEqual(await models('find-existing-ticket', 3), ['claude-opus-4-8', 'claude-opus-5', 'claude-opus-4-8']);
  assert.equal(f.lastModelUsed(), 'claude-opus-4-8');
  free();
  // A last model the prompt does not name still places the turn: after claude-sonnet-5 comes claude-opus-4-8.
  writeFileSync(join(f.dir, 'last-model-used'), 'claude-sonnet-5');
  assert.deepEqual(await models('find-existing-ticket', 1), ['claude-opus-4-8']);
  free();
  // Naming none of harness.json's claude models, or no supported-models at all, the whole list rotates.
  setModels('find-existing-ticket', ['gpt-6-astra']);
  assert.deepEqual(await models('find-existing-ticket', 2), ['claude-opus-5', 'claude-sonnet-5']);
  free();
  assert.deepEqual(await models('apply-fix', 2), ['claude-opus-4-8', 'claude-opus-5']);   // apply-fix has no prompt.json
});

test('assignments:create for a transient engine keys the record by the engine, a problem when given, and logs no dispatch; with a work-item too it logs on the latest change whatever the state', async () => {
  const f = fixture();
  const before = f.sprint();
  const [r] = JSON.parse((await f.agent('assignments:create', 'p', 'self-healing', 'apply-fix', 'apply-fix', '1', 'false', '-', '-', 'eeeeeeee-0000-4000-8000-000000000009', 'the build is red')).stdout);
  assert.equal(r['transient-state-engine'], 'eeeeeeee-0000-4000-8000-000000000009');
  assert.equal(r.problem, 'the build is red');
  assert.ok(!('work-item' in r) && !('variation' in r));
  assert.deepEqual(f.sprint(), before);
  // A sub-engine step of a ticket: the variation is at local-testing, not at the sub-state.
  const [s] = JSON.parse((await f.agent('assignments:create', 'p', 'test', 'take-screenshots', 'generate-solution', '1', 'false', 'ABC-3', 'B', 'eeeeeeee-0000-4000-8000-000000000002')).stdout);
  assert.deepEqual([s['work-item'], s.variation, s['transient-state-engine'], 'problem' in s], ['ABC-3', 'B', 'eeeeeeee-0000-4000-8000-000000000002', false]);
  assert.deepEqual(f.variation('B')['state-changes'][0]['agent-dispatch-log'].map(d => d['dispatched-to']), [s['agent-name']]);
  // A work-item without a variation (variation -) is kept, as null, and nothing is logged.
  const [n] = JSON.parse((await f.agent('assignments:create', 'p', 'example-development', 'generate-solution', 'generate-solution', '1', 'false', 'ABC-3', '-', '-')).stdout);
  assert.deepEqual([n['work-item'], n.variation], ['ABC-3', null]);
});

test('assignments:create names agents by the free names of agent-names.json used longest ago, never-used first and ties at random, and records when each was used in agent-names-last-used.json only (ASS-29)', async () => {
  const listed = names => names.map(name => ({ name, 'franchise-name': 'F' }));
  const withNames = (f, names, used) => {
    writeFileSync(join(f.dir, 'agent-names.json'), JSON.stringify(listed(names), null, 4));
    if (used) writeFileSync(join(f.dir, 'agent-names-last-used.json'), JSON.stringify(used));
    else rmSync(join(f.dir, 'agent-names-last-used.json'));
    return f;
  };
  const lastUsed = f => JSON.parse(readFileSync(join(f.dir, 'agent-names-last-used.json'), 'utf8'));
  const create = (f, count) => f.agent('assignments:create', 'p', 'example-development', 'generate-solution', 'generate-solution', count, 'true', 'ABC-3', 'A', '-')
    .then(({ stdout }) => JSON.parse(stdout).map(r => r['agent-name']));
  // Used longest ago first, whatever the files' order; a name in use is skipped however long ago it was used.
  const all = ['Daredevil', 'Spock', 'Leia', 'Thor', 'Hulk', 'Yoda'];
  const f = withNames(fixture(), all, { Daredevil: '2026-09-01T00:00:00Z', Thor: '2026-10-03T00:00:00Z', Hulk: '2026-10-02T00:00:00Z', Yoda: '2026-10-01T00:00:00Z', Gone: '2020-01-01T00:00:00Z' });
  const names = readFileSync(join(f.dir, 'agent-names.json'), 'utf8');
  // Spock and Leia are in use (the fixture's records), so never-used counts nothing here; Gone is no name any more.
  assert.deepEqual(await create(f, '2'), ['Yoda', 'Hulk']);
  const used = lastUsed(f);
  assert.match(used.Yoda, STAMP);
  assert.equal(used.Hulk, used.Yoda);                                           // both stamped with their start-time
  assert.equal(used.Yoda, f.assignments().assignments.at(-1)['start-time']);
  assert.equal(used.Thor, '2026-10-03T00:00:00Z');                              // the rest kept
  assert.equal(readFileSync(join(f.dir, 'agent-names.json'), 'utf8'), names);   // the names themselves untouched
  assert.equal('agent-names-last-used' in f.harness(), false);                 // not in harness.json
  assert.deepEqual(await create(f, '1'), ['Thor']);
  // No agent-names-last-used.json: every name never used; it is made on the first write.
  const fresh = withNames(fixture(), all);
  const [first] = await create(fresh, '1');
  assert.deepEqual(Object.keys(lastUsed(fresh)), [first]);
  // A never-used name comes before any used one; among several, which is random.
  const picks = new Set();
  for (let i = 0; i < 12; i++) {
    const [name] = await create(withNames(fixture(), all, { Hulk: '2026-10-01T00:00:00Z' }), '1');
    assert.ok(['Daredevil', 'Thor', 'Yoda'].includes(name), name);
    picks.add(name);
  }
  assert.ok(picks.size >= 2);                                                    // about 1 in 177,000 to fail by chance
});

test('assignments:create fails, writing nothing, on a bad count, an unknown project, engine or prompt, a variation elsewhere, too few free names, or no context', async () => {
  const f = fixture();
  const before = written(f);
  const create = (...args) => f.agent('assignments:create', 'p', 'example-development', 'generate-solution', 'generate-solution', ...args);
  await fails(f, create('0', 'true', 'ABC-3', 'A', '-'), /agent-count must be a whole number from 1/);
  await fails(f, create('x', 'true', 'ABC-3', 'A', '-'), /agent-count/);
  await fails(f, create('1', 'maybe', 'ABC-3', 'A', '-'), /usage/);
  await fails(f, create('1', 'true', 'ABC-3', 'A'), /usage/);
  await fails(f, f.agent('assignments:create', 'nope', 'example-development', 'generate-solution', 'generate-solution', '1', 'true', 'ABC-3', 'A', '-'), /no project nope/);
  await fails(f, f.agent('assignments:create', 'p', 'nope', 'generate-solution', 'generate-solution', '1', 'true', 'ABC-3', 'A', '-'), /no state engine nope/);
  await fails(f, f.agent('assignments:create', 'p', 'example-development', 'generate-solution', 'nope', '1', 'true', 'ABC-3', 'A', '-'), /no prompt nope/);
  await fails(f, f.agent('assignments:create', 'p', 'example-development', 'local-testing', 'generate-solution', '1', 'true', 'ABC-3', 'A', '-'), /not at local-testing/);
  await fails(f, create('4', 'true', 'ABC-3', 'A', '-'), /not enough free agent names/);
  await fails(f, create('1', 'true', '-', '-', '-'), /a work-item or a transient state engine/);
  assert.deepEqual(written(f), before);   // the variation elsewhere: its records written, then taken back out (ASS-178)
});

test('assignments:set-account records the Claude account an agent runs on — email, org, subscription, - for none (ASS-25)', async () => {
  const f = fixture();
  await f.agent('assignments:set-account', 'Spock', 'me@example.com', 'My Org', 'max');
  assert.deepEqual(f.assignments().assignments[1].account, { email: 'me@example.com', org: 'My Org', subscription: 'max' });
  await f.agent('assignments:set-account', 'Spock', '-', '-', '-');
  assert.deepEqual(f.assignments().assignments[1].account, { email: null, org: null, subscription: null });
  const before = JSON.stringify(f.assignments());
  await assert.rejects(f.agent('assignments:set-account', 'Nobody', 'a', 'b', 'c'), /no assignment for Nobody/);
  await assert.rejects(f.agent('assignments:set-account', 'Spock', 'a'), /usage/);
  assert.equal(JSON.stringify(f.assignments()), before);
});

test('assignments:set-process, :heartbeat and :set-status write the running process, a heartbeat and a status on the record', async () => {
  const f = fixture();
  await f.agent('assignments:set-process', 'Spock', '4242', 'sess-1');
  let spock = f.assignments().assignments[1];
  assert.deepEqual([spock['process-id'], spock['session-id'], spock.status], [4242, 'sess-1', 'Running']);
  assert.match(spock['last-heartbeat'], STAMP);
  assert.notEqual(spock['last-heartbeat'], '2026-10-07T23:52:05Z');
  await f.agent('assignments:set-process', 'Spock', '4243', '-');
  assert.equal(f.assignments().assignments[1]['session-id'], null);
  const beat = f.assignments().assignments[1]['last-heartbeat'];
  await f.agent('assignments:heartbeat', 'Leia');
  spock = f.assignments().assignments[1];
  assert.equal(spock['last-heartbeat'], beat);
  assert.match(f.assignments().assignments[2]['last-heartbeat'], STAMP);
  await f.agent('assignments:set-status', 'Spock', 'Shutting Down');
  assert.equal(f.assignments().assignments[1].status, 'Shutting Down');
  await f.agent('assignments:set-status', 'Spock', 'Ended');
  assert.equal(f.assignments().assignments[1].status, 'Ended');
});

test('assignments:set-process, :heartbeat and :set-status fail, writing nothing, for no assignment, a bad pid or an unknown status', async () => {
  const f = fixture();
  const before = f.snapshot();
  await fails(f, f.agent('assignments:set-process', 'Hulk', '1', '-'), /no assignment for Hulk/);
  await fails(f, f.agent('assignments:set-process', 'Spock', 'abc', '-'), /pid must be a whole number/);
  await fails(f, f.agent('assignments:set-process', 'Spock', '1'), /usage/);
  await fails(f, f.agent('assignments:heartbeat', 'Hulk'), /no assignment for Hulk/);
  await fails(f, f.agent('assignments:heartbeat'), /usage/);
  await fails(f, f.agent('assignments:set-status', 'Spock', 'Sleeping'), /usage/);
  await fails(f, f.agent('assignments:set-status', 'Hulk', 'Ended'), /no assignment for Hulk/);
  assert.equal(f.snapshot(), before);
});

test('assignments:approve stamps the approval on every record of the assignment', async () => {
  const f = fixture();
  await f.agent('assignments:approve', 'Spock');
  const [daredevil, spock, leia] = f.assignments().assignments;
  assert.deepEqual(Object.keys(daredevil.approvals), ['Spock']);
  assert.match(spock.approvals.Spock, STAMP);
  assert.equal(daredevil.approvals.Spock, spock.approvals.Spock);
  assert.deepEqual(leia.approvals, {});
  await f.agent('assignments:approve', 'Daredevil');
  assert.deepEqual(Object.keys(f.assignments().assignments[1].approvals), ['Spock', 'Daredevil']);
  const before = f.snapshot();
  await fails(f, f.agent('assignments:approve', 'Hulk'), /no assignment for Hulk/);
  await fails(f, f.agent('assignments:approve'), /usage/);
  assert.equal(f.snapshot(), before);
});

test('assignments:remove drops the record, printing it, and completes the agent\'s dispatch on the variation, with cost and tokens when given', async () => {
  const f = fixture();
  const { stdout } = await f.agent('assignments:remove', 'Spock', '1.25', '1000', '200', '30', '40');
  assert.equal(JSON.parse(stdout)['agent-name'], 'Spock');
  assert.deepEqual(f.assignments().assignments.map(a => a['agent-name']), ['Daredevil', 'Leia']);
  const log = f.variation('A')['state-changes'][1]['agent-dispatch-log'];
  assert.match(log[1]['completed-timestamp'], STAMP);
  assert.deepEqual({ ...log[1], 'completed-timestamp': 'T' }, { 'dispatched-to': 'Spock', timestamp: '2026-10-07T23:52:05Z', 'completed-timestamp': 'T', 'cost-usd': 1.25, tokens: { input: 1000, output: 200, 'cache-read': 30, 'cache-write': 40 } });
  assert.equal(log[0]['completed-timestamp'], null);                           // Daredevil's, still open
  await f.agent('assignments:remove', 'Daredevil');                            // without the cost: only completed
  const [daredevil] = f.variation('A')['state-changes'][1]['agent-dispatch-log'];
  assert.match(daredevil['completed-timestamp'], STAMP);
  assert.deepEqual([daredevil['cost-usd'], daredevil.tokens], [null, null]);
  await f.agent('assignments:remove', 'Leia');                                 // no work-item: nothing to complete
  assert.deepEqual(f.assignments().assignments, []);
});

test('assignments:remove fails, writing nothing, for no assignment or a malformed cost', async () => {
  const f = fixture();
  const before = f.snapshot();
  await fails(f, f.agent('assignments:remove', 'Hulk'), /no assignment for Hulk/);
  await fails(f, f.agent('assignments:remove', 'Spock', '1.25'), /usage/);
  await fails(f, f.agent('assignments:remove', 'Spock', 'free', '1', '2', '3', '4'), /numbers/);
  assert.equal(f.snapshot(), before);
});

test('ASS-147 AC1: assignments:remove --memory <recalls> <returned> <saves> <deletes> records the session\'s memory use on its dispatch, with or without the cost', async () => {
  const f = fixture();
  await f.agent('assignments:remove', 'Spock', '1.25', '1000', '200', '30', '40', '--memory', '3', '4', '1', '0');
  const [daredevil, spock] = f.variation('A')['state-changes'][1]['agent-dispatch-log'];
  assert.deepEqual([spock['cost-usd'], spock.memory], [1.25, { recalls: 3, returned: 4, saves: 1, deletes: 0 }]);
  assert.equal(daredevil.memory, undefined);                                   // still open: nothing counted yet
  await f.agent('assignments:remove', 'Daredevil', '--memory', '0', '0', '0', '0');   // exited without a result: zeros all the same
  const [done] = f.variation('A')['state-changes'][1]['agent-dispatch-log'];
  assert.deepEqual([done['cost-usd'], done.memory], [null, { recalls: 0, returned: 0, saves: 0, deletes: 0 }]);
  const before = f.snapshot();
  await fails(f, f.agent('assignments:remove', 'Leia', '--memory', '1', 'x', '0', '0'), /numbers/);
  await fails(f, f.agent('assignments:remove', 'Leia', '--memory', '1'), /usage/);
  assert.equal(f.snapshot(), before);
});

test('ASS-216 AC1: assignments:remove --billing <subscription|api> records what the dispatch was billed to, before --memory, with or without the cost', async () => {
  const f = fixture();
  await f.agent('assignments:remove', 'Spock', '0', '1000', '200', '30', '40', '--billing', 'subscription', '--memory', '0', '0', '0', '0');
  const [daredevil, spock] = f.variation('A')['state-changes'][1]['agent-dispatch-log'];
  assert.deepEqual([spock['cost-usd'], spock.billing], [0, 'subscription']);
  assert.equal(daredevil.billing, undefined);                                  // still open
  await f.agent('assignments:remove', 'Daredevil', '--billing', 'api');        // exited without a result
  const [done] = f.variation('A')['state-changes'][1]['agent-dispatch-log'];
  assert.deepEqual([done['cost-usd'], done.billing], [null, 'api']);
  const before = f.snapshot();
  await fails(f, f.agent('assignments:remove', 'Leia', '--billing', 'free'), /billing/);
  assert.equal(f.snapshot(), before);
});

test('ASS-217 AC2: assignments:set-account records the payment method control chose; assignments:remove carries it onto the dispatch beside its billing', async () => {
  const f = fixture();
  await f.agent('assignments:set-account', 'Spock', 'me@example.com', 'My Org', 'max', 'api');
  assert.equal(f.assignments().assignments[1]['payment-method'], 'api');
  const before = JSON.stringify(f.assignments());
  await assert.rejects(f.agent('assignments:set-account', 'Spock', 'a', 'b', 'c', 'free'), /payment method must be subscription or api/);
  assert.equal(JSON.stringify(f.assignments()), before);
  await f.agent('assignments:remove', 'Spock', '1.5', '1', '1', '1', '1', '--billing', 'api');
  await f.agent('assignments:remove', 'Daredevil', '--billing', 'subscription');   // none chosen: none carried
  const [daredevil, spock] = f.variation('A')['state-changes'][1]['agent-dispatch-log'];
  assert.deepEqual([spock.billing, spock['payment-method']], ['api', 'api']);
  assert.equal(daredevil['payment-method'], undefined);
});

test('ASS-272 AC2: assignments:remove given no --billing records one from the record\'s payment-method, else the project\'s login (claude-usage.json\'s auth-method), a subscription\'s cost zeroed; neither known, none', async () => {
  const usage = (f, authMethod) => writeFileSync(join(f.dir, 'projects', 'p', 'claude-usage.json'), JSON.stringify({ email: 'me@example.com', 'auth-method': authMethod }));
  const logged = f => f.variation('A')['state-changes'][1]['agent-dispatch-log'].map(d => [d.billing, d['cost-usd']]);
  // The payment-method over the login: api on a claude.ai login, the cost kept.
  const f = fixture();
  usage(f, 'claude.ai');
  await f.agent('assignments:set-account', 'Spock', 'me@example.com', 'My Org', 'max', 'api');
  await f.agent('assignments:remove', 'Spock', '1.5', '1', '1', '1', '1', '--memory', '0', '0', '0', '0');
  // No payment-method: the claude.ai login's subscription, the cost zeroed.
  await f.agent('assignments:remove', 'Daredevil', '2.5', '1', '1', '1', '1');
  assert.deepEqual(logged(f), [['subscription', 0], ['api', 1.5]]);
  // An api_key login bills its API key, the cost kept; --billing given still wins.
  const g = fixture();
  usage(g, 'api_key');
  await g.agent('assignments:remove', 'Spock', '1.5', '1', '1', '1', '1');
  await g.agent('assignments:remove', 'Daredevil', '0', '1', '1', '1', '1', '--billing', 'subscription');
  assert.deepEqual(logged(g), [['subscription', 0], ['api', 1.5]]);
  // Neither known (no claude-usage.json): no billing, the cost as given.
  const h = fixture();
  await h.agent('assignments:remove', 'Spock', '1.5', '1', '1', '1', '1');
  assert.deepEqual(logged(h)[1], [undefined, 1.5]);
});

test('ASS-268 AC3: assignments:remove --estimated marks the dispatch\'s cost an estimate (cost-estimated), only beside a cost; an exact cost carries no mark', async () => {
  const f = fixture();
  await f.agent('assignments:remove', 'Spock', '0.7', '20', '40', '60', '80', '--estimated', '--billing', 'api', '--memory', '0', '0', '0', '0');
  await f.agent('assignments:remove', 'Daredevil', '0.5', '10', '20', '30', '40', '--billing', 'api');
  const [daredevil, spock] = f.variation('A')['state-changes'][1]['agent-dispatch-log'];
  assert.deepEqual([spock['cost-usd'], spock['cost-estimated'], spock.billing, spock.tokens], [0.7, true, 'api', { input: 20, output: 40, 'cache-read': 60, 'cache-write': 80 }]);
  assert.deepEqual([daredevil['cost-usd'], 'cost-estimated' in daredevil], [0.5, false]);
  const before = f.snapshot();
  await fails(f, f.agent('assignments:remove', 'Leia', '--estimated'), /usage/);   // an estimate of no cost
  assert.equal(f.snapshot(), before);
});

test('ASS-268 AC2: assignments:record-spend records what an agent whose assignment is gone cost on the dispatch it was logged on — by its name and start time — once; nothing else is touched', async () => {
  const f = fixture();
  await f.agent('assignments:remove', 'Spock');                                // removed by another hand: completed, no cost
  const args = ['p', 'ABC-3', 'A', 'Spock', '2026-10-07T23:52:05Z'];
  await f.agent('assignments:record-spend', ...args, '0.7', '20', '40', '60', '80', '--estimated', '--billing', 'api');
  const [daredevil, spock] = f.variation('A')['state-changes'][1]['agent-dispatch-log'];
  assert.match(spock['completed-timestamp'], STAMP);
  assert.deepEqual([spock['cost-usd'], spock['cost-estimated'], spock.billing, spock.tokens], [0.7, true, 'api', { input: 20, output: 40, 'cache-read': 60, 'cache-write': 80 }]);
  assert.deepEqual([daredevil['cost-usd'], daredevil['completed-timestamp']], [null, null]);   // another agent's, untouched
  const before = f.snapshot();
  await f.agent('assignments:record-spend', ...args, '9', '1', '1', '1', '1');  // recorded already: never twice
  await f.agent('assignments:record-spend', 'p', 'ABC-3', 'A', 'Spock', '2026-10-08T00:00:00Z', '9', '1', '1', '1', '1');   // another dispatch of the name: none
  assert.equal(f.snapshot(), before);
  await fails(f, f.agent('assignments:record-spend', ...args, '9'), /usage/);
  await fails(f, f.agent('assignments:record-spend', ...args, 'free', '1', '1', '1', '1'), /numbers/);
  await fails(f, f.agent('assignments:record-spend', 'p', 'ABC-3', 'Z', 'Spock', '2026-10-07T23:52:05Z', '9', '1', '1', '1', '1'), /no ABC-3 variation Z/);
  assert.equal(f.snapshot(), before);
});

test('assignments:create for a variation with no state change yet (a ticket just synced, never moved) still creates the records, the dispatch unlogged and said so', async () => {
  const f = fixture();
  const file = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  sprint.features[0].variations[0]['state-changes'] = [];
  writeFileSync(file, JSON.stringify(sprint));
  const { stdout, stderr } = await f.agent('assignments:create', 'p', 'test', 'test', 'generate-solution', '1', 'false', 'ABC-3', 'A', 'aaaaaaaa-0000-4000-8000-000000000009');
  assert.equal(JSON.parse(stdout).length, 1);
  assert.deepEqual(f.variation('A')['state-changes'], []);
  assert.match(stderr, /assignments:create: ABC-3\.A has no state change to log the dispatch on; not logged/);
  assert.equal(f.assignments().assignments.at(-1)['transient-state-engine'], 'aaaaaaaa-0000-4000-8000-000000000009');
});

// ASS-178: assignments:create stopped between its writes. The records are
// written first, under the name check, and the dispatch log after them: a stop
// before the log leaves records control removes as stale, never a log entry
// no record will complete.
test('assignments:create that cannot write the records writes no dispatch log (ASS-178)', async () => {
  const f = fixture();
  const before = f.snapshot();
  chmodSync(f.dir, 0o555);                           // the data folder: assignments.json cannot be written
  try { await assert.rejects(f.agent('assignments:create', 'p', 'example-development', 'generate-solution', 'generate-solution', '1', 'true', 'ABC-3', 'A', '-')); }
  finally { chmodSync(f.dir, 0o755); }
  assert.equal(f.snapshot(), before);
});

test('assignments:create that stops at the dispatch log takes its records back out, and runs again cleanly (ASS-178)', async () => {
  const f = fixture();
  const before = written(f);
  const create = () => f.agent('assignments:create', 'p', 'example-development', 'generate-solution', 'generate-solution', '1', 'true', 'ABC-3', 'A', '-');
  const sprint = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10');
  chmodSync(sprint, 0o555);                                                   // the records can be written, the sprint's log cannot
  try { await assert.rejects(create()); } finally { chmodSync(sprint, 0o755); }
  assert.deepEqual(written(f), before);
  const [record] = JSON.parse((await create()).stdout);
  assert.deepEqual(f.assignments().assignments.slice(3).map(a => a['agent-name']), [record['agent-name']]);
  assert.equal(f.variation('A')['state-changes'][1]['agent-dispatch-log'].at(-1)['dispatched-to'], record['agent-name']);
});

test('assignments:remove stopped after the dispatch is completed, before the record goes, removes the record when run again, the dispatch left as it is (ASS-178)', async () => {
  const f = fixture();
  const file = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  sprint.features[0].variations.find(v => v.name === 'A')['state-changes'][1]['agent-dispatch-log'][1]['completed-timestamp'] = '2026-10-27T00:00:00Z';   // the sprint half written
  writeFileSync(file, JSON.stringify(sprint));
  await f.agent('assignments:remove', 'Spock', '1.25', '1000', '200', '30', '40');
  assert.deepEqual(f.assignments().assignments.map(a => a['agent-name']), ['Daredevil', 'Leia']);
  assert.deepEqual(f.variation('A')['state-changes'][1]['agent-dispatch-log'].map(d => d['completed-timestamp']), [null, '2026-10-27T00:00:00Z']);
});
