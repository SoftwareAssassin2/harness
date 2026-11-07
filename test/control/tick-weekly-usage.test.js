// ASS-232: a project's weekly Claude usage at or above its
// background-weekly-usage-limit-percent (project.json; absent 90, null never),
// by its last claude-usage.json reading before that week resets, holds its
// grooming and background work (BACKGROUND triggers: check-health and the
// rest, and the runs under them) — never moved onto the API key — while its
// sprint work goes on. The hold is logged once when it starts and once when
// it lifts; a missing or `-` reading never holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';

const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const FUTURE = '2099-01-01T00:00:00Z';

// The control fixture with ABC-50, a backlog ticket at the groom step of a
// one-prompt refinement engine, every fake agent's turn held open, and helpers:
// usage(percent, resetsAt) writes p's claude-usage.json as
// project:set-claude-usage does (percent undefined: weekly null; null: `-`),
// limit(value) sets project.json's limit (undefined: absent), groomed() and
// background() whether ABC-50 and a transient run have an agent, sprint()
// whether ABC-3's plan step has one, holds() the hold lines logged.
function weekly() {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e['backlog-refinement-steps'] = [{ id: 'backlog-refinement', sequence: 1, action: { type: 'state-engine', engine: 'refine' }, 'exit-events': [{ condition: { 'is-done': true } }] }];
  });
  mkdirSync(join(f.dir, 'engines', 'refine'));
  writeFileSync(join(f.dir, 'engines', 'refine', 'state-engine.json'), JSON.stringify({ steps: [
    { id: 'groom', sequence: 1, action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }] },
    { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
  ] }));
  writeFileSync(join(f.dir, 'projects', 'p', 'backlog.json'), JSON.stringify({ tickets: [{ key: 'ABC-50', title: 'ABC-50', priority: 50, variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'refine' }, 'state-changes': [] }] }] }));
  edit(join(f.dir, 'harness.json'), h => { h['max-tickets-in-grooming'] = 5; });
  process.env.FAKE_HOLD = join(f.dir, 'hold');
  writeFileSync(process.env.FAKE_HOLD, '');
  const usageFile = join(f.dir, 'projects', 'p', 'claude-usage.json');
  const assignments = () => f.assignments().assignments;
  return {
    ...f,
    usage: (percent, resetsAt = FUTURE) => (percent === 'missing' ? rmSync(usageFile, { force: true }) : writeFileSync(usageFile, JSON.stringify({ email: 'fake@example.com', session: { percent: 1, 'resets-at': FUTURE }, weekly: percent === undefined ? null : { percent, 'resets-at': percent === null ? null : resetsAt }, 'auth-method': 'claude.ai', org: 'Fake Org', 'as-of': '2026-10-29T00:00:00Z' }))),
    limit: value => edit(join(f.dir, 'projects', 'p', 'project.json'), p => { if (value === undefined) delete p['background-weekly-usage-limit-percent']; else p['background-weekly-usage-limit-percent'] = value; }),
    groomed: () => assignments().find(a => a['work-item'] === 'ABC-50'),
    background: () => assignments().find(a => a['transient-state-engine']),
    sprint: () => assignments().find(a => a['work-item'] === 'ABC-3' && a.state === 'plan'),
    holds: () => f.lines.filter(l => l.startsWith('hold p: ')),
    // Drops every agent and its assignment, so the next tick dispatches afresh.
    clear: () => { f.ctx.stopAgents(); f.ctx.agents.clear(); edit(join(f.dir, 'assignments.json'), a => { a.assignments = []; }); },
  };
}
const done = f => { delete process.env.FAKE_HOLD; f.ctx.stopAgents(); };

test('ASS-232 AC2, AC3: at or above the default 90%, grooming is held while sprint work dispatches; the hold is logged once, and once when usage drops below it', async () => {
  const f = weekly();
  try {
    f.usage(89.9);
    await tick(f.ctx);
    assert.ok(f.groomed(), `below: groomed\n${f.lines.join('\n')}`);
    assert.deepEqual(f.holds(), []);
    f.clear();
    f.usage(90);
    await tick(f.ctx);
    await tick(f.ctx);
    assert.equal(f.groomed(), undefined, f.lines.join('\n'));
    assert.ok(f.sprint(), `sprint work goes on\n${f.lines.join('\n')}`);
    assert.deepEqual(f.holds(), ['hold p: weekly Claude usage is 90%, at or above its limit of 90%; its grooming and background work are held']);
    f.usage(40);
    await tick(f.ctx);
    await tick(f.ctx);
    assert.ok(f.groomed(), f.lines.join('\n'));
    assert.deepEqual(f.holds().slice(1), ['hold p: weekly Claude usage is 40%, under its limit of 90%; its grooming and background work go on']);
  } finally { done(f); }
});

test('ASS-232 AC1, AC3: a per-project limit is the threshold; null never holds; a hold lifts, logged, once the week\'s reset has passed', async () => {
  const f = weekly();
  try {
    f.limit(95);
    f.usage(94);
    await tick(f.ctx);
    assert.ok(f.groomed(), `94% under 95%: groomed\n${f.lines.join('\n')}`);
    f.clear();
    f.usage(95);
    await tick(f.ctx);
    assert.equal(f.groomed(), undefined, f.lines.join('\n'));
    f.limit(null);
    f.usage(100);
    await tick(f.ctx);
    assert.ok(f.groomed(), `null: never held\n${f.lines.join('\n')}`);
    assert.equal(f.holds()[1], 'hold p: its weekly usage limit is off; its grooming and background work go on');
    f.clear();
    f.limit(undefined);
    await tick(f.ctx);
    assert.equal(f.groomed(), undefined, `absent: 90 again\n${f.lines.join('\n')}`);
    f.usage(100, '2000-01-01T00:00:00Z');
    await tick(f.ctx);
    assert.ok(f.groomed(), `the week has reset\n${f.lines.join('\n')}`);
    assert.equal(f.holds().at(-1), 'hold p: its weekly Claude usage has reset; its grooming and background work go on');
    assert.equal(f.holds().length, 4, f.holds().join('\n'));
  } finally { done(f); }
});

test('ASS-232 AC4: a missing reading, a weekly null (no weekly cap) or a `-` percent never holds', async () => {
  for (const percent of ['missing', undefined, null]) {
    const f = weekly();
    try {
      f.usage(percent);
      await tick(f.ctx);
      assert.ok(f.groomed(), `${percent}\n${f.lines.join('\n')}`);
      assert.deepEqual(f.holds(), []);
    } finally { done(f); }
  }
});

test('ASS-232 AC2: held background work never falls back to the API key — with the subscription rate limited, sprint work goes onto the API key and grooming waits', async () => {
  const f = weekly();
  try {
    for (const d of ['.claude', '.claude-api']) mkdirSync(join(f.dir, 'projects', 'p', d));
    writeFileSync(join(f.dir, 'projects', 'p', 'rate-limit.json'), JSON.stringify({ claude: { since: '2026-10-29T00:00:00Z', type: 'seven_day', 'resets-at': FUTURE } }));
    f.usage(98);
    await tick(f.ctx);
    await tick(f.ctx);
    assert.equal(f.groomed(), undefined, f.lines.join('\n'));
    assert.equal(f.sprint()?.['payment-method'], 'api', f.lines.join('\n'));
    f.usage(50);
    await tick(f.ctx);
    assert.equal(f.groomed()?.['payment-method'], 'api', `not held: grooming on the API key, as ASS-217 has it\n${f.lines.join('\n')}`);
  } finally { done(f); }
});

test('ASS-232 AC2: at the limit no BACKGROUND trigger starts, and a background run already going gets no agent; under it, both go on', async () => {
  const f = weekly();
  let clock = f.ctx.started.getTime();
  f.ctx.now = () => new Date(clock);
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e['check-health-interval-seconds'] = 300; });
  const triggers = () => f.assignments()['transient-state-engines'].map(r => r.parent.trigger).filter(Boolean);
  try {
    f.usage(92);
    clock += 600e3;
    await tick(f.ctx);
    assert.deepEqual(triggers(), [], f.lines.join('\n'));
    f.usage(10);
    clock += 600e3;
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(triggers(), ['check-health'], f.lines.join('\n'));
    assert.ok(f.background(), `the run under it gets an agent\n${f.lines.join('\n')}`);
    f.clear();
    f.usage(92);
    await tick(f.ctx);
    await tick(f.ctx);
    assert.equal(f.background(), undefined, `a background run already going gets no agent\n${f.lines.join('\n')}`);
  } finally { done(f); }
});
