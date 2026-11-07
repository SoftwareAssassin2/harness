import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressSince, progressLines } from '../../src/tui/updates.js';
import { link, visible } from '../../src/tui/text.js';
// A harness-status at `state` of the example-development engine.
const hs = state => ({ state, 'state-engine': 'example-development' });

const steps = [
  { id: 'committed', name: 'Committed', sequence: 1 },
  { id: 'build', name: 'Build', sequence: 5 },
  { id: 'review', name: 'Review', sequence: 9 },
  { id: 'done', name: 'Done', sequence: 10 },
  { id: 'blocked', name: 'Blocked', sequence: 0, area: 'quarantine' },
];
const since = Date.parse('2026-09-25T09:00:00Z');
const before = '2026-09-24T12:00:00Z', after = n => `2026-09-25T1${n}:00:00Z`;
// A variation's history as [from, to, timestamp] moves; its status is the last move's target.
const variation = (name, moves, fields = {}) => ({
  name, 'harness-status': hs(moves.at(-1)?.[1] ?? 'committed'), ...fields,
  'state-changes': moves.map(([from, to, timestamp]) => ({ 'from-state': from, 'to-state': to, timestamp })),
});
const ticket = (key, title, ...variations) => ({ key, title, variations });
const sprint = {
  features: [
    ticket('T-1', 'Shipped it', variation('A', [['committed', 'build', before], ['build', 'review', after(1)], ['review', 'done', after(2)]])),
    ticket('T-2', 'Bumpy road', variation('A', [['committed', 'build', after(1)], ['build', 'review', after(2)], ['review', 'build', after(3)], ['build', 'review', after(4)]])),
    ticket('T-6', 'Two ways', variation('A', [['committed', 'build', after(1)]]), variation('B', [['committed', 'review', after(2)]])),
  ],
  bugs: [
    ticket('T-3', 'Went back', variation('A', [['committed', 'review', before], ['review', 'build', after(1)]])),
    ticket('T-4', 'Stuck', variation('A', [['committed', 'blocked', after(1)]], { 'ai-feedback-short': 'Needs a format' })),
    ticket('T-5', 'Quiet', variation('A', [['committed', 'build', before]])),
    ticket('T-8', 'Resumed', variation('A', [['committed', 'blocked', before], ['blocked', 'build', after(1)], ['build', 'review', after(2)]])),
    ticket('T-9', 'Freed and shipped', variation('A', [['committed', 'blocked', after(1)], ['blocked', 'build', after(2)], ['build', 'done', after(3)]])),
  ],
  spikes: [ticket('T-7', 'No history', { name: 'A', 'harness-status': hs('build') })],
};
const progress = progressSince({ sprint, steps, since });
const section = title => progress.sections.find(s => s.title === title)?.bullets;

test('a ticket that reached the last step since then is delivered, from where it stood then', () => {
  assert.deepEqual(section('Delivered'), ['T-1: Shipped it (Build → Done)', 'T-9: Freed and shipped (Committed → Done)']);
});

test('a ticket further along now is moved forward, noting each time it was sent back on the way', () => {
  assert.deepEqual(section('Moved forward'), ['T-2: Bumpy road (Committed → Review, sent back once)', 'T-6.A: Two ways (Committed → Build)', 'T-6.B: Two ways (Committed → Review)', 'T-8: Resumed (Blocked → Review)']);
});

test('a ticket behind where it stood is sent back; one now in quarantine is blocked, with why', () => {
  assert.deepEqual(section('Sent back'), ['T-3: Went back (Review → Build)']);
  assert.deepEqual(section('Blocked'), ['T-4: Stuck (Committed → Blocked): Needs a format']);
});

test('a block resolved since then is progress: unblocked, with where it resumed, whatever the ticket did next', () => {
  assert.deepEqual(section('Unblocked'), ['T-8: Resumed (Blocked → Build)', 'T-9: Freed and shipped (Blocked → Build)']);
});

test('tickets that did not move since then, and those without a history, are left out; so are empty sections', () => {
  const all = progress.sections.flatMap(s => s.bullets).join('\n');
  for (const key of ['T-5', 'T-7']) assert.ok(!all.includes(key), key);
  assert.deepEqual(progress.sections.map(s => s.title), ['Delivered', 'Unblocked', 'Moved forward', 'Sent back', 'Blocked']);
  const quiet = progressSince({ sprint: { features: [sprint.bugs[2]] }, steps, since });
  assert.deepEqual(quiet.sections, []);
  assert.equal(quiet.summary, 'No progress since then.');
});

test('a summary counts what moved', () => {
  assert.equal(progress.summary, '8 tickets moved: 2 delivered, 4 moved forward, 1 sent back, 1 blocked; 2 blocks resolved.');
});

test('a ticket line links its key to the ticket\'s url when the sprint has one (ASS-86), plain text when not, and the link takes no width', () => {
  const linked = {
    features: [
      ticket('T-1', 'Shipped it', variation('A', [['committed', 'done', after(1)]])),
      { ...ticket('T-6', 'Two ways', variation('A', [['committed', 'build', after(1)]]), variation('B', [['committed', 'blocked', after(2)]])), url: 'file:///h/T-6.md' },
      { ...ticket('T-8', 'Resumed', variation('A', [['committed', 'blocked', before], ['blocked', 'build', after(1)]])), url: 'http://t/8' },
    ],
  };
  const out = progressSince({ sprint: linked, steps, since });
  const bullets = title => out.sections.find(s => s.title === title).bullets;
  assert.deepEqual(bullets('Delivered'), ['T-1: Shipped it (Committed → Done)']);
  assert.deepEqual(bullets('Moved forward'), [`${link('T-6.A', 'file:///h/T-6.md')}: Two ways (Committed → Build)`, `${link('T-8', 'http://t/8')}: Resumed (Blocked → Build)`]);
  assert.deepEqual(bullets('Blocked'), [`${link('T-6.B', 'file:///h/T-6.md')}: Two ways (Committed → Blocked)`]);
  assert.deepEqual(bullets('Unblocked'), [`${link('T-8', 'http://t/8')}: Resumed (Blocked → Build)`]);
  const lines = progressLines(out, 20);
  assert.ok(lines.every(l => visible(l) <= 20));
  assert.ok(lines.includes(`• ${link('T-8', 'http://t/8')}: Resumed`));
});
