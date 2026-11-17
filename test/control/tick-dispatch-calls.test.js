// ASS-496: the agent.sh processes dispatch awaits to start one agent — timed
// (ctx.timed, 'dispatch/dispatch/cli <command>'), the account folded into
// assignments:create, assignments:set-process and harness:set-context-window
// left running, never awaited by the tick, their failures logged — against
// the control fixture, the real agent-cli and the fake agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';

// The control fixture, its ctx.cli spied on: every call's command, in the order made, with the assignments as they stood then; `hold(command)` makes that command wait until its release() (or fail with fail()).
function spied() {
  const f = controlFixture();
  const real = f.ctx.cli, calls = [], held = new Map(), done = [];
  f.ctx.cli = async (args, env) => {
    calls.push({ args, assignments: f.assignments().assignments });
    const h = held.get(args[0]);
    if (h) await h.promise;
    const out = await real(args, env);
    done.push(args);
    return out;
  };
  const hold = command => {
    let release, fail;
    const promise = new Promise((resolve, reject) => { release = resolve; fail = reject; });
    held.set(command, { promise });
    return { release: () => { held.delete(command); release(); }, fail: error => { held.delete(command); fail(error); } };
  };
  return { ...f, calls, done, hold, commands: () => calls.map(c => c.args[0]) };
}

test('ASS-496 AC1/AC2/AC3: starting one agent awaits two agent.sh processes, each timed by command: assignments:create, with its account, then agent:dispatch; the record has its account before the process starts; set-account is never run', async () => {
  const f = spied();
  await tick(f.ctx);
  const [record] = f.assignments().assignments;
  const live = f.ctx.agents.get(record['agent-name']);
  assert.ok(live, f.lines.join('\n'));
  const subs = f.ctx.tickTimes.subs;
  assert.equal(subs['dispatch/dispatch/cli assignments:create'].calls, 1);
  assert.equal(subs['dispatch/dispatch/cli agent:dispatch'].calls, 1);
  assert.equal(subs['dispatch/dispatch/claude auth status'].calls, 1);
  const awaited = Object.keys(subs).filter(k => k.startsWith('dispatch/dispatch/cli '));
  assert.deepEqual(awaited.sort(), ['dispatch/dispatch/cli agent:dispatch', 'dispatch/dispatch/cli assignments:create']);
  // Nested in the phase's own time, which they never exceed.
  assert.ok(subs['dispatch/dispatch'].ms >= subs['dispatch/dispatch/cli assignments:create'].ms + subs['dispatch/dispatch/cli agent:dispatch'].ms);
  assert.equal(f.commands().includes('assignments:set-account'), false);
  const create = f.calls.find(c => c.args[0] === 'assignments:create');
  assert.deepEqual(create.args.slice(1, 6), ['--account', 'fake@example.com', 'Fake Org', 'max', '-']);
  // When agent:dispatch ran — before the process started — the record was there with its account.
  const atDispatch = f.calls.find(c => c.args[0] === 'agent:dispatch').assignments.find(a => a['agent-name'] === live.name);
  assert.deepEqual(atDispatch.account, { email: 'fake@example.com', org: 'Fake Org', subscription: 'max' });
  assert.equal(atDispatch['process-id'], null);
  // The pid, written without the tick waiting, lands all the same.
  assert.ok(await until(() => f.assignments().assignments[0]['process-id'] === live.agent.pid));
  assert.equal(f.assignments().assignments[0].status, 'Running');
});

test('ASS-496 AC2/AC3/AC5: assignments:set-process is not awaited by the tick — it ends while the write still waits; the next finish phase waits for it before the session id, so the pid lands first', async () => {
  const f = spied();
  const pid = f.hold('assignments:set-process');
  await tick(f.ctx);                                                            // returns though set-process has not
  const [record] = f.assignments().assignments;
  const live = f.ctx.agents.get(record['agent-name']);
  assert.ok(live, f.lines.join('\n'));
  assert.equal(record['process-id'], null);
  assert.equal(f.ctx.unawaited.size, 1);
  assert.ok(await until(() => live.agent.sessionId));
  // The next tick's finish phase waits for the pid write: released a little later, its session id comes after.
  setTimeout(() => pid.release(), 200);
  await tick(f.ctx);
  const writes = f.done.filter(a => a[0] === 'assignments:set-process');
  assert.deepEqual(writes.filter(a => a[1] === live.name).map(a => a.slice(2)), [[String(live.agent.pid), '-'], [String(live.agent.pid), 'fake-session']]);
});

test('ASS-496 AC5: a failing assignments:set-process is logged under error, never thrown into the tick; the agent runs on', async () => {
  const f = spied();
  const pid = f.hold('assignments:set-process');
  await tick(f.ctx);
  const [record] = f.assignments().assignments;
  pid.fail(new Error('the write broke'));
  assert.ok(await until(() => f.lines.some(l => l === `error dispatch ${record['agent-name']}'s process: the write broke`)), f.lines.join('\n'));
  assert.equal(f.lines.some(l => /error dispatch ABC-3/.test(l)), false);          // the dispatch itself was not failed or held
  assert.ok(f.ctx.agents.has(record['agent-name']));
  assert.equal(f.ctx.unawaited.size, 0);
});

test('ASS-496 AC5: harness:set-context-window runs from the agent\'s result, never awaited; its failure logged, never thrown', async () => {
  process.env.FAKE_CONTEXT_WINDOW = '200000';
  try {
    const f = spied();
    const window = f.hold('harness:set-context-window');
    await tick(f.ctx);
    assert.ok(await until(() => f.commands().includes('harness:set-context-window')));
    assert.equal(f.done.some(a => a[0] === 'harness:set-context-window'), false);   // still waiting, the agent's turn ended
    assert.equal(f.ctx.tickTimes.subs['dispatch/dispatch/cli harness:set-context-window'], undefined);
    window.fail(new Error('no room'));
    assert.ok(await until(() => f.lines.some(l => /^error dispatch \S+: fake-model's context window: no room$/.test(l))), f.lines.join('\n'));
    // Not held, it writes the window.
    const g = spied();
    await tick(g.ctx);
    assert.ok(await until(() => existsSync(g.env.CONTEXT_WINDOWS_FILE) && JSON.parse(readFileSync(g.env.CONTEXT_WINDOWS_FILE, 'utf8'))['fake-model'] === 200000));
  } finally {
    delete process.env.FAKE_CONTEXT_WINDOW;
  }
});
