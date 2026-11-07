// A gap — the ticket system's status is not the step's paired status: the
// steps phase leaves the variation alone, logged once, and gap resolution
// owns it. A run working for a ticket sees the ticket's facts, so the
// investigate-gap engine's first step can read ticket-system-status and, when
// it is Done, accept it with ticket:accept-ticket-system-status — no agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { hs } from '../agent-cli/harness-fixture.js';
import { controlFixture, complete } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const ticks = async (ctx, n, until) => { for (let i = 0; i < n && !until(); i++) await tick(ctx); };

// The control fixture with the investigate-gap engine shaped as the real one — check-done (none) accepts a Done status through accept-done (script), anything else goes to the investigate prompt — ABC-3 at backlog with the ticket system saying `status`, and ABC-4 at backlog with no gap.
function gapFixture(status) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'investigate-gap', 'state-engine.json'), e => {
    e.steps = [
      { id: 'check-done', sequence: 1, action: { type: 'none' }, 'exit-events': [{ condition: { 'ticket-system-status': 'Done' }, 'move-to-state': 'accept-done' }, { condition: { not: { 'ticket-system-status': 'Done' } }, 'move-to-state': 'investigate' }] },
      { id: 'accept-done', sequence: 2, action: { type: 'script', command: './agent.sh ticket:accept-ticket-system-status {project} {ticket} {variation}' }, 'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'done' }, { condition: { not: { 'exit-code': 0 } }, 'move-to-state': 'investigate' }] },
      { id: 'investigate', sequence: 3, action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: complete, 'move-to-state': 'done' }] },
      { id: 'done', sequence: 4, 'is-done': true, action: { type: 'none' } },
    ];
  });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0]['ticket-system-status'] = status;
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': hs('backlog'), 'state-changes': [] }] });
  });
  return { ...f, at: key => f.sprint().features.find(t => t.key === key).variations[0] };
}

test('tick: a Done ticket found at backlog is not walked through the planning steps; gap resolution accepts the ticket system\'s status and the ticket lands at done, the ticket system untouched', async () => {
  const f = gapFixture('Done');
  try {
    await ticks(f.ctx, 8, () => f.at('ABC-3')['harness-status'].state === 'done' && !f.assignments()['transient-state-engines'].length);
    const v = f.at('ABC-3');
    assert.equal(v['harness-status'].state, 'done', f.lines.join('\n'));
    assert.deepEqual(v['state-changes'].map(c => [c['from-state'], c['to-state']]), [['backlog', 'done']]);   // never committed
    assert.equal(f.sprint().features[0]['ticket-system-status'], 'Done');
    assert.deepEqual(f.lines.filter(l => /left to gap resolution/.test(l)), ['steps ABC-3 A backlog: the ticket system says Done, the step pairs Backlog; left to gap resolution']);
    assert.ok(f.lines.some(l => l === 'gap p: started gap-resolution for ABC-3 A'), f.lines.join('\n'));
    assert.ok(!f.lines.some(l => /cli agent.sh ticket:set-ticket-system-status/.test(l)), f.lines.join('\n'));
    assert.deepEqual(f.assignments()['transient-state-engines'], []);
    assert.notEqual(f.at('ABC-4')['harness-status'].state, 'backlog');                 // the ticket without a gap went on as usual
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: any other gap holds the ticket where it is and goes to the investigate prompt, whose agent is dispatched for the run', async () => {
  const f = gapFixture('In Progress');
  try {
    await ticks(f.ctx, 6, () => f.assignments().assignments.some(a => a.state === 'investigate'));
    assert.equal(f.at('ABC-3')['harness-status'].state, 'backlog');
    assert.ok(f.assignments().assignments.some(a => a.state === 'investigate' && a['state-engine'] === 'investigate-gap'), f.lines.join('\n'));
    assert.equal(f.lines.filter(l => /left to gap resolution/.test(l)).length, 1);   // said once, however many ticks
  } finally {
    f.ctx.stopAgents();
  }
});

// ASS-224 AC3: a gap the variation's own sub-engine run answers — its step there has an exit on the ticket
// system's status (example Release's Team Code Review on In Testing or In Progress) — is no gap: no gap
// resolution, no agent; the run takes that exit on its next poll and the step moves by its own exits.
function releaseFixture() {
  const f = gapFixture('In Review');
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e.steps.push(
      { id: 'release', sequence: 7, 'paired-ticket-system-status': 'In Review', action: { type: 'state-engine', engine: 'release' },
        'exit-events': [{ condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'rebuild' }] }, 'move-to-state': 'build' }, { condition: { 'is-done': true }, 'move-to-state': 'qa' }] },
      { id: 'qa', sequence: 8, 'paired-ticket-system-status': 'In Testing', action: { type: 'human' }, 'exit-events': [] });
  });
  mkdirSync(join(f.dir, 'engines', 'release'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'release', 'state-engine.json'), JSON.stringify({ steps: [
    { id: 'team-code-review', sequence: 1, action: { type: 'script', command: './agent.sh ticket:set-paused {project} {ticket} {variation} false', mode: 'timer', 'timer-minutes': 5 },
      'exit-events': [{ condition: { 'ticket-system-status': 'In Testing' }, 'move-to-state': 'done' }, { condition: { 'ticket-system-status': 'In Progress' }, 'move-to-state': 'rebuild' }] },
    { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
    { id: 'rebuild', sequence: 3, 'is-done': true, action: { type: 'none' } },
  ] }));
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0]['harness-status'] = hs('release'); });
  return f;
}

// The release run started and polled once at In Review, then the ticket system moved to `status`, and the five minutes to the next poll passed.
async function movedDuringRelease(f, status) {
  let clock = Date.now();
  f.ctx.now = () => new Date(clock);
  await ticks(f.ctx, 3, () => f.assignments()['transient-state-engines'].some(r => r['state-engine'] === 'release'));
  await tick(f.ctx);   // the run's first poll
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0]['ticket-system-status'] = status; });
  await ticks(f.ctx, 3, () => false);
  assert.equal(f.at('ABC-3')['harness-status'].state, 'release', 'waits for the next poll');
  clock += 5 * 60_000;
}

for (const [status, to] of [['In Testing', 'qa'], ['In Progress', 'build']]) {
  test(`ASS-224 AC3: Release with the ticket system moved to ${status} goes to ${to} by its own run's exit on its next poll — no gap resolution, no agent`, async () => {
    const f = releaseFixture();
    try {
      await movedDuringRelease(f, status);
      await ticks(f.ctx, 4, () => f.at('ABC-3')['harness-status'].state !== 'release');
      assert.deepEqual(f.at('ABC-3')['state-changes'].filter(c => !c['sub-state-change'] && c['from-state'] === 'release').map(c => [c['from-state'], c['to-state']]), [['release', to]], f.lines.join('\n'));
      assert.ok(!f.lines.some(l => /gap/.test(l)), f.lines.join('\n'));
      assert.ok(!f.assignments().assignments.some(a => a['state-engine'] === 'investigate-gap'));
    } finally {
      f.ctx.stopAgents();
    }
  });
}

test('ASS-224 AC3: gated on leaving Release, the status-driven move waits at the gate for the human — still no gap resolution', async () => {
  const f = releaseFixture();
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0]['gate-when-leaving-state'] = ['example-development/release']; });
  try {
    await movedDuringRelease(f, 'In Testing');
    await ticks(f.ctx, 4, () => f.at('ABC-3')['state-changes'].at(-1)?.['work-is-done'] === true);
    await ticks(f.ctx, 2, () => false);
    const v = f.at('ABC-3');
    assert.equal(v['harness-status'].state, 'release', f.lines.join('\n'));
    assert.equal(v['state-changes'].at(-1)['pending-move']?.to, 'qa', f.lines.join('\n'));
    assert.ok(!f.lines.some(l => /gap/.test(l)), f.lines.join('\n'));
  } finally {
    f.ctx.stopAgents();
  }
});

// ASS-282: QA (the real grouped-qa) — a qa step paired with In Testing, ended by its run at blocked to Blocked, else to done.
// The ticket entered QA at In Testing and its run waits at qa-testing; then QA sets `status`.
function qaFixture() {
  const f = gapFixture('In Testing');
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e.steps.push({ id: 'qa', sequence: 7, 'paired-ticket-system-status': 'In Testing', 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'qa',
      action: { type: 'state-engine', engine: 'grouped-qa' },
      'exit-events': [{ condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked' }] }, 'move-to-state': 'blocked' }, { condition: { 'is-done': true }, 'move-to-state': 'done' }] });
  });
  mkdirSync(join(f.dir, 'engines', 'grouped-qa'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'grouped-qa', 'state-engine.json'), readFileSync(join(import.meta.dirname, '..', '..', 'engines', 'grouped-qa', 'state-engine.json'), 'utf8'));
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0]['harness-status'] = hs('qa'); s.features.pop(); });
  return f;
}

async function qaSets(f, status) {
  const qaRun = () => f.assignments()['transient-state-engines'].find(r => r['state-engine'] === 'grouped-qa');
  await ticks(f.ctx, 4, () => qaRun()?.state === 'qa-testing');
  await ticks(f.ctx, 2, () => false);
  assert.equal(qaRun()?.state, 'qa-testing', `waits at qa-testing while In Testing\n${f.lines.join('\n')}`);
  assert.equal(f.at('ABC-3')['harness-status'].state, 'qa');
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0]['ticket-system-status'] = status; });
  await ticks(f.ctx, 6, () => f.at('ABC-3')['harness-status'].state !== 'qa');
}

for (const [status, to] of [['On Hold', 'blocked'], ['In Progress', 'blocked'], ['Done', 'done']]) {
  test(`ASS-282 AC${to === 'done' ? 3 : 2}: at qa/qa-testing, QA setting ${status} ends the grouped-qa run and the ticket goes to ${to} — no gap resolution`, async () => {
    const f = qaFixture();
    try {
      await qaSets(f, status);
      const v = f.at('ABC-3');
      assert.equal(v['harness-status'].state, to, f.lines.join('\n'));
      assert.deepEqual(v['state-changes'].filter(c => !c['sub-state-change']).map(c => [c['from-state'], c['to-state']]), [['qa', to]], f.lines.join('\n'));
      assert.ok(!f.lines.some(l => /gap/.test(l)), f.lines.join('\n'));
      assert.ok(!f.assignments().assignments.some(a => a['state-engine'] === 'investigate-gap'));
    } finally {
      f.ctx.stopAgents();
    }
  });
}
