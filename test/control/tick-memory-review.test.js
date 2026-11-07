// A deleted or reverted ticket's memories reviewed (ASS-146): ticket:delete
// starts the check-memory run scoped to the ticket, which control dispatches
// as any run; and hourly per project control asks each repository's forge
// (gh api, glab api — fakes here) for the default branch's commits since its
// last check, each `Revert "<KEY>: …"` of a ticket the project knows
// starting one such review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { fakeForge } from '../support/fake-forge.js';
import { tick } from '../../src/control/tick.js';
import { detectReverts } from '../../src/control/reverts.js';

const HOUR = 3600_000;
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The control fixture with check-memory-steps (the real engines' shape), the
// check-memory engine's one prompt step, repositories `repositories`, and
// gh and glab the fakes.
function reviewFixture({ repositories = ['https://github.com/o/app'], background = true, steps = true } = {}) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    if (steps) e['check-memory-steps'] = [{ id: 'check-memory', sequence: 1, action: { type: 'state-engine', engine: 'check-memory' }, 'exit-events': [{ condition: { 'is-done': true } }] }];
  });
  mkdirSync(join(f.dir, 'engines', 'check-memory'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'check-memory', 'state-engine.json'), JSON.stringify({ steps: [
    { id: 'clean-memory', sequence: 1, action: { type: 'prompt', prompt: 'clean-memory', 'agent-count': 1, 'run-in-dev-container': false }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }] },
    { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
  ] }));
  mkdirSync(join(f.dir, 'prompts', 'clean-memory'), { recursive: true });
  writeFileSync(join(f.dir, 'prompts', 'clean-memory', 'prompt.txt'), 'Check the memories of {project}, ticket {ticket}, into {ticket-folder}.\n');
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => {
    p.repositories = repositories.map(url => ({ url }));
    if (!background) p['background-work'] = false;
  });
  const forge = fakeForge();
  f.ctx.env = { ...f.env, PATH: forge.path };
  let clock = f.ctx.started.getTime();
  f.ctx.now = () => new Date(clock);
  const reviews = () => f.assignments()['transient-state-engines'].filter(r => r.parent.trigger === 'check-memory').map(r => r.parent['work-item']);
  const checked = () => { const file = join(f.dir, 'projects', 'p', 'revert-checks.json'); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; };
  return { f, forge, reviews, checked, now: () => clock, later: ms => { clock += ms; } };
}
const ghCommit = (sha, subject, at) => ({ sha, commit: { message: `${subject}\n\nThis reverts commit 123.`, committer: { date: at } } });

test('AC1, AC3: a deleted ticket\'s review is dispatched by control as any run: the clean-memory agent on that ticket, its folder the ticket\'s', async () => {
  const { f } = reviewFixture();
  await f.agent('ticket:delete', 'p', 'ABC-3');
  await tick(f.ctx);
  const [agent, ...more] = f.assignments().assignments;
  assert.deepEqual(more, []);
  assert.deepEqual([agent.prompt, agent['work-item'], agent['state-engine'], agent.state], ['clean-memory', 'ABC-3', 'check-memory', 'clean-memory']);
});

test('AC2: hourly, a revert of a known ticket on the default branch starts one review of its memories; a non-revert commit and a revert of an unknown key start none; never twice for the same commit', async () => {
  const { f, forge, reviews, checked, now, later } = reviewFixture();
  later(HOUR);
  const first = now();
  forge.route('gh', new RegExp(`^api repos/o/app/commits\\?since=${esc(iso(first - HOUR))}&per_page=100$`), { out: [
    ghCommit('c3', 'Revert "ABC-3: build the thing"', iso(first - 60_000)),
    ghCommit('c2', 'ABC-3: build the thing', iso(first - 120_000)),
    ghCommit('c1', 'Revert "ZZZ-9: not ours"', iso(first - 180_000)),
  ] });
  await detectReverts(f.ctx, f.ctx.load());
  assert.deepEqual(reviews(), ['ABC-3']);
  assert.ok(f.lines.includes('reverts p: c3 on https://github.com/o/app reverts ABC-3; its memories are reviewed'), f.lines.join('\n'));
  assert.ok(f.lines.includes('reverts p: started check-memory for ABC-3'), f.lines.join('\n'));
  assert.deepEqual(checked(), { 'https://github.com/o/app': iso(first) });

  await detectReverts(f.ctx, f.ctx.load());                                     // within the hour: the forge is not asked
  assert.equal(forge.log('gh').length, 1);

  for (const r of f.assignments()['transient-state-engines']) await f.agent('transient-state-engine:remove', r.id);   // the review over
  later(HOUR);
  forge.route('gh', new RegExp(`^api repos/o/app/commits\\?since=${esc(iso(first))}&per_page=100$`), { out: [] });
  await detectReverts(f.ctx, f.ctx.load());
  assert.equal(forge.log('gh').length, 2);
  assert.deepEqual(reviews(), []);                                               // asked from the last check on: c3 not again
  assert.deepEqual(checked(), { 'https://github.com/o/app': iso(now()) });
});

test('AC2: a GitLab repository is asked through glab api on its host; a failed forge call is logged and retried next hour from the same last check', async () => {
  const { f, forge, reviews, checked, now, later } = reviewFixture({ repositories: ['https://gitlab.com/g/sub/app'] });
  writeFileSync(join(f.dir, 'projects', 'p', 'revert-checks.json'), JSON.stringify({ 'https://gitlab.com/g/sub/app': '2026-10-01T00:00:00Z' }));
  const ask = new RegExp(`^api projects/g%2Fsub%2Fapp/repository/commits\\?since=2026-10-01T00:00:00Z&per_page=100 --hostname gitlab\\.com$`);
  forge.route('glab', ask, { exit: 1, out: 'HTTP 502' });
  later(HOUR);
  await detectReverts(f.ctx, f.ctx.load());
  assert.ok(f.lines.some(l => /^error reverts p https:\/\/gitlab\.com\/g\/sub\/app: glab api /.test(l)), f.lines.join('\n'));
  assert.deepEqual(checked(), { 'https://gitlab.com/g/sub/app': '2026-10-01T00:00:00Z' });
  assert.deepEqual(reviews(), []);

  forge.route('glab', ask, { out: [{ id: 'g1', title: 'Revert "abc-3: build the thing"', committed_date: '2026-10-02T00:00:00Z' }] });
  later(HOUR);
  await detectReverts(f.ctx, f.ctx.load());
  assert.equal(forge.log('glab').length, 2);
  assert.deepEqual(reviews(), ['ABC-3']);
  assert.deepEqual(checked(), { 'https://gitlab.com/g/sub/app': iso(now()) });
});

test('AC2: a project whose engine has no check-memory-steps, or whose background work is off, asks no forge', async () => {
  for (const options of [{ steps: false }, { background: false }]) {
    const { f, forge, later } = reviewFixture(options);
    later(HOUR);
    await detectReverts(f.ctx, f.ctx.load());
    assert.deepEqual(forge.log('gh'), [], JSON.stringify(options));
  }
});

test('AC2: tick runs the revert check', async () => {
  const { f, forge, reviews, later } = reviewFixture();
  forge.route('gh', /^api repos\/o\/app\/commits/, { out: [ghCommit('c3', 'Revert "ABC-3: build the thing"', '2026-10-02T00:00:00Z')] });
  later(HOUR);
  await tick(f.ctx);
  assert.deepEqual(reviews(), ['ABC-3']);
});

test('ASS-232: while p is held for its weekly usage, a revert starts no review and the repository is not marked checked; once the hold lifts, the review starts', async () => {
  const { f, forge, reviews, checked, now, later } = reviewFixture();
  const usage = percent => writeFileSync(join(f.dir, 'projects', 'p', 'claude-usage.json'), JSON.stringify({ email: 'fake@example.com', session: { percent: 1, 'resets-at': '2099-01-01T00:00:00Z' }, weekly: { percent, 'resets-at': '2099-01-01T00:00:00Z' } }));
  later(HOUR);
  const first = now();
  forge.route('gh', new RegExp(`^api repos/o/app/commits\\?since=${esc(iso(first - HOUR))}&per_page=100$`), { out: [ghCommit('c3', 'Revert "ABC-3: build the thing"', iso(first - 60_000))] });
  const before = { 'https://github.com/o/app': iso(first - HOUR) };   // its last check, before the hold
  writeFileSync(join(f.dir, 'projects', 'p', 'revert-checks.json'), JSON.stringify(before));
  usage(95);
  await detectReverts(f.ctx, f.ctx.load());
  assert.deepEqual([reviews(), checked(), forge.log('gh')], [[], before, []], f.lines.join('\n'));
  usage(10);
  later(HOUR);
  await detectReverts(f.ctx, f.ctx.load());
  assert.deepEqual(reviews(), ['ABC-3'], f.lines.join('\n'));
  assert.equal(forge.log('gh').length, 1, 'asked once, from its last check before the hold');
  assert.deepEqual(checked(), { 'https://github.com/o/app': iso(now()) });
});
