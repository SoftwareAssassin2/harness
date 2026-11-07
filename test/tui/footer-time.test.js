// ASS-295: each screen sizes itself against the header and platform boxes as
// render draws them, at the size's now — the models box's API spend line
// shows only for the month of now, so a footer measured at time 0 is a line
// short and render cuts the body's last line (the sprint grid's icon key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, handleKey, render } from '../../src/tui/app.js';
import { headerLines } from '../../src/tui/screens/frame.js';
import { clip } from '../../src/tui/text.js';
import * as sprint from '../../src/tui/screens/sprint.js';
import * as sprintFlow from '../../src/tui/screens/sprint-flow.js';
import * as backlog from '../../src/tui/screens/backlog.js';
import * as backlogFlow from '../../src/tui/screens/backlog-flow.js';
import * as control from '../../src/tui/screens/control.js';
import * as subflows from '../../src/tui/screens/subflows.js';
import * as mergeRequests from '../../src/tui/screens/merge-requests.js';
import * as repos from '../../src/tui/screens/repos.js';
import * as updates from '../../src/tui/screens/updates.js';
import * as agents from '../../src/tui/screens/agents.js';
import * as chat from '../../src/tui/screens/chat.js';
import * as memory from '../../src/tui/screens/memory.js';
import * as ticket from '../../src/tui/screens/ticket.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const now = new Date('2026-10-01T16:04:00Z');
const size = { columns: 200, rows: 55, now };
const hs = state => ({ state, 'state-engine': 'example-development' });
const item = (key, n) => ({ key, title: `Ticket ${n}`, priority: 2, points: 1, variations: [{ name: 'A', 'harness-status': hs('backlog') }] });
const features = Array.from({ length: 40 }, (_, i) => item(`ABC-${i + 1}`, i + 1));
const engine = { name: 'example-development', steps: [{ id: 'backlog', name: 'Backlog', sequence: 1 }, { id: 'code-review', name: 'Code Review', sequence: 13 }] };
// This month's API spend: the models box draws its line only at now, not at time 0.
const apiCost = { month: '2026-10', usd: 12.34, 'as-of': '2026-10-01T15:00:00Z', budget: null };
const project = {
  id: 'example', name: 'Example', stateEngine: 'example-development', environments: [], claudeUsage: null, apiCost,
  sprint: { number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs: [], spikes: [] },
  backlog: features.map(t => ({ ...t, key: t.key.replace('ABC', 'BL') })),
};
const base = initialState({ projects: [project], workflows: [engine], assignments: [], features: { 'chat-screen': true, 'ticket-chat-tab': true } });

const MODULES = { s: sprint, S: sprintFlow, b: backlog, B: backlogFlow, c: control, f: subflows, m: mergeRequests, r: repos, u: updates, a: agents, x: chat, h: memory, A: agents };
const screens = [
  ...Object.keys(MODULES).map(screen => [screen, { ...base, screen }, MODULES[screen]]),
  ['ticket', { ...base, screen: 's', ticket: { key: 'ABC-1', variation: 'A' } }, ticket],
  ['agent log', { ...base, screen: 'a', agent: { name: 'Ripley', start: null }, agentLog: [] }, agents],
  ['chat', { ...base, screen: 'x', chat: { id: 'c1' } }, chat],
];

test('ASS-295 AC2, AC3: with the API spend line showing, every screen\'s body is drawn whole above the footer — its last line on screen', () => {
  for (const [name, state, screen] of screens) {
    const out = render(state, size);
    const body = screen.view(state, size);
    const top = headerLines(state, size.columns, now).length;
    assert.ok(body.length, name);
    assert.deepEqual(out.slice(top, top + body.length).map(strip), body.map(l => strip(clip(l, size.columns))), name);
  }
});

test('ASS-295 AC2: the sprint screen shows the icon key under the grid in full with the API spend line showing', () => {
  const out = render(base, size).map(strip);
  assert.ok(out.some(l => /API \$12\.34 this month/.test(l)));
  assert.match(out.join('\n'), /▮ step {2}✦ feature .* paused/);
});

test('ASS-295 AC1: keys move the sprint grid\'s selection against the rows drawn at the size\'s now', () => {
  // Down from the top to the last row the grid shows: the selection stays on screen.
  let state = { ...base, focus: 'tickets' };
  for (let i = 0; i < 40; i++) state = handleKey(state, { name: 'down' }, size);
  const out = render(state, size);
  assert.ok(out.some(l => l.includes('\x1b[7m') && /ABC-40/.test(strip(l))));
  assert.match(out.map(strip).join('\n'), /▮ step {2}✦ feature .* paused/);
});
