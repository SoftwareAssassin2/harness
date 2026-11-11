// ASS-359 AC3: grouped-build's Await Sequential Merge
// (merge-request:await-dependencies, a timer step whose waiting exit is 2)
// exits 3 when a dependency is one of the ticket's own planned merge requests
// that Generate Solution never created: control moves the run back to
// Generate Solution rather than polling it forever, within that step's
// max-visits (5), then to Blocked. Its waiting (2) still stays, no failure.
// The command's own tests: test/agent-cli/merge-requests.test.js.
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
const grouped = JSON.parse(readFileSync(join(engineDir('grouped-build'), 'state-engine.json'), 'utf8'));
const KEPT = ['generate-solution', 'address-merge-request-feedback', 'await-dependencies', 'refresh-before-testing', 'done', 'blocked'];

// The control fixture with ABC-3 A at local-testing, which runs grouped-build's own await-dependencies, generate-solution
// (its exits, max-visits and on-max-visits as they are; its agent the fixture's test prompt, on the host) and the refresh
// after, so the run starts at await-dependencies; its ends are Build's exits (ended at blocked to Blocked, else Done).
// Every script faked, exiting each of `codes` in turn, then 0.
function fixture(codes) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e['check-health-interval-seconds'] = 1e9;
    Object.assign(e.steps.find(s => s.id === 'local-testing'), { action: { type: 'state-engine', engine: 'build' }, 'exit-events': [
      { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked' }] }, 'move-to-state': 'blocked' },
      { condition: { 'is-done': true }, 'move-to-state': 'done' }] });
  });
  const steps = grouped.steps.filter(s => KEPT.includes(s.id)).map(s => {
    if (s.id === 'await-dependencies') return { ...s, sequence: 0 };
    if (s.id === 'generate-solution' || s.id === 'address-merge-request-feedback') { const { 'run-location': _, ...rest } = s; return { ...rest, action: { ...s.action, prompt: 'test', 'run-in-dev-container': false } }; }
    const { 'run-location': _, ...rest } = s;
    return rest;
  });
  mkdirSync(join(f.dir, 'engines', 'build'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'build', 'state-engine.json'), JSON.stringify({ steps }));
  edit(sprint(f), s => {
    s.features[0]['ticket-system-status'] = 'In Progress';
    s.features[0].variations[0]['harness-status'] = hs('local-testing');
  });
  f.now = Date.parse('2026-11-10T14:00:00Z');
  f.ctx.now = () => new Date(f.now);
  f.polls = [];
  f.ctx.script = async argv => { f.polls.push(argv.join(' ')); return { exitCode: codes.shift() ?? 0, stdout: JSON.stringify({ waiting: [] }) }; };
  return f;
}

const state = f => f.variation()['harness-status'].state;
const run = f => f.assignments()['transient-state-engines'].find(r => r['state-engine'] === 'build');

test('ASS-359 AC3: await-dependencies\' exit 3 moves the run back to Generate Solution, while its waiting (2) stays where it is, polled on its timer', async () => {
  const f = fixture([2, 3]);
  await tick(f.ctx);                                                              // the run started, at await-dependencies
  assert.equal(run(f)?.state, 'await-dependencies', f.lines.join('\n'));
  await tick(f.ctx);
  assert.equal(f.polls.length, 1, f.polls.join('\n'));
  assert.match(f.polls[0], /merge-request:await-dependencies p ABC-3 A$/);
  assert.equal(run(f).state, 'await-dependencies', 'waiting (2) stays');
  f.now += 5 * 60e3 + 1e3;
  await tick(f.ctx);
  assert.equal(f.polls.length, 2, f.polls.join('\n'));
  assert.equal(run(f)?.state, 'generate-solution', f.lines.join('\n'));
  assert.equal(state(f), 'local-testing');
  assert.ok(f.lines.some(l => /await-dependencies → generate-solution/.test(l)), f.lines.join('\n'));
});

test('ASS-359 AC3: at Generate Solution\'s max-visits (5), exit 3 ends the run at Blocked, and the ticket goes to Blocked', async () => {
  const f = fixture([3]);
  await tick(f.ctx);
  assert.equal(run(f)?.state, 'await-dependencies', f.lines.join('\n'));
  // Five rounds through Generate Solution already in this run.
  edit(join(f.dir, 'assignments.json'), a => {
    const r = a['transient-state-engines'].find(t => t['state-engine'] === 'build');
    r['state-changes'] = Array.from({ length: 5 }, (_, i) => [
      { 'from-state': 'await-dependencies', 'to-state': 'generate-solution', timestamp: `2026-11-10T1${i}:00:00Z` },
      { 'from-state': 'generate-solution', 'to-state': 'await-dependencies', timestamp: `2026-11-10T1${i}:30:00Z` }]).flat();
  });
  for (let i = 0; i < 3 && state(f) !== 'blocked'; i++) await tick(f.ctx);
  assert.equal(f.polls.length, 1, f.polls.join('\n'));
  assert.equal(state(f), 'blocked', f.lines.join('\n'));
  assert.ok(f.lines.some(l => /await-dependencies → blocked/.test(l)), f.lines.join('\n'));
});

// ASS-361 AC3: exit 4 — a dependency of the ticket's own with review threads,
// review comments, a failed pipeline or a needed rebase — moves the run to
// Build's own Address Merge Request Feedback (its agent, here the fixture's
// test prompt), under that step's max-visits (3), then Blocked.
test('ASS-361 AC3: await-dependencies\' exit 4 moves the run to Address Merge Request Feedback; waiting (2) stays where it is', async () => {
  const f = fixture([2, 4]);
  await tick(f.ctx);
  assert.equal(run(f)?.state, 'await-dependencies', f.lines.join('\n'));
  await tick(f.ctx);
  assert.equal(run(f).state, 'await-dependencies', 'waiting (2) stays');
  f.now += 5 * 60e3 + 1e3;
  await tick(f.ctx);
  assert.equal(f.polls.length, 2, f.polls.join('\n'));
  assert.equal(run(f)?.state, 'address-merge-request-feedback', f.lines.join('\n'));
  assert.equal(state(f), 'local-testing');
  assert.ok(f.lines.some(l => /await-dependencies → address-merge-request-feedback/.test(l)), f.lines.join('\n'));
});

test('ASS-361 AC3: at Address Merge Request Feedback\'s max-visits (3), exit 4 ends the run at Blocked, and the ticket goes to Blocked', async () => {
  const f = fixture([4]);
  await tick(f.ctx);
  assert.equal(run(f)?.state, 'await-dependencies', f.lines.join('\n'));
  // Three rounds through Address Merge Request Feedback already in this run.
  edit(join(f.dir, 'assignments.json'), a => {
    const r = a['transient-state-engines'].find(t => t['state-engine'] === 'build');
    r['state-changes'] = Array.from({ length: 3 }, (_, i) => [
      { 'from-state': 'await-dependencies', 'to-state': 'address-merge-request-feedback', timestamp: `2026-11-10T1${i}:00:00Z` },
      { 'from-state': 'address-merge-request-feedback', 'to-state': 'await-dependencies', timestamp: `2026-11-10T1${i}:30:00Z` }]).flat();
  });
  for (let i = 0; i < 3 && state(f) !== 'blocked'; i++) await tick(f.ctx);
  assert.equal(f.polls.length, 1, f.polls.join('\n'));
  assert.equal(state(f), 'blocked', f.lines.join('\n'));
  assert.ok(f.lines.some(l => /await-dependencies → blocked/.test(l)), f.lines.join('\n'));
});
