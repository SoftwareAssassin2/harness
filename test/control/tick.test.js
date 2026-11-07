// The control loop's tick, run against a temp copy of the data (the agent-cli
// fixture) with a fake agent: the JSON files move as the real agent-cli moves
// them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { hs } from '../agent-cli/harness-fixture.js';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';

// Waits until every live agent has ended a turn.
const turnsEnd = ctx => until(() => [...ctx.agents.values()].every(a => a.result));
const usageOf = dir => (existsSync(join(dir, 'usage.json')) ? JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')) : null);

test('tick: the none steps chain in one tick (backlog → committed → plan), the prompt step is dispatched through the agent-cli, the agent started from the record', async () => {
  const f = controlFixture();
  try {
    await tick(f.ctx);
    const v = f.variation();
    assert.equal(v['harness-status'].state, 'plan');
    assert.deepEqual(v['state-changes'].map(c => [c['from-state'], c['to-state'], c['work-is-done']]), [['backlog', 'committed', true], ['committed', 'plan', false]]);
    assert.equal(f.ticket()['ticket-system-status'], 'In Progress');                        // paired status set as the ticket moved
    const [record] = f.assignments().assignments;
    assert.deepEqual([record['work-item'], record.variation, record.state, record.prompt, record.status], ['ABC-3', 'A', 'plan', 'review-plan', 'Running']);
    const live = f.ctx.agents.get(record['agent-name']);
    assert.equal(record['process-id'], live.agent.pid);
    assert.deepEqual(f.inbox(record['agent-name'], record['start-time'].replace(/[-:]/g, '')).length, 1);   // agent:dispatch queued the prompt the process reads
    assert.deepEqual(v['state-changes'][1]['agent-dispatch-log'].map(d => d['dispatched-to']), [record['agent-name']]);
    assert.ok(await turnsEnd(f.ctx));
    assert.ok(f.lines.some(l => /^steps ABC-3 A backlog → committed/.test(l)), f.lines.join('\n'));
    assert.ok(f.lines.some(l => /^dispatch /.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

// ASS-190 AC1/AC2 end to end: dispatch.js passes `usage` (from harness.json's
// model-prices and the merged windows) into startAgent, so the agent writes
// usage.json beside its session.txt; and on a result that names a window it
// persists it to context-windows.json through the real locked
// harness:set-context-window CLI — not a mock. That write is fire-and-forget
// from a synchronous onResult, so the assertion polls with until(...).
test('ASS-190 AC1/AC2: a dispatched agent writes usage.json beside session.txt, and a result window is learned into context-windows.json through the locked CLI', async () => {
  const f = controlFixture();
  const harness = JSON.parse(readFileSync(join(f.dir, 'harness.json'), 'utf8'));
  writeFileSync(join(f.dir, 'harness.json'), JSON.stringify({ ...harness, 'model-prices': { 'fake-model': { input: 3, output: 15, 'cache-read': 0.3, 'cache-write': 3.75 } } }));
  process.env.FAKE_CONTEXT_WINDOW = '200000';
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    const live = f.ctx.agents.get(record['agent-name']);
    assert.ok(await turnsEnd(f.ctx));
    assert.ok(await until(() => { const u = usageOf(live.agent.dir); return u?.model === 'fake-model' && u.contextTokens === 80; }));
    const u = usageOf(live.agent.dir);
    assert.deepEqual(u.tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
    assert.equal(u.contextWindow, 200000);
    const windows = () => (existsSync(f.env.CONTEXT_WINDOWS_FILE) ? JSON.parse(readFileSync(f.env.CONTEXT_WINDOWS_FILE, 'utf8')) : null);
    assert.ok(await until(() => windows()?.['fake-model'] === 200000), 'the learned window lands through the locked CLI');
  } finally {
    delete process.env.FAKE_CONTEXT_WINDOW;
    f.ctx.stopAgents();
  }
});

test('tick: a dispatched agent\'s record carries the Claude account it runs on, from claude auth status (ASS-25); one not logged in is not started, held and logged; a broken auth status says so', async () => {
  const f = controlFixture();
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    assert.deepEqual(record.account, { email: 'fake@example.com', org: 'Fake Org', subscription: 'max' });
  } finally {
    f.ctx.stopAgents();
  }
  for (const [auth, said] of [['logged-out', /the Claude account .* is not logged in/], ['broken', /claude auth status failed/]]) {
    const g = controlFixture();
    g.ctx.env = { ...g.ctx.env, FAKE_AUTH: auth };
    try {
      await tick(g.ctx);
      const [record] = g.assignments().assignments;
      assert.equal(record?.['process-id'] ?? null, null, auth);                              // no process
      assert.equal(g.ctx.agents.size, 0, auth);
      if (auth === 'logged-out') assert.deepEqual(record.account, { email: null, org: null, subscription: null });
      assert.ok(g.lines.some(l => said.test(l)), g.lines.join('\n'));
    } finally {
      g.ctx.stopAgents();
    }
  }
});

test('tick: a project with its own .claude folder runs its agents with CLAUDE_CONFIG_DIR its full path (ASS-26); one without, on the shared login', async () => {
  for (const own of [true, false]) {
    const f = controlFixture();
    const dir = join(f.dir, 'projects', 'p', '.claude');
    if (own) mkdirSync(dir);
    try {
      await tick(f.ctx);
      const [record] = f.assignments().assignments;
      const live = f.ctx.agents.get(record['agent-name']);
      assert.ok(await until(() => readFileSync(join(live.agent.dir, 'session.txt'), 'utf8').includes('config ')));
      assert.match(readFileSync(join(live.agent.dir, 'session.txt'), 'utf8'), own ? new RegExp(`config ${dir}\\n`) : /config -\n/);
    } finally {
      f.ctx.stopAgents();
    }
  }
});

test('tick: a host agent not on a ticket\'s code is confined (ASS-108) — started in projects/<id>/ with the settings the harness writes there; one in its ticket\'s worktree is not, and no repository\'s own settings sandbox it', async () => {
  for (const worktree of [false, true]) {
    const f = controlFixture();
    const wt = join(f.dir, 'wt');
    if (worktree) {
      mkdirSync(wt);
      const file = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
      const sprint = JSON.parse(readFileSync(file, 'utf8'));
      sprint.features[0].variations[0].build = { 'worktree-folder': wt };
      writeFileSync(file, JSON.stringify(sprint, null, 4));
    }
    try {
      await tick(f.ctx);
      const [record] = f.assignments().assignments;
      const live = f.ctx.agents.get(record['agent-name']);
      const args = () => readFileSync(join(live.agent.dir, 'session.txt'), 'utf8').split('\n').find(l => l.startsWith('args '));
      assert.ok(await until(() => args()));
      const settings = join(f.dir, 'projects', 'p', 'host-agent-settings.json');
      assert.ok(f.lines.some(l => l.includes(`, in ${worktree ? wt : join(f.dir, 'projects', 'p')}`)), f.lines.join('\n'));
      assert.ok(args().endsWith(worktree ? '--settings {"sandbox":{"enabled":false}}' : `--settings ${settings}`), args());
      if (!worktree) assert.equal(JSON.parse(readFileSync(settings, 'utf8')).permissions.defaultMode, 'dontAsk');
    } finally {
      f.ctx.stopAgents();
    }
  }
});

test('tick: a project whose expected-account is not its login starts none of its agents — held, recorded for the dashboard, logged once; logged in as it (any case), they start and the hold clears; asked at most once a minute, or when the expectation changes', async () => {
  const f = controlFixture();
  const file = join(f.dir, 'projects', 'p', 'project.json');
  const edit = change => { const p = JSON.parse(readFileSync(file, 'utf8')); change(p); writeFileSync(file, JSON.stringify(p, null, 4)); };
  edit(p => { p['expected-account'] = 'work@example.com'; });
  let now = Date.parse('2026-10-14T12:00:00Z');
  f.ctx.now = () => new Date(now);
  try {
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments, []);
    const hold = JSON.parse(readFileSync(file, 'utf8'))['account-hold'];
    assert.deepEqual([hold.expected, hold.actual, hold['config-dir']], ['work@example.com', 'fake@example.com', null]);
    assert.equal(f.lines.filter(l => /p expects the Claude account work@example\.com; logged in as fake@example\.com — none of its agents start/.test(l)).length, 1, f.lines.join('\n'));
    now += 30_000;
    edit(p => { p['expected-account'] = 'FAKE@example.com'; });                         // a new expectation is checked at once
    await tick(f.ctx);
    assert.equal(f.assignments().assignments.length, 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))['account-hold'], undefined);
    assert.ok(f.lines.some(l => /p is logged in as its expected account again/.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a project\'s own limits in project.json hold its moves and dispatches, whatever the harness\'s allow', async () => {
  // No planning slot (ASS-126: the steps phase reads the project's limits too): it stays in the queue; no agent: it reaches the prompt step, held there.
  for (const [limits, at] of [[{ 'max-tickets-in-planning': 0 }, 'committed'], [{ 'max-agents': 0 }, 'plan']]) {
    const f = controlFixture();
    const file = join(f.dir, 'projects', 'p', 'project.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...limits }));
    try {
      await tick(f.ctx);
      assert.equal(f.variation()['harness-status'].state, at, JSON.stringify(limits));
      assert.deepEqual(f.assignments().assignments, [], JSON.stringify(limits));
    } finally {
      f.ctx.stopAgents();
    }
  }
});

test('tick: an ended turn is finished first — assignment removed with its cost, process ended, ticket moved by the structured output — then the script step runs and the sub-engine starts, entering the ticket into it, and gets its agent', async () => {
  const f = controlFixture();
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    await tick(f.ctx);
    assert.ok(await turnsEnd(f.ctx));
    const [plan] = f.assignments().assignments;
    await tick(f.ctx);
    assert.ok(!f.ctx.agents.has(plan['agent-name']) || f.ctx.agents.get(plan['agent-name']).record !== plan);   // the plan agent is gone
    const v = f.variation();
    assert.deepEqual(v['state-changes'].map(c => [c['from-state'], c['to-state'], c['sub-state-change'] ?? null]), [
      ['backlog', 'committed', null], ['committed', 'plan', null], ['plan', 'build', null], ['build', 'local-testing', null],
      ['local-testing', 'local-testing', { 'state-engine': 'test', 'from-state': null, 'to-state': 'test' }],     // entered the sub-engine
    ]);
    const dispatched = v['state-changes'][1]['agent-dispatch-log'][0];
    assert.deepEqual([dispatched['dispatched-to'], dispatched['cost-usd'], dispatched.tokens], [plan['agent-name'], 0.5, { input: 10, output: 20, 'cache-read': 30, 'cache-write': 40 }]);
    assert.match(dispatched['completed-timestamp'], /^\d{4}/);
    assert.deepEqual(v['harness-status'], { ...hs('local-testing'), 'sub-status': { state: 'test', 'state-engine': 'test' } });
    const [run] = f.assignments()['transient-state-engines'];
    assert.deepEqual([run['state-engine'], run.state, run.parent], ['test', 'test', { 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'example-development', state: 'local-testing' }]);
    const [record] = f.assignments().assignments;
    assert.deepEqual([record['transient-state-engine'], record['work-item'], record.variation, record.state, record.prompt], [run.id, 'ABC-3', 'A', 'test', 'test']);
    assert.ok(f.ctx.agents.has(record['agent-name']));
    assert.ok(f.lines.some(l => /^finish ABC-3 A plan → build$/.test(l)), f.lines.join('\n'));
    assert.ok(f.lines.indexOf(f.lines.find(l => l.startsWith('finish '))) < f.lines.indexOf(f.lines.find(l => /^steps ABC-3 A build/.test(l))));   // finished before the steps ran

    // The sub-engine's agent ends: the run moves within the ticket, recorded as a sub-state change; its session id was recorded.
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.equal(f.assignments()['transient-state-engines'][0].state, 'take-screenshots');
    assert.deepEqual(f.variation()['harness-status']['sub-status'], { state: 'take-screenshots', 'state-engine': 'test' });
    assert.equal(f.assignments().assignments[0].state, 'take-screenshots');                    // and the next prompt step has its agent
    assert.ok(f.lines.some(l => /^cli agent.sh assignments:set-process \S+ \d+ fake-session$/.test(l)), f.lines.join('\n'));

    // The sub-engine ends: in the same tick the parent step's exits read its output, the ticket moves on, the run is removed.
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.ok(f.lines.some(l => /^finish run test \S+ take-screenshots → done$/.test(l)), f.lines.join('\n'));
    assert.ok(f.lines.some(l => /^steps ABC-3 A local-testing → done$/.test(l)), f.lines.join('\n'));
    assert.deepEqual(f.variation()['harness-status'], hs('done'));
    assert.deepEqual(f.assignments()['transient-state-engines'], []);
    assert.deepEqual(f.assignments().assignments, []);
    assert.equal(f.ticket()['ticket-system-status'], 'Done');
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('tick: a turn whose output matches no exit is no failure — the step is dispatched again at once, for more turns; a process that exits without a result is, held until its backoff is over', async () => {
  const f = controlFixture();
  let now = Date.parse('2026-10-12T12:00:00Z');
  f.ctx.now = () => new Date(now);
  process.env.FAKE_OUTPUT = '{"is-approved":"maybe"}';
  try {
    await tick(f.ctx);
    assert.ok(await turnsEnd(f.ctx));
    const [first] = f.assignments().assignments;
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'plan');
    assert.ok(f.lines.some(l => /^finish \S+: no exit of plan matched; the step runs again$/.test(l)), f.lines.join('\n'));
    assert.equal(f.ctx.memory.backoff.size, 0);                           // not held
    const [second] = f.assignments().assignments.filter(a => a['work-item'] === 'ABC-3');
    assert.notEqual(second['assignment-id'], first['assignment-id']);
    assert.equal(f.variation()['state-changes'].at(-1)['agent-dispatch-log'].length, 2);
    // The process dies mid-turn.
    f.ctx.agents.get(second['agent-name']).agent.stop();
    assert.ok(await until(() => f.ctx.agents.get(second['agent-name']).exited));
    await tick(f.ctx);
    assert.ok(f.lines.some(l => /exited without ending its turn; tried again in 30s/.test(l)), f.lines.join('\n'));
    assert.equal(f.assignments().assignments.filter(a => a['work-item'] === 'ABC-3').length, 0);
    now += 31e3; await tick(f.ctx);
    assert.equal(f.assignments().assignments.filter(a => a['work-item'] === 'ABC-3').length, 1);
    assert.equal(f.variation()['state-changes'].at(-1)['agent-dispatch-log'].length, 3);
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('tick: a step that fails three times in a row sends its ticket to Blocked, said why; the backoff is cleared', async () => {
  const f = controlFixture();
  let now = Date.parse('2026-10-12T12:00:00Z');
  f.ctx.now = () => new Date(now);
  process.env.FAKE_EXIT = '1';                                                     // every agent dies on its first message: a failure each time
  try {
    for (let i = 0; i < 3; i++) {
      await tick(f.ctx);                                                           // dispatched (again, its hold over)
      assert.ok(await until(() => [...f.ctx.agents.values()].every(a => a.exited)), `attempt ${i + 1}`);
      await tick(f.ctx);                                                           // finished: one more failure
      now += 31 * 60e3;                                                            // past any hold
    }
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'blocked', f.lines.join('\n'));
    assert.ok(f.lines.some(l => /^steps ABC-3 A plan → blocked \(failed 3 times in a row\)$/.test(l)), f.lines.join('\n'));
    assert.equal(f.ctx.memory.backoff.size, 0);
  } finally {
    delete process.env.FAKE_EXIT;
    f.ctx.stopAgents();
  }
});

test('tick: a step inside a ticket step\'s sub-engine that fails three times in a row sends the ticket to Blocked too (ASS-67)', async () => {
  const f = controlFixture();
  const sprint = f.sprint();
  Object.assign(sprint.features[0], { 'ticket-system-status': 'In Progress' });
  sprint.features[0].variations[0]['harness-status'] = { state: 'build', 'state-engine': 'example-development' };
  writeFileSync(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(sprint));
  let now = Date.parse('2026-10-12T12:00:00Z');
  f.ctx.now = () => new Date(now);
  process.env.FAKE_EXIT = '1';                                                     // every agent dies on its first message
  try {
    for (let i = 0; i < 3; i++) {
      await tick(f.ctx);                                                           // (build → local-testing: the test run) its agent at test
      assert.ok(await until(() => [...f.ctx.agents.values()].every(a => a.exited)), `attempt ${i + 1}`);
      await tick(f.ctx);                                                           // finished: one more failure
      now += 31 * 60e3;
    }
    await tick(f.ctx);
    assert.equal(f.variation()['harness-status'].state, 'blocked', f.lines.join('\n'));
    assert.ok(f.lines.some(l => /^steps ABC-3 A local-testing → blocked \(failed 3 times in a row\)$/.test(l)), f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_EXIT;
    f.ctx.stopAgents();
  }
});

test('tick: one failing item does not stop the phase — a record whose variation is gone is logged under error and the rest still dispatch', async () => {
  const f = controlFixture();
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    const sprint = f.sprint();
    sprint.features[0].variations[0].name = 'Z';                                               // its variation renamed from under it
    writeFileSync(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(sprint));
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);
    assert.ok(f.lines.some(l => /^finish \S+: ABC-3 A is no longer at plan; nothing to move$/.test(l)), f.lines.join('\n'));
    assert.ok(f.lines.some(l => /^error finish \S+: agent.sh assignments:remove/.test(l)), f.lines.join('\n'));
    assert.ok(!f.ctx.agents.has(record['agent-name']));
    assert.ok(f.lines.some(l => /^dispatch \S+ .* on ABC-3 Z plan/.test(l)), f.lines.join('\n'));                 // the phase went on
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a run for a ticket step the ticket has left is ended, unfinished, and no agent is sent for it', async () => {
  const f = controlFixture();
  try {
    // ABC-3 is at backlog; a test run says it is for ABC-3's local-testing, which it left (or never reached).
    await f.agent('transient-state-engine:create', 'p', 'test', 'test', JSON.stringify({ 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'example-development', state: 'local-testing' }));
    await tick(f.ctx);
    assert.deepEqual(f.assignments()['transient-state-engines'].filter(r => r['state-engine'] === 'test'), [], f.lines.join('\n'));
    assert.ok(f.lines.some(l => /run test \S+ ended \(its ticket has moved on\)/.test(l)), f.lines.join('\n'));
    assert.ok(!f.lines.some(l => /^dispatch .* on ABC-3 A test,/.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-216 AC1: an agent on a subscription (its init event\'s apiKeySource "none") is recorded on its dispatch as billing subscription at $0; one on an API key as api at its cost', async () => {
  for (const [source, billing, cost] of [['none', 'subscription', 0], ['ANTHROPIC_API_KEY', 'api', 0.5]]) {
    const f = controlFixture();
    process.env.FAKE_OUTPUT = '{"is-approved":true}';
    process.env.FAKE_API_KEY_SOURCE = source;
    try {
      await tick(f.ctx);
      assert.ok(await turnsEnd(f.ctx));
      await tick(f.ctx);
      const dispatched = f.variation()['state-changes'][1]['agent-dispatch-log'][0];
      assert.deepEqual([dispatched.billing, dispatched['cost-usd']], [billing, cost], f.lines.join('\n'));
    } finally {
      delete process.env.FAKE_OUTPUT;
      delete process.env.FAKE_API_KEY_SOURCE;
      f.ctx.stopAgents();
    }
  }
});
