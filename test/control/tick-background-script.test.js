// ASS-328: a script step runs in the background. Its command is started and
// the tick goes on — the project's ended agents finished, its next agents
// dispatched — while it runs (a ticket's two-hour test suite held a project's
// whole tick for an hour, its agents unfinished and nothing dispatched); its
// exits are read on a later tick, once it has exited, as they were read at
// once before: the same facts, logging, backoff and last-script-failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick, createContext } from '../../src/control/tick.js';
import { until } from '../support/until.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const sprint = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
const engineFile = f => join(f.dir, 'engines', 'example-development', 'state-engine.json');
const state = f => f.variation()['harness-status'].state;

// The control fixture with ABC-3 A at build (its script step) and ABC-4 A at
// backlog, for an agent to be dispatched to; ctx.script faked (unless `real`):
// each call recorded in `calls` and left running until the test calls exit(result).
function fixture({ real = false } = {}) {
  const f = controlFixture();
  edit(engineFile(f), e => { e['check-health-interval-seconds'] = 1e9; });
  edit(sprint(f), s => {
    s.features[0]['ticket-system-status'] = 'In Progress';
    s.features[0].variations[0]['harness-status'] = { state: 'build', 'state-engine': 'example-development' };
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': { state: 'backlog', 'state-engine': 'example-development' }, 'state-changes': [] }] });
  });
  f.now = Date.parse('2026-11-09T14:00:00Z');
  f.ctx.now = () => new Date(f.now);
  f.ctx.scriptWait = 20;
  f.calls = [];
  if (!real) f.ctx.script = argv => { f.calls.push(argv.join(' ')); return new Promise(resolve => { f.exit = resolve; }); };
  return f;
}

const agentsOn = (f, key) => f.assignments().assignments.filter(a => a['work-item'] === key).map(a => a['agent-name']);

test('ASS-328 AC1: a script that has not exited leaves its step where it is while the same tick dispatches; a later tick finishes the ended agent; its exit is read once it has exited', async () => {
  const f = fixture();
  try {
    await tick(f.ctx);                                                          // returns though the script never exits
    assert.equal(f.calls.length, 1, f.lines.join('\n'));
    assert.equal(state(f), 'build');
    assert.ok(f.lines.includes('steps ABC-3 A build: script still running; its exit is read once it has exited'), f.lines.join('\n'));
    const [first] = agentsOn(f, 'ABC-4');
    assert.ok(first, f.lines.join('\n'));                                      // dispatch ran in that tick
    await until(() => [...f.ctx.agents.values()].every(a => a.result || a.exited));
    await tick(f.ctx);
    assert.ok(!agentsOn(f, 'ABC-4').includes(first), f.lines.join('\n'));       // finishEnded ran: the ended agent finished
    assert.ok(f.lines.some(l => l.startsWith(`finish ${first} ended`)), f.lines.join('\n'));
    assert.equal(state(f), 'build');
    assert.ok(!f.lines.some(l => /ABC-3 A build: script exited/.test(l)), f.lines.join('\n'));
    f.exit({ exitCode: 0, stdout: '' });
    await tick(f.ctx);
    assert.equal(state(f), 'local-testing', f.lines.join('\n'));
    assert.ok(f.lines.some(l => l === 'steps ABC-3 A build: script exited 0'), f.lines.join('\n'));
    assert.equal(f.calls.length, 1);
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-328 AC1: a failure read on a later tick is logged, backed off and kept as the last-script-failure, as one read at once', async () => {
  const f = fixture();
  try {
    await tick(f.ctx);
    f.exit({ exitCode: 2, stdout: '' });
    await tick(f.ctx);
    assert.equal(state(f), 'build');
    assert.ok(f.lines.some(l => l === 'steps ABC-3 A build: script exited 2; tried again in 30s'), f.lines.join('\n'));
    assert.equal(f.ctx.memory.backoff.get('p/ABC-3/A/build')?.failures, 1);
    assert.equal(f.variation()['last-script-failure']?.['exit-code'], 2);
    await tick(f.ctx);
    assert.equal(f.calls.length, 1);                                            // held: not run again yet
    f.now += 31e3;
    await tick(f.ctx);
    assert.equal(f.calls.length, 2, f.lines.join('\n'));                        // the hold over: run again
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-328 AC1: a script that exits within the short wait (scriptWait) is read in the tick that started it, so a quick step still moves on in one tick', async () => {
  const f = fixture();
  f.ctx.scriptWait = 5_000;
  f.ctx.script = argv => { f.calls.push(argv.join(' ')); return new Promise(resolve => setTimeout(resolve, 10, { exitCode: 0, stdout: '' })); };
  try {
    await tick(f.ctx);
    assert.equal(state(f), 'local-testing', f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-328 AC2: a ticket\'s script still running is not started again by later ticks, and its variation not moved on until its exit is read', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i++) { await tick(f.ctx); f.now += 31 * 60e3; }
    assert.equal(f.calls.length, 1, f.lines.join('\n'));
    assert.equal(state(f), 'build');
    assert.ok(!f.lines.some(l => /already ran this visit/.test(l)), f.lines.join('\n'));   // waiting on it is no stall
    f.exit({ exitCode: 0, stdout: '' });
    await tick(f.ctx);
    assert.equal(state(f), 'local-testing', f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-328 AC2: a run\'s script step still running is not started again, and the run stays at its step until its exit is read', async () => {
  const f = fixture();
  edit(join(f.dir, 'engines', 'test', 'state-engine.json'), e => { e.steps[0].action = { type: 'script', command: './agent.sh ticket:set-paused {project} {ticket} {variation} false' }; e.steps[0]['exit-events'] = [{ condition: { 'exit-code': 0 }, 'move-to-state': 'take-screenshots' }]; });
  edit(sprint(f), s => { s.features[0].variations[0]['harness-status'] = { state: 'local-testing', 'state-engine': 'example-development' }; });
  const run = () => f.assignments()['transient-state-engines'].find(r => r['state-engine'] === 'test');
  try {
    for (let i = 0; i < 3; i++) { await tick(f.ctx); f.now += 31 * 60e3; }
    assert.equal(f.calls.length, 1, f.lines.join('\n'));
    assert.equal(run()?.state, 'test');
    f.exit({ exitCode: 0, stdout: '' });
    await tick(f.ctx);
    assert.equal(run()?.state, 'take-screenshots', f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-328 AC2: a timer step whose script is still running past its timer-minutes is not polled again; once read, its waiting exit code is no failure and its timer polls again', async () => {
  const f = fixture();
  edit(engineFile(f), e => {   // as Blocked's await-fix: polled on its timer, its "not yet" leaving it where it is
    const build = e.steps.find(s => s.id === 'build');
    Object.assign(build.action, { mode: 'timer', 'timer-minutes': 5, 'waiting-exit-code': 1 });
    build['exit-events'] = build['exit-events'].slice(0, 1);
  });
  try {
    await tick(f.ctx);
    f.now += 6 * 60e3;
    await tick(f.ctx);
    assert.equal(f.calls.length, 1, f.lines.join('\n'));
    f.exit({ exitCode: 1, stdout: '' });
    await tick(f.ctx);
    assert.ok(f.lines.some(l => l === 'steps ABC-3 A build: script exited 1, not yet; polled again in 5m'), f.lines.join('\n'));
    assert.equal(f.ctx.memory.backoff.size, 0);
    assert.equal(f.calls.length, 1);
    f.now += 6 * 60e3;
    await tick(f.ctx);
    assert.equal(f.calls.length, 2, f.lines.join('\n'));
    assert.equal(state(f), 'build');
  } finally {
    f.ctx.stopAgents();
  }
});

// AC3, the simplest correct of the two: control restarted while a script runs
// runs the step's script again. The old control stops the scripts it ran on
// its way out (stopScripts, main.js's shut-down) — each its own process
// group, so a script's children go too — and the new one, remembering no
// visit run, starts it afresh: never the two at once, and no exit lost.
test('ASS-328 AC3: control restarted while a script runs: the old control stops it, its children too, and the new control runs the step\'s script again', async () => {
  const f = fixture({ real: true });
  const pids = join(f.dir, 'pids'), script = join(f.dir, 'long.sh');
  writeFileSync(script, `#!/bin/sh\necho $$ >> ${pids}\nsleep 60 &\necho $! >> ${pids}\nwait\n`);
  chmodSync(script, 0o755);
  edit(engineFile(f), e => { e.steps.find(s => s.id === 'build').action.command = script; });
  const started = () => (existsSync(pids) ? readFileSync(pids, 'utf8').trim().split('\n').map(Number) : []);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let again;
  try {
    await tick(f.ctx);
    await until(() => started().length === 2);
    assert.equal(state(f), 'build');
    const first = started();
    assert.ok(first.every(alive));
    f.ctx.stopScripts();                                                        // control on its way out
    await until(() => !first.some(alive));                                      // the script and its child both gone
    again = createContext({ root: f.ctx.root, env: f.ctx.env, command: f.ctx.command, log: f.ctx.log, now: f.ctx.now });
    again.scriptWait = 20;
    await tick(again);
    await until(() => started().length === 4);                                  // run again by the new control
    assert.ok(started().slice(2).every(alive));
    assert.equal(state(f), 'build');
  } finally {
    again?.stopScripts();
    f.ctx.stopScripts();
    again?.stopAgents();
    f.ctx.stopAgents();
  }
});

// AC4: script-succeeds conditions stay synchronous (cli.js scriptSucceeds):
// the exits are evaluated synchronously (engine.js), and the commands they
// ask are short checks — vm:setup-complete's marker, the tests' list
// commands. Asked as an exit of a script step, they are asked when its exit is
// read, with the facts of that tick.
test('ASS-328 AC4: a script-succeeds condition on a background script step\'s exit is asked once its script has exited, and moves it', async () => {
  const f = fixture();
  edit(engineFile(f), e => { e.steps.find(s => s.id === 'build')['exit-events'][0].condition = { all: [{ 'exit-code': 0 }, { 'script-succeeds': './agent.sh check {ticket} {variation}' }] }; });
  const asked = [];
  f.ctx.succeeds = argv => { asked.push(argv.join(' ')); return true; };
  try {
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(asked, [], 'not asked while the script runs');
    f.exit({ exitCode: 0, stdout: '' });
    await tick(f.ctx);
    assert.deepEqual(asked, ['./agent.sh check ABC-3 A']);
    assert.equal(state(f), 'local-testing', f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});
