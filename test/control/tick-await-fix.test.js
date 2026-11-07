// ASS-253: Blocked's await-fix (engines/grouped-blocked) polls ticket:fix-landed
// on a timer; its "not landed yet" (exit 1, the step's waiting-exit-code) is
// no failure — no backoff, never Blocked for Human, however long the fix
// takes (EX-899 went to Blocked for Human 10 minutes into its wait). Any exit
// the step does not define still fails, and 3 in a row escalate as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { engineDir } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const sprint = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
const grouped = JSON.parse(readFileSync(join(engineDir('grouped-blocked'), 'state-engine.json'), 'utf8'));
const KEPT = ['await-fix', 'done', 'retry', 'blocked-for-human'];

// The control fixture with ABC-3 A at blocked, waiting on ABC-9 (Blocked for Human, not landed): blocked
// runs grouped-blocked's own await-fix step and its ends, so the run starts at await-fix.
function fixture() {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e['check-health-interval-seconds'] = 1e9;
    e.steps.unshift({ id: 'blocked-for-human', sequence: -1, 'is-blocked-state': true, action: { type: 'human' } });
    Object.assign(e.steps.find(s => s.id === 'blocked'), { action: { type: 'state-engine', engine: 'await' } });
  });
  mkdirSync(join(f.dir, 'engines', 'await'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'await', 'state-engine.json'), JSON.stringify({ steps: grouped.steps.filter(s => KEPT.includes(s.id)) }));
  edit(sprint(f), s => {
    s.features[0]['ticket-system-status'] = 'Blocked';
    Object.assign(s.features[0].variations[0], { 'harness-status': hs('blocked'), 'waits-on': { project: 'p', ticket: 'ABC-9' } });
    s.features.push({ key: 'ABC-9', 'ticket-system-status': 'Blocked', variations: [{ name: 'A', 'harness-status': hs('blocked-for-human'), 'state-changes': [] }] });
  });
  f.now = Date.parse('2026-10-29T20:34:00Z');
  f.ctx.now = () => new Date(f.now);
  return f;
}

const state = f => f.variation()['harness-status'].state;
const run = f => f.assignments()['transient-state-engines'].find(r => r['state-engine'] === 'await');
const polls = f => f.lines.filter(l => /^script .*ticket:fix-landed p ABC-3 A$/.test(l)).length;

test('ASS-253 AC1: await-fix\'s "not landed yet" (exit 1) polled 6 times is no failure — no backoff, never Blocked for Human (EX-899)', async () => {
  const f = fixture();
  await tick(f.ctx);                                                              // the run started, at await-fix
  assert.equal(run(f)?.state, 'await-fix', f.lines.join('\n'));
  for (let i = 0; i < 6; i++) { await tick(f.ctx); f.now += 5 * 60e3 + 1e3; }
  assert.equal(polls(f), 6, f.lines.join('\n'));
  assert.equal(state(f), 'blocked', f.lines.join('\n'));
  assert.equal(run(f)?.state, 'await-fix');
  assert.equal(f.ctx.memory.backoff.get(`run/${run(f).id}/await-fix`), undefined, 'no failure counted');
  assert.equal(f.variation()['last-script-failure'], undefined, 'no failure recorded');
  assert.ok(!f.lines.some(l => /blocked-for-human|failed 3 times|tried again in/.test(l)), f.lines.join('\n'));
  assert.ok(f.lines.some(l => /await-fix: script exited 1, not yet; polled again in 5m$/.test(l)), f.lines.join('\n'));
  // Landed at last: the run moves on to done.
  edit(sprint(f), s => Object.assign(s.features[1], { 'ticket-system-status': 'Done', variations: [{ name: 'A', 'harness-status': hs('done'), 'state-changes': [{ 'from-state': 'merge-pull-request', 'to-state': 'done' }] }] }));
  await tick(f.ctx);
  assert.equal(run(f)?.state, 'done', f.lines.join('\n'));
});

test('ASS-253 AC2: an exit await-fix does not define still fails, and 3 in a row send the ticket to Blocked for Human', async () => {
  const f = fixture();
  f.ctx.script = async () => ({ exitCode: 2, stdout: '' });
  await tick(f.ctx);
  for (let i = 0; i < 4; i++) { await tick(f.ctx); f.now += 31 * 60e3; }
  assert.equal(state(f), 'blocked-for-human', f.lines.join('\n'));
  assert.equal(f.variation()['ai-feedback-short'], 'await-fix failed 3 times in a row: script exited 2');
});

test('ASS-253 AC2: a genuine error between not-landed polls is not "in a row" — a not-landed poll forgets the failures before it', async () => {
  const f = fixture();
  const codes = [2, 2, 1, 2, 2, 1];
  f.ctx.script = async () => ({ exitCode: codes.shift() ?? 1, stdout: '' });
  await tick(f.ctx);
  for (let i = 0; i < 6; i++) { await tick(f.ctx); f.now += 31 * 60e3; }
  assert.equal(codes.length, 0, f.lines.join('\n'));
  assert.equal(state(f), 'blocked', f.lines.join('\n'));
});
