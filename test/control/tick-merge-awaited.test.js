// ASS-365: Build merges the merge requests its Await Sequential Merge waits on,
// where the project's workflow opts in. Control reads merges-awaited on any
// step of the variation's status chain (here the project's Build stand-in,
// local-testing, which runs grouped-build's own steps) and tells
// merge-request:await-dependencies so (MERGES_AWAITED=1); its exit 5 moves the
// run to Merge the Awaited, a grouped-merge run three levels down, which
// starts with the ids it waits on (pass-output) and gives them to each of its
// commands (--only {merge-request-ids}). Merged, the run is back at Await
// Sequential Merge; an approval wait past its bound ends at Blocked for Human,
// with the check's feedback. Without the flag nothing changes. The commands'
// own tests: test/agent-cli/merge-requests.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { engineDir } from '../support/engine-walk.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const sprint = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
const read = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));
const KEPT = ['generate-solution', 'address-merge-request-feedback', 'merge-awaited', 'await-dependencies', 'refresh-before-testing', 'done', 'blocked', 'blocked-for-human'];
// A step as the fixture runs it: on the host, its agent the fixture's test prompt.
const onHost = s => { const { 'run-location': _, vm: __, ...rest } = s; return rest.action.type === 'prompt' ? { ...rest, action: { ...rest.action, prompt: 'test', 'run-in-dev-container': false } } : rest; };

// The control fixture with ABC-3 A at local-testing, the project's Build stand-in — merges-awaited set on it when
// `flagged` — which runs grouped-build's own Await Sequential Merge (first), Merge the Awaited, its other ends and the
// refresh after (on to done), and grouped-merge as it is. Its ends are Build's: blocked, blocked-for-human, else done.
// Each script faked by its command (answers: [pattern, { exitCode, stdout }], the first matching), each call kept with its env.
function fixture(flagged, answers) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e['check-health-interval-seconds'] = 1e9;
    e.steps.unshift({ id: 'blocked-for-human', sequence: 0, 'is-blocked-state': true, 'paired-ticket-system-status': 'Blocked', action: { type: 'human' } });
    Object.assign(e.steps.find(s => s.id === 'local-testing'), { ...(flagged ? { 'merges-awaited': true } : {}), action: { type: 'state-engine', engine: 'build' }, 'exit-events': [
      { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked' }] }, 'move-to-state': 'blocked' },
      { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked-for-human' }] }, 'move-to-state': 'blocked-for-human' },
      { condition: { 'is-done': true }, 'move-to-state': 'done' }] });
  });
  const steps = read('grouped-build').steps.filter(s => KEPT.includes(s.id)).map(s => {
    if (s.id === 'await-dependencies') return { ...s, sequence: 0 };
    if (s.id === 'refresh-before-testing') return { ...s, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'done' }] };
    return onHost(s);
  });
  for (const [name, engine] of [['build', { steps }], ['grouped-merge', { steps: read('grouped-merge').steps.map(onHost) }]]) {
    mkdirSync(join(f.dir, 'engines', name), { recursive: true });
    writeFileSync(join(f.dir, 'engines', name, 'state-engine.json'), JSON.stringify(engine));
  }
  edit(sprint(f), s => {
    s.features[0]['ticket-system-status'] = 'In Progress';
    s.features[0].variations[0]['harness-status'] = hs('local-testing');
  });
  f.now = Date.parse('2026-11-11T14:00:00Z');
  f.ctx.now = () => new Date(f.now);
  f.calls = [];
  f.answers = answers;
  f.ctx.script = async (argv, vm, env) => {
    const line = argv.join(' ');
    f.calls.push({ line, env });
    const [, answer] = f.answers.find(([pattern]) => pattern.test(line)) ?? [, { exitCode: 0 }];
    const given = typeof answer === 'function' ? answer() : answer;
    return { exitCode: given.exitCode ?? 0, stdout: JSON.stringify(given.stdout ?? {}) };
  };
  return f;
}

const WAITING = { waiting: [{ id: 2, repository: 'https://gitlab.com/g/app', 'depends-on': { id: 1, repository: 'https://gitlab.com/g/lib', status: 'Open', key: '!7', url: null }, needs: ['draft'] }] };
const runOf = (f, engine) => f.assignments()['transient-state-engines'].find(r => r['state-engine'] === engine);
const chain = f => { const out = []; for (let at = f.variation()['harness-status']; at; at = at['sub-status']) out.push(at.state); return out; };
async function until(f, done, ticks = 12) {
  for (let i = 0; i < ticks && !done(); i++) { await tick(f.ctx); f.now += 6 * 60e3; }
  assert.ok(done(), `${f.lines.join('\n')}\n${f.calls.map(c => c.line).join('\n')}`);
}

test('ASS-365 AC2: with merges-awaited on a step of its status chain, Await Sequential Merge is told so (MERGES_AWAITED=1); its exit 5 runs grouped-merge, three levels down, over the ids it waits on (--only 1), and once merged the run is back at Await Sequential Merge, then on', async () => {
  let awaited = 0;
  const f = fixture(true, [
    [/merge-request:await-dependencies/, () => (awaited++ === 0 ? { exitCode: 5, stdout: { ...WAITING, 'merge-request-ids': [1] } } : { exitCode: 0, stdout: { waiting: [] } })],
    [/merge-request:reviewed-at-head/, { exitCode: 0, stdout: { reviewed: [{ id: 1 }], unreviewed: [] } }],
    [/merge-request:check/, { exitCode: 0, stdout: { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: true } }],
  ]);
  const depths = [];
  await until(f, () => { depths.push(chain(f).length); return runOf(f, 'grouped-merge') != null; });
  assert.deepEqual(runOf(f, 'grouped-merge')['structured-output'], { 'merge-request-ids': [1] });
  assert.equal(runOf(f, 'build').state, 'merge-awaited');
  const first = f.calls.find(c => /await-dependencies/.test(c.line));
  assert.match(first.line, /merge-request:await-dependencies p ABC-3 A$/);
  assert.deepEqual(first.env, { MERGES_AWAITED: '1' });
  await until(f, () => f.variation()['harness-status'].state === 'done');
  const lines = f.calls.map(c => c.line);
  for (const command of ['merge-request:reviewed-at-head p ABC-3 A --only 1', 'code:take-out-of-draft-mode p ABC-3 A --only 1', 'merge-request:check p ABC-3 A --only 1'])
    assert.ok(lines.some(l => l.endsWith(command)), `${command}\n${lines.join('\n')}`);
  assert.ok(f.lines.some(l => /grouped-merge .* check → done/.test(l)), f.lines.join('\n'));
  assert.ok(f.lines.some(l => /merge-awaited → await-dependencies/.test(l)), f.lines.join('\n'));
  assert.ok(f.lines.some(l => /await-dependencies → refresh-before-testing/.test(l)), f.lines.join('\n'));
  assert.equal(lines.filter(l => /await-dependencies/.test(l)).length, 2);
});

test('ASS-365 AC2: while the grouped-merge run works, the variation stands three levels down — Build, Merge the Awaited, the loop\'s step — and its agent-less steps get the flag too', async () => {
  const f = fixture(true, [
    [/merge-request:await-dependencies/, { exitCode: 5, stdout: { ...WAITING, 'merge-request-ids': [1, 3] } }],
    [/merge-request:reviewed-at-head/, { exitCode: 0 }],
    [/merge-request:check/, { exitCode: 0, stdout: { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: false } }],
  ]);
  await until(f, () => chain(f).length === 3 && chain(f)[2] === 'check');
  assert.deepEqual(chain(f), ['local-testing', 'merge-awaited', 'check']);
  const check = f.calls.find(c => /merge-request:check/.test(c.line));
  assert.match(check.line, /--only 1,3$/);
  assert.deepEqual(check.env, { MERGES_AWAITED: '1' });
});

test('ASS-365 AC1: an approval wait past its bound ends grouped-merge at Blocked for Human, and the ticket goes there from Build with the check\'s feedback', async () => {
  const f = fixture(true, [
    [/merge-request:await-dependencies/, { exitCode: 5, stdout: { ...WAITING, 'merge-request-ids': [1] } }],
    [/merge-request:reviewed-at-head/, { exitCode: 0 }],
    [/merge-request:check/, { exitCode: 0, stdout: { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: false, 'approval-wait-expired': true,
      'ai-feedback-short': 'Waited over 3 days for approval: MR 1 (!7)', 'ai-feedback-long': 'MR 1 (!7) has not merged within 3 days.' } }],
  ]);
  await until(f, () => f.variation()['harness-status'].state === 'blocked-for-human');
  assert.equal(f.variation()['ai-feedback-short'], 'Waited over 3 days for approval: MR 1 (!7)');
});

// ASS-388 AC2: Address Merge Request Feedback rounds that change nothing — the check sending a clean merge request
// on (a stale needs-attention), the agent pushing nothing — come back to the check through Check the Feedback
// Round with cause no-op-round, recorded on the run's own changes, and spend no visit: past three such rounds
// (its max-visits) the loop goes on polling, never Blocked, and merges once the check says so.
test('ASS-388 AC2: three and more no-op feedback rounds on a clean merge request leave the merge loop polling the check, never Blocked; each return recorded with cause no-op-round on the run', async () => {
  let checks = 0;
  const f = fixture(true, [
    [/merge-request:await-dependencies/, () => (checks < 5 ? { exitCode: 5, stdout: { ...WAITING, 'merge-request-ids': [1] } } : { exitCode: 0, stdout: { waiting: [] } })],
    [/merge-request:reviewed-at-head/, { exitCode: 0 }],
    [/merge-request:feedback-round/, { exitCode: 0, stdout: { changed: false, 'merge-requests': [{ id: 1, key: '!7', head: 'a', 'checked-head': 'a', acted: false }] } }],
    [/merge-request:check/, () => (++checks <= 4 ? { exitCode: 0, stdout: { 'needs-attention': true, reasons: ['build-failed'], 'auto-merge': true, merged: false } }
      : { exitCode: 0, stdout: { 'needs-attention': false, reasons: [], 'auto-merge': true, merged: true } })],
  ]);
  const rounds = () => (runOf(f, 'grouped-merge')?.['state-changes'] ?? []).filter(c => c.cause === 'no-op-round').length;
  // Each round's agent is the fixture's fake one, a process of its own: given time between ticks to end its turn.
  const slow = async done => {
    for (let i = 0; i < 400 && !done(); i++) { await tick(f.ctx); f.now += 6 * 60e3; if (f.ctx.agents.size) await new Promise(r => setTimeout(r, 50)); }
    assert.ok(done(), `${f.lines.join('\n')}\n${f.calls.map(c => c.line).join('\n')}`);
  };
  try {
    let entered = [];
    await slow(() => { const run = runOf(f, 'grouped-merge'); if (run) entered = run['state-changes']; return rounds() >= 4; });
    assert.ok(entered.filter(c => c['to-state'] === 'address-merge-request-feedback').length >= 4, 'four rounds, past its max-visits of 3');
    assert.ok(entered.filter(c => c.cause === 'no-op-round').every(c => c['from-state'] === 'check-feedback-round' && c['to-state'] === 'check'));
    assert.ok(f.calls.some(c => /merge-request:feedback-round p ABC-3 A --only 1$/.test(c.line)), f.calls.map(c => c.line).join('\n'));
    await slow(() => f.variation()['harness-status'].state === 'done');
    assert.ok(!f.lines.some(l => /max-visits|→ blocked/.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-365 AC6: without merges-awaited in the status chain, Await Sequential Merge is told nothing — its command runs with no env of its own — and waits as before', async () => {
  const f = fixture(false, [[/merge-request:await-dependencies/, { exitCode: 2, stdout: WAITING }]]);
  for (let i = 0; i < 3; i++) { await tick(f.ctx); f.now += 6 * 60e3; }
  const calls = f.calls.filter(c => /await-dependencies/.test(c.line));
  assert.ok(calls.length >= 1, f.lines.join('\n'));
  assert.ok(calls.every(c => c.env === undefined), JSON.stringify(calls));
  assert.equal(runOf(f, 'build').state, 'await-dependencies');
  assert.equal(runOf(f, 'grouped-merge'), undefined);
});
