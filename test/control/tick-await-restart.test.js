// ASS-255: Release's Await the Restart (engines/grouped-release-harness) polls
// harness:restarted every minute; its "not yet" (exit 1, the step's
// waiting-exit-code) is no failure — no backoff, never Blocked, however long
// the restart takes, and more polls than Release's max-visits. Any exit the
// step does not define still fails, and 3 in a row send the ticket to Blocked
// as before (ASS-253's await-fix, the same rule).
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
const grouped = JSON.parse(readFileSync(join(engineDir('grouped-release-harness'), 'state-engine.json'), 'utf8'));
const KEPT = ['await-restart', 'done', 'blocked'];

// The control fixture with ABC-3 A at local-testing, which runs grouped-release-harness's own await-restart
// step and its ends (Release's exits: ended at blocked to Blocked, else Done), so the run starts at
// await-restart; harness:restarted faked, exiting each of `codes` in turn, then 0. Release keeps its max-visits 3.
function fixture(codes) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e['check-health-interval-seconds'] = 1e9;
    Object.assign(e.steps.find(s => s.id === 'local-testing'), { action: { type: 'state-engine', engine: 'release' }, 'exit-events': [
      { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked' }] }, 'move-to-state': 'blocked' },
      { condition: { 'is-done': true }, 'move-to-state': 'done' }] });
  });
  mkdirSync(join(f.dir, 'engines', 'release'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'release', 'state-engine.json'), JSON.stringify({ steps: grouped.steps.filter(s => KEPT.includes(s.id)) }));
  edit(sprint(f), s => {
    s.features[0]['ticket-system-status'] = 'In Progress';
    s.features[0].variations[0]['harness-status'] = hs('local-testing');
  });
  f.now = Date.parse('2026-10-30T14:00:00Z');
  f.ctx.now = () => new Date(f.now);
  f.polls = [];
  f.ctx.script = async argv => { f.polls.push(argv.join(' ')); return { exitCode: codes.shift() ?? 0, stdout: '' }; };
  return f;
}

const state = f => f.variation()['harness-status'].state;
const run = f => f.assignments()['transient-state-engines'].find(r => r['state-engine'] === 'release');

test('ASS-255 AC1/AC3: await-restart\'s "not yet" (exit 1) polled 6 times, past Release\'s max-visits 3, is no failure — no backoff, never Blocked; then the restart lands and the ticket goes on to Done', async () => {
  const f = fixture(Array(6).fill(1));
  await tick(f.ctx);                                                              // the run started, at await-restart
  assert.equal(run(f)?.state, 'await-restart', f.lines.join('\n'));
  for (let i = 0; i < 12 && f.polls.length < 6; i++) { await tick(f.ctx); f.now += 61e3; }
  assert.equal(f.polls.length, 6, f.lines.join('\n'));
  assert.ok(f.polls.every(p => /harness:restarted ABC-3$/.test(p)), f.polls.join('\n'));
  assert.equal(state(f), 'local-testing', f.lines.join('\n'));
  assert.equal(run(f)?.state, 'await-restart');
  assert.equal(f.ctx.memory.backoff.get(`run/${run(f).id}/await-restart`), undefined, 'no failure counted');
  assert.equal(f.variation()['last-script-failure'], undefined, 'no failure recorded');
  assert.ok(!f.lines.some(l => /failed 3 times|tried again in|-> blocked/.test(l)), f.lines.join('\n'));
  assert.ok(f.lines.some(l => /await-restart: script exited 1, not yet; polled again in 60s$/.test(l)), f.lines.join('\n'));
  // Restarted at last (exit 0): the run ends at done and the ticket moves on.
  await tick(f.ctx); f.now += 61e3;
  await tick(f.ctx);
  assert.equal(f.polls.length, 7, f.polls.join('\n'));
  assert.equal(run(f), undefined, f.lines.join('\n'));
  assert.equal(state(f), 'done', f.lines.join('\n'));
});

test('ASS-255 AC2: an exit await-restart does not define (2: no restart was requested) still fails, and 3 in a row send the ticket to Blocked', async () => {
  const f = fixture(Array(10).fill(2));
  await tick(f.ctx);
  for (let i = 0; i < 4; i++) { await tick(f.ctx); f.now += 31 * 60e3; }
  assert.equal(state(f), 'blocked', f.lines.join('\n'));
  assert.equal(f.polls.length, 3, f.polls.join('\n'));
});

test('ASS-255 AC2: an error between pending polls is not "in a row" — a pending poll forgets the failures before it', async () => {
  const codes = [2, 2, 1, 2, 2, 1];
  const f = fixture(codes);
  f.ctx.script = async () => ({ exitCode: codes.shift() ?? 1, stdout: '' });
  await tick(f.ctx);
  for (let i = 0; i < 6; i++) { await tick(f.ctx); f.now += 31 * 60e3; }
  assert.equal(codes.length, 0, f.lines.join('\n'));
  assert.equal(state(f), 'local-testing', f.lines.join('\n'));
});
