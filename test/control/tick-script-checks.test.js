// ASS-493: a step's script-succeeds exit checks run in the background (cli.js
// scriptSucceeds, checks.js): a slow one — a ticket's test-listing check took
// 114 s, run with spawnSync — no longer freezes control. While it runs its
// variation stays where it is and the tick goes on; a later tick reads its
// answer, X and NOT X sharing one run; a check past its timeout is killed and
// fails; shutdown kills one still running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { stopStarted } from '../../src/control/stop.js';
import { until } from '../support/until.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const sprint = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
const engineFile = f => join(f.dir, 'engines', 'example-development', 'state-engine.json');
const state = (f, key = 'ABC-3') => f.sprint().features.find(t => t.key === key).variations[0]['harness-status'].state;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The control fixture with ABC-3 A at `at`: `check` (a none step), `work` (a
// prompt step) or `build` (its script step, exit code 0 asked first), whose exits are script-succeeds CHECK → passed and NOT
// script-succeeds CHECK → failed; ABC-4 A at backlog, free to move. CHECK, a
// shell script in its own folder, notes each start (starts) and its pid, then
// waits for the file `go` and exits with the code written in it.
function fixture(at = 'check') {
  const f = controlFixture(), dir = mkdtempSync(join(tmpdir(), 'checks-'));
  writeFileSync(join(dir, 'check.sh'), `echo "$1" >> "${dir}/starts"; echo $$ > "${dir}/pid"; while [ ! -f "${dir}/go" ]; do sleep 0.05; done; exit "$(cat "${dir}/go")"\n`);
  const check = { 'script-succeeds': `sh ${join(dir, 'check.sh')} {ticket}` };
  const exits = more => [{ condition: more ? { all: [more, check] } : check, 'move-to-state': 'passed' }, { condition: more ? { all: [more, { not: check }] } : { not: check }, 'move-to-state': 'failed' }];
  edit(engineFile(f), e => {
    e['check-health-interval-seconds'] = 1e9;
    e.steps.find(st => st.id === 'build')['exit-events'] = exits({ 'exit-code': 0 });
    e.steps.push(
      { id: 'check', sequence: 7, 'paired-ticket-system-status': 'In Progress', action: { type: 'none' }, 'exit-events': exits() },
      { id: 'work', sequence: 8, 'paired-ticket-system-status': 'In Progress', action: { type: 'prompt', prompt: 'test', 'agent-count': 1, 'run-in-dev-container': false }, 'exit-events': exits({ 'turn-complete': true }) },
      { id: 'passed', sequence: 9, 'paired-ticket-system-status': 'In Progress', action: { type: 'none' } },
      { id: 'failed', sequence: 10, 'paired-ticket-system-status': 'In Progress', action: { type: 'none' } },
    );
  });
  edit(sprint(f), s => {
    s.features[0]['ticket-system-status'] = 'In Progress';
    s.features[0].variations[0]['harness-status'] = { state: at, 'state-engine': 'example-development' };
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': { state: 'backlog', 'state-engine': 'example-development' }, 'state-changes': [] }] });
  });
  const starts = () => (existsSync(join(dir, 'starts')) ? readFileSync(join(dir, 'starts'), 'utf8').trim().split('\n') : []);
  const pid = () => Number(readFileSync(join(dir, 'pid'), 'utf8'));
  return { ...f, starts, pid, go: code => writeFileSync(join(dir, 'go'), String(code)), checking: () => f.ctx.memory.checking?.size ?? 0 };
}

for (const [code, to] of [[0, 'passed'], [1, 'failed']]) {
  test(`ASS-493 AC1/AC2/AC3/AC6: a running check leaves its variation where it is while the tick goes on and another ticket moves; once it exits ${code}, a later tick moves it to ${to}, X and NOT X one run`, async () => {
    const f = fixture();
    try {
      await tick(f.ctx);                                                     // returns though the check never exits
      await until(() => f.starts().length === 1);
      assert.equal(state(f), 'check', f.lines.join('\n'));
      assert.notEqual(state(f, 'ABC-4'), 'backlog', f.lines.join('\n'));    // the rest of the tick went on
      assert.equal(f.lines.filter(l => /^script sh \S+check\.sh ABC-3$/.test(l)).length, 1, f.lines.join('\n'));   // the start's 'script' line, as before
      await tick(f.ctx);
      await tick(f.ctx);
      assert.equal(state(f), 'check');
      assert.equal(f.starts().length, 1, 'never started again while it runs');
      f.go(code);
      await until(() => f.checking() === 0);
      await tick(f.ctx);
      assert.equal(state(f), to, f.lines.join('\n'));
      assert.equal(f.starts().length, 1, 'X and NOT X read one run');
      assert.equal(f.ctx.memory.checks.size, 0, 'its answer forgotten once read');
    } finally { f.go(0); }
  });
}

test('ASS-493 AC2/AC3: an agent\'s turn ending waits for its exits\' check, its agent kept and its step where it is; a later tick finishes it by the check\'s answer', async () => {
  const f = fixture('work');
  try {
    await tick(f.ctx);
    const agent = () => [...f.ctx.agents.values()].find(a => a.record?.['work-item'] === 'ABC-3');
    await until(() => agent()?.result);
    await tick(f.ctx);
    await until(() => f.starts().length === 1);
    await tick(f.ctx);
    assert.equal(state(f), 'work', f.lines.join('\n'));
    assert.ok(agent(), 'the turn is not finished meanwhile');
    assert.equal(f.assignments().assignments.filter(a => a['work-item'] === 'ABC-3').length, 1, 'nor dispatched again');
    f.go(1);
    await until(() => f.checking() === 0);
    await tick(f.ctx);
    assert.equal(state(f), 'failed', f.lines.join('\n'));
    assert.equal(f.starts().length, 1);
  } finally { f.go(0); }
});

test('ASS-493 AC2: a script step\'s exits wait for their check, its script not run again meanwhile; a later tick reads them, as they were', async () => {
  const f = fixture('build');
  f.ctx.scriptWait = 30_000;
  const ran = [], script = f.ctx.script;
  f.ctx.script = (...args) => { ran.push(args[0].join(' ')); return script(...args); };
  try {
    await tick(f.ctx);
    await until(() => f.starts().length === 1);
    await tick(f.ctx);
    assert.equal(state(f), 'build', f.lines.join('\n'));
    assert.equal(ran.length, 1, ran.join('\n'));
    f.go(0);
    await until(() => f.checking() === 0);
    await tick(f.ctx);
    assert.equal(state(f), 'passed', f.lines.join('\n'));
    assert.equal(ran.length, 1);
    assert.equal(f.lines.filter(l => l === 'steps ABC-3 A build: script exited 0').length, 1, f.lines.join('\n'));
  } finally { f.go(0); }
});

test('ASS-493 AC4: a check past its timeout is killed, its process group with it, logged as an error, and counts as not succeeded', async () => {
  const f = fixture();
  f.ctx.checkTimeoutMs = 300;
  try {
    await tick(f.ctx);
    await until(() => f.starts().length === 1);
    const pid = f.pid();
    await until(() => f.checking() === 0);
    await until(() => !alive(pid));
    assert.ok(f.lines.some(l => /^error script-succeeds check sh .*check\.sh ABC-3 \(ABC-3 A\) still running after 0\.3s: killed, counted as not succeeded$/.test(l)), f.lines.join('\n'));
    await tick(f.ctx);
    assert.equal(state(f), 'failed', f.lines.join('\n'));
  } finally { f.go(0); }
});

test('ASS-493 AC4: shutdown kills a check still running', async () => {
  const f = fixture();
  try {
    await tick(f.ctx);
    await until(() => f.starts().length === 1);
    const pid = f.pid(), said = [];
    assert.equal(f.ctx.scripts.size, 1);
    await stopStarted(f.ctx, (phase, text) => said.push(`${phase} ${text}`), 0);
    await until(() => !alive(pid));
    assert.ok(said.includes('shutdown stopping 1 script; their steps run them again when control starts'), said.join('\n'));
    await until(() => f.ctx.scripts.size === 0);
  } finally { f.go(0); }
});
