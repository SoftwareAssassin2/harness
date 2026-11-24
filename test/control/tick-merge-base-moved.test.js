// ASS-560 AC2: tickets of a project merge side by side, so main can move under
// a ticket's merge gate (another ticket merged first). The gate then says so
// (merge-request:merge-in-turn: exit 0, waiting and base-moved, with its
// ai-feedback — no failure, so no backoff and no Blocked for failing) and
// v2-release's Merge Pull Request goes back into itself: rebased and tested
// again on the next ask. Driven tick by tick by control with v2-release's own
// Merge Pull Request step (its update-workspace exit sent to done, so the
// group ends there), its script stubbed: each return is a visit, so
// max-visits sends the last to the group's Blocked and the ticket to Blocked,
// the variation's ai-feedback the gate's reason (record-script-output); one
// that merges after a move goes on, nothing stale left on the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { readEngine } from '../../src/workflow/engine-file.js';

const ROOT = join(import.meta.dirname, '..', '..');
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
const MOVED = { waiting: true, 'base-moved': true, main: 'main', was: 'a'.repeat(40), now: 'b'.repeat(40), 'merge-requests': [],
  'ai-feedback-short': 'merge gate: main moved while it ran (another ticket merged first); rebasing and testing again',
  'ai-feedback-long': 'main moved from aaaaaaa to bbbbbbb on origin while the gate ran. Each rebase is a visit to Merge Pull Request, so its max-visits bounds them.' };
const MERGED = { merged: true, branch: 'change/ABC-3-1', tested: 'c'.repeat(40), 'merge-requests': [], 'ai-feedback-short': null, 'ai-feedback-long': null };

// v2-release's Merge Pull Request alone, its merged exit to done.
function release() {
  const e = readEngine(join(ROOT, 'engines', 'v2-release', 'workflow.yaml'));
  e.steps = e.steps.filter(s => ['merge-pull-request', 'done', 'blocked', 'rebuild'].includes(s.id));
  for (const x of e.steps[0]['exit-events']) if (x['move-to-state'] === 'update-workspace') x['move-to-state'] = 'done';
  return e;
}

// The control fixture with p's local-testing step running that Release; ABC-3 A at merge-pull-request. Each ask of
// the step answers the next of `answers` (the last one again once they run out).
function fixture(answers) {
  const f = controlFixture();
  const engines = join(f.dir, 'engines');
  mkdirSync(join(engines, 'release'), { recursive: true });
  writeFileSync(join(engines, 'release', 'workflow.yaml'), JSON.stringify(release(), null, 4));
  edit(join(engines, 'example-development', 'workflow.yaml'), e => {
    e['check-health-interval-seconds'] = 1e9;
    const step = e.steps.find(s => s.id === 'local-testing');
    step.action = { type: 'state-engine', engine: 'release' };
    step['paired-ticket-system-status'] = 'In Review';
    const ended = at => ({ all: [{ 'is-done': true }, { 'sub-engine-ended-at': at }] });
    step['exit-events'] = [
      { condition: ended('blocked'), 'move-to-state': 'blocked' },
      { condition: ended('rebuild'), 'move-to-state': 'build' },
      { condition: { 'is-done': true }, 'move-to-state': 'done' },
    ];
  });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0]['ticket-system-status'] = 'In Review';
    s.features[0].variations[0]['harness-status'] = { state: 'local-testing', 'state-engine': 'example-development', 'sub-status': { state: 'merge-pull-request', 'state-engine': 'release' } };
  });
  f.now = Date.parse('2026-11-23T15:00:00Z');
  f.ctx.now = () => new Date(f.now);
  f.ctx.scriptWait = 60_000;
  f.asks = 0;
  f.ctx.script = argv => {
    if (argv[1] !== 'merge-request:merge-in-turn') return Promise.resolve({ exitCode: 0, stdout: '{}' });
    const out = answers[Math.min(f.asks++, answers.length - 1)];
    return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(out) });
  };
  f.run = () => f.assignments()['transient-state-engines'].find(r => r['state-engine'] === 'release');
  // The release run's moves, from control's log (the run is gone once it has ended).
  f.moves = () => f.lines.map(l => /run release \w+ (\S+) → (\S+)/.exec(l)).filter(Boolean).map(([, from, to]) => `${from}→${to}`);
  // A tick two minutes on: past the one-minute timer.
  f.poll = async (n = 1) => { for (let i = 0; i < n; i++) { f.now += 2 * 60e3; await tick(f.ctx); } };
  return f;
}

test('ASS-560 AC2: main moving under the merge gate again and again sends Merge Pull Request back into itself, each a visit, until its max-visits ends the Release at Blocked — the ticket Blocked, its ai-feedback saying main kept moving', async () => {
  const f = fixture([MOVED]);
  const max = release().steps[0]['max-visits'];
  try {
    await tick(f.ctx);
    assert.equal(f.run()?.state, 'merge-pull-request', f.lines.join('\n'));
    for (let i = 0; i < 3 * max && f.variation()['harness-status'].state === 'local-testing'; i++) await f.poll();
    assert.deepEqual(f.moves(), [...Array(max - 1).fill('merge-pull-request→merge-pull-request'), 'merge-pull-request→blocked'], f.lines.join('\n'));   // the fifth: max-visits' on-max-visits (no exit goes there)
    assert.equal(f.asks, max);                                                                    // asked once a visit: rebased and tested again each time
    const v = f.variation();
    assert.equal(v['harness-status'].state, 'blocked', f.lines.join('\n'));
    assert.equal(v['ai-feedback-short'], MOVED['ai-feedback-short']);
    assert.match(v['ai-feedback-long'], /max-visits/);
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-560 AC2: a gate that merges after main moved once goes on — the Release done, nothing stale on the board', async () => {
  const f = fixture([MOVED, MERGED]);
  try {
    await tick(f.ctx);
    for (let i = 0; i < 10 && f.variation()['harness-status'].state === 'local-testing'; i++) await f.poll();
    assert.deepEqual(f.moves().slice(0, 2), ['merge-pull-request→merge-pull-request', 'merge-pull-request→done'], f.lines.join('\n'));
    const v = f.variation();
    assert.equal(v['harness-status'].state, 'done', f.lines.join('\n'));
    assert.ok(!v['ai-feedback-short'], `no stale feedback: ${v['ai-feedback-short']}`);
  } finally {
    f.ctx.stopAgents();
  }
});

// ASS-560 AC3: with no project-wide merge turn, what keeps a ticket from merging before one it depends on is still
// the dependency hold (dependencies.js, ASS-195/ASS-355): at Merge Pull Request, its dependency not done, the step is
// never asked — no gate, no merge — however many ticks pass; once the dependency is done, it is asked and merges.
test('ASS-560 AC3: a ticket at Merge Pull Request whose dependency is not done never runs its merge gate; once the dependency is Done it merges', async () => {
  const f = fixture([MERGED]);
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['wait-for-dependencies'] = true; });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].dependencies = ['EX-1']; });
  const outside = status => writeFileSync(join(f.dir, 'projects', 'p', 'outside-tickets.json'), JSON.stringify({ tickets: [{ key: 'EX-1', title: 'A library first', url: 'https://example.test/browse/EX-1', 'ticket-system-status': status, 'ticket-system-assignment': 'A Teammate' }] }));
  outside('In Progress');
  try {
    await tick(f.ctx);
    await f.poll(5);
    assert.equal(f.asks, 0, f.lines.join('\n'));                                                  // held: the gate never asked
    assert.equal(f.variation()['harness-status'].state, 'local-testing');
    outside('Done');
    for (let i = 0; i < 10 && f.variation()['harness-status'].state === 'local-testing'; i++) await f.poll();
    assert.equal(f.asks, 1);
    assert.equal(f.variation()['harness-status'].state, 'done', f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});
