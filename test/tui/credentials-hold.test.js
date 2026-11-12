// The dashboard's side of the credentials hold (ASS-395 AC3): while control
// holds a project for its credentials (credentials-hold.json, load.js
// credentialsHold), the sprint header shows a white-on-red "Project blocked by
// credentials", as "No work in progress" is shown; the project counts once in
// Operator Needed — one item, however many of its tickets the hold stops — in
// the tile, the project menu's dot and the notifications; and the control
// screen shows each problem with its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, handleKey, render } from '../../src/tui/app.js';
import { operatorNeeded, CREDENTIALS_ITEM } from '../../src/tui/screens/shared.js';
import { neededTickets } from '../../src/notify/detect.js';
import { fallback } from '../../src/notify/describe.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const wide = { columns: 220, rows: 50, now: new Date('2026-10-01T16:04:00Z') };
const hs = state => ({ state, 'state-engine': 'e' });
const steps = [
  { id: 'stuck', name: 'Stuck', sequence: 0, 'is-blocked-state': true },
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const ticket = (key, state) => ({ key, title: 'T', variations: [{ name: 'A', 'harness-status': hs(state) }] });
const sprintOf = features => ({ number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs: [], spikes: [] });
const HOLD = { since: '2026-10-01T15:00:00Z', problems: [
  { credential: 'keychain item "Example API Key" (anthropic)', problem: 'missing from the keychain', fix: 'security add-generic-password -U -s "Example API Key" -a "$USER" -T /usr/bin/security -w "$(pbpaste)"' },
  { credential: 'the glab login (gitlab.example.com)', problem: 'glab is not authenticated on gitlab.example.com', fix: 'glab auth login --hostname gitlab.example.com' },
] };
const FLAG = '\x1b[41;97m Project blocked by credentials \x1b[0m';

// The dashboard on project p (its sprint `features`, A-0 worked so no idle warning shows) and a second project, q.
function dashboard(features, credentialsHold = null) {
  const p = { id: 'p', name: 'P', stateEngine: 'e', sprint: sprintOf([ticket('A-0', 'build'), ...features]), backlog: [], questions: [], days: {}, credentialsHold };
  const q = { id: 'q', name: 'Q', stateEngine: 'e', sprint: sprintOf([]), backlog: [], questions: [], days: {} };
  return initialState({ projects: [p, q], workflows: [{ name: 'e', steps }], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] });
}
// The Operator Needed Tickets tile's value: the first boxed number, two lines above its label.
const tile = out => { const lines = out.map(strip), at = lines.findIndex(l => l.includes('Operator Needed Tickets')); return Number(lines[at - 2].match(/│ +(\d+) +│/)[1]); };

test('ASS-395 AC3: while held, the sprint header shows "Project blocked by credentials" in white on red, as "No work in progress" is shown; not without the hold', () => {
  const held = render(dashboard([], HOLD), wide);
  assert.ok(held.some(l => l.includes(FLAG)), held.map(strip).join('\n'));
  const box = held.findIndex(l => l.includes('day 14 of 14'));
  assert.match(strip(held[box + 1]), /sprint ends today +│ {5}Project blocked by credentials( |$)/);
  assert.ok(!render(dashboard([]), wide).some(l => strip(l).includes('Project blocked by credentials')));
});

test('ASS-395 AC3: the held project counts once in Operator Needed — one item, beside its tickets\' own — and its menu entry gets the dot', () => {
  const blocked = [ticket('A-1', 'stuck'), ticket('A-2', 'stuck')];
  assert.deepEqual([...operatorNeeded(dashboard(blocked, HOLD))].sort(), ['A-1', 'A-2', CREDENTIALS_ITEM]);
  assert.deepEqual([...operatorNeeded(dashboard(blocked))].sort(), ['A-1', 'A-2']);
  assert.deepEqual([...operatorNeeded(dashboard([], HOLD))], [CREDENTIALS_ITEM]);
  assert.equal(tile(render(dashboard([], HOLD), wide)), 1);
  assert.equal(tile(render(dashboard(blocked, HOLD), wide)), 3);
  assert.equal(tile(render(dashboard([]), wide)), 0);
  const menu = render(dashboard([], HOLD), wide).map(strip).find(l => l.includes(' P') && l.includes('Q'));
  assert.match(menu, /● .*P/);
});

test('ASS-395 AC3: Operator Needed notifications get one project item for the hold, its problems the reason', () => {
  const needed = neededTickets(dashboard([ticket('A-1', 'stuck')], HOLD));
  assert.deepEqual(needed.q, []);
  const item = needed.p.find(t => t.key === CREDENTIALS_ITEM);
  assert.deepEqual(item, { key: CREDENTIALS_ITEM, title: 'Project blocked by credentials', variation: null, step: null, project: true,
    reason: { credentials: `${HOLD.problems[0].credential}: ${HOLD.problems[0].problem} — fix: ${HOLD.problems[0].fix}; ${HOLD.problems[1].credential}: ${HOLD.problems[1].problem} — fix: ${HOLD.problems[1].fix}` } });
  assert.equal(needed.p.filter(t => t.key === CREDENTIALS_ITEM).length, 1);
  assert.match(fallback(item), /^Project blocked by credentials: keychain item "Example API Key" \(anthropic\): missing/);
});

test('ASS-395 AC3: the control screen shows the hold and each problem with its fix', () => {
  const out = render(handleKey(dashboard([], HOLD), { name: 'c' }), wide).map(strip);
  assert.ok(out.some(l => l.startsWith('Project blocked by credentials since 2026-10-01T15:00:00Z')), out.join('\n'));
  assert.ok(out.some(l => l === '  the glab login (gitlab.example.com): glab is not authenticated on gitlab.example.com — fix: glab auth login --hostname gitlab.example.com'), out.join('\n'));
  assert.ok(!render(handleKey(dashboard([]), { name: 'c' }), wide).map(strip).some(l => l.includes('Project blocked by credentials')));
});
