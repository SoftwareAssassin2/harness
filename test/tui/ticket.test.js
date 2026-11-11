// The ticket screen's time fields (HD-3): Total Agent Time, Total Time
// Planning and Total Time Executing, from a variation's state-changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentTime, tokenSpend, planningTime, executingTime, ticketLines, testCounts, quickLines, defaultTab, needsYou, tabBar, ticketTabs, TABS, tabsOf, PANEL, panelWidth, tabWidth, stripLines } from '../../src/tui/ticket.js';

const H = 3600e3;
const at = hours => new Date(Date.UTC(2026, 9, 12, 8) + hours * H).toISOString().replace('.000', '');
const STEPS = [
  { id: 'blocked', sequence: 0, area: 'quarantine' },
  { id: 'backlog', sequence: 1, 'is-planning-stage': true }, { id: 'committed', sequence: 2, 'is-planning-stage': true },
  { id: 'plan', sequence: 3, 'is-planning-stage': true },
  { id: 'build', sequence: 4 }, { id: 'test', sequence: 5 }, { id: 'done', sequence: 6, 'is-done': true },
];
const ran = (from, minutes) => ({ 'dispatched-to': 'Thor', timestamp: at(from), 'completed-timestamp': at(from + minutes / 60) });
const change = (from, to, hours, log = [], extra = {}) => ({ 'from-state': from, 'to-state': to, timestamp: at(hours), 'agent-dispatch-log': log, ...extra });
// Planned (blocked a while on the way), built, sent back into planning, built again, tested, done.
const shipped = { 'state-changes': [
  change('backlog', 'committed', 0),
  change('committed', 'plan', 1, [ran(1, 30)]),
  change('plan', 'blocked', 1.5),
  change('blocked', 'plan', 2, [ran(2, 15)]),
  change('plan', 'build', 3, [ran(3, 45)]),
  change('build', 'build', 3.5, [ran(3.5, 10)], { 'sub-state-change': { 'state-engine': 'x', 'from-state': 'a', 'to-state': 'b' } }),   // within build: not leaving it
  change('build', 'plan', 4),
  change('plan', 'build', 5),
  change('build', 'test', 6, [{ 'dispatched-to': 'Spock', timestamp: at(6) }]),   // still running: no time yet
  change('test', 'done', 8),
] };

// A move recorded without an agent-dispatch-log at all, and a variation that never moved: the
// per-state counts (ASS-101 AC3) must read 0 dispatches off both rather than throw.
const noLog = { 'state-changes': [{ 'from-state': 'plan', 'to-state': 'build', timestamp: at(0) }] };
const unmoved = { 'state-changes': [] };

test('Total Agent Time sums every finished dispatch on the variation, those within a step included; a running one adds nothing; none finished is none', () => {
  assert.equal(agentTime(shipped), (30 + 15 + 45 + 10) * 60e3);
  assert.equal(agentTime({ 'state-changes': [change('backlog', 'committed', 0, [{ 'dispatched-to': 'Spock', timestamp: at(0) }])] }), null);
  assert.equal(agentTime({}), null);
});

test('Total Time Planning runs from the move into its first planning step to the move out of its last, into a pipeline step (not quarantine); none while it has not left planning', () => {
  assert.equal(planningTime(shipped, STEPS), 5 * H);                    // 0h → its last way out, at 5h
  const planning = { 'state-changes': shipped['state-changes'].slice(0, 4) };   // blocked and back, still planning
  assert.equal(planningTime(planning, STEPS), null);
  assert.equal(planningTime({ 'state-changes': [] }, STEPS), null);
});

test('Total Time Executing runs from when it first left its first non-planning step to its move to done; none before it is done', () => {
  assert.equal(executingTime(shipped, STEPS), 4 * H);                   // out of build first at 4h, done at 8h
  assert.equal(executingTime({ 'state-changes': shipped['state-changes'].slice(0, -1) }, STEPS), null);   // not done yet
  assert.equal(executingTime({ 'state-changes': shipped['state-changes'].slice(0, 5) }, STEPS), null);    // never left build
});

test('Automated tests on the ticket screen is x/y passing with both counts and — without them (ASS-45)', () => {
  const screen = tests => ticketLines({ key: 'ABC-1', title: 'T', variation: { 'local-testing': tests } }, { status: 'Build', stepName: id => id, prompted: () => false, agents: [], columns: 80 });
  const line = tests => screen(tests).details.find(l => l.startsWith('Automated tests'));
  assert.match(line({ 'number-of-relevant-automated-tests': 83, 'number-of-passing-relevant-automated-tests': 37 }), /^Automated tests +37\/83 passing$/);
  for (const tests of [undefined, {}, { 'is-approved': true, summary: 'ok', timestamp: '2026-10-14T10:00:00Z' }, { 'number-of-relevant-automated-tests': 83 }]) {
    assert.match(line(tests), /^Automated tests +—$/, JSON.stringify(tests));
  }
  assert.deepEqual(testCounts({ 'number-of-relevant-automated-tests': 2, 'number-of-passing-relevant-automated-tests': 0 }), [0, 2]);
  assert.equal(testCounts({ 'number-of-relevant-automated-tests': '83', 'number-of-passing-relevant-automated-tests': '37' }), null);
});

// The four-column ticket screen (ASS-101): new pure helpers alongside ticketLines.

test('ASS-101 AC3: stateCounts returns per-state { visits, dispatches } — visits by to-state, dispatches by from-state', async () => {
  const { stateCounts } = await import('../../src/tui/ticket.js');
  const counts = stateCounts(shipped, STEPS);
  assert.equal(counts.build?.visits, 2);                              // plan→build at 3h and at 5h
  assert.equal(counts['test']?.visits, 1);                            // build→test at 6h
  assert.equal(counts.plan?.visits, 3);                               // committed→plan, blocked→plan and build→plan
  assert.ok((counts.build?.dispatches ?? 0) >= 2);                    // sent from build: the one within it, and the unfinished Spock one
  assert.deepEqual(counts.done, { visits: 1, dispatches: 0 });        // ends there; nothing dispatched from done
});

test('ASS-101 AC3: sub-dispatches roll into the top-level from-state, not the sub-state', async () => {
  const { stateCounts } = await import('../../src/tui/ticket.js');
  const v = { 'state-changes': [
    change('backlog', 'plan', 0),
    { 'state-engine': 'e', 'from-state': 'plan', 'to-state': 'build', timestamp: at(1), 'agent-dispatch-log': [],
      'sub-state-change': { 'state-engine': 's', 'from-state': 'a', 'to-state': 'b', 'agent-dispatch-log': [ran(1, 5)] } },
  ] };
  const counts = stateCounts(v, STEPS);
  assert.equal(counts.plan?.dispatches, 1);                           // the sub-dispatch counts for its top-level from-state
  assert.equal(counts.a?.dispatches ?? 0, 0);                         // not for the sub-state
});

test('ASS-101 AC3: a never-visited state and one whose change has no agent-dispatch-log both read 0 — no throw', async () => {
  const { stateCounts } = await import('../../src/tui/ticket.js');
  const empty = stateCounts(unmoved, STEPS);
  for (const s of STEPS) assert.deepEqual(empty[s.id], { visits: 0, dispatches: 0 }, s.id);
  assert.equal(stateCounts(noLog, STEPS).plan.dispatches, 0);         // from-state plan, no agent-dispatch-log at all
});

test('ASS-101 AC5/AC6: ticketLines returns { details, history } with the state history split out', () => {
  const t = { icon: '✨', key: 'ABC-1', title: 'T', variation: { 'local-testing': {}, 'state-changes': [
    { 'from-state': 'backlog', 'to-state': 'done', timestamp: '2026-10-01T10:00:00Z', 'agent-dispatch-log': [] },
  ] } };
  const out = ticketLines(t, { status: 'Done', stepName: id => id, prompted: () => false, agents: [], columns: 80, steps: [] });
  assert.ok(out && typeof out === 'object' && !Array.isArray(out), 'is a shape with named sections, not a flat array');
  assert.ok(Array.isArray(out.details) && Array.isArray(out.history), 'has details and history arrays');
  assert.ok(out.details.some(l => l.startsWith('Ticket number')), 'details has the Ticket number row');
  assert.ok(!out.details.some(l => l.startsWith('History')), 'details has no History heading');
  assert.ok(!out.details.some(l => l.includes('  →  ')), 'details has no history → row');
  assert.ok(out.history.some(l => l.includes('  →  ')), 'history has its → row');
});

// ASS-64: a History entry wider than the details box wraps under its first row, never cut with …
const thor = { 'dispatched-to': 'Thor', timestamp: at(0), 'completed-timestamp': at(0.5), 'cost-usd': 0.61 };
const moves = [change('plan', 'build', 0, [thor]), change('build', 'done', 2)];
const historyOf = (columns, prompted = id => id === 'build', changes = moves, stepName = id => id) =>
  ticketLines({ icon: '✨', key: 'ABC-1', title: 'T', variation: { 'local-testing': {}, 'state-changes': changes } },
    { status: 'Done', stepName, prompted, agents: [], columns, steps: [] }).history;
const INDENT = ' '.repeat(16);
const SIDE = '  │          │  ';

// ASS-268: a dispatch whose cost is usage.json's estimate (an agent killed or dying mid-turn) shows it with a ~, and counts in the spend as any other.
test('ASS-268 AC3: an estimated dispatch cost shows as ~$x.xx in the History and counts in the variation\'s token spend', () => {
  const estimated = { ...thor, 'cost-usd': 20.48, 'cost-estimated': true };
  assert.equal(historyOf(90, () => false, [change('plan', 'build', 0, [estimated]), change('build', 'done', 2)])[1], `${INDENT}2026-10-12 08:00 UTC  plan   →   build 🤖 Thor ~$20.48`);
  assert.equal(tokenSpend({ 'state-changes': [change('plan', 'build', 0, [estimated, thor])] }), '$21.09');
});

test('ASS-64 AC1: a History entry that fits is drawn exactly as before — its multi-space separators kept', () => {
  assert.deepEqual(historyOf(90), [
    '', `${INDENT}2026-10-12 08:00 UTC  plan   →   build 🤖 Thor $0.61`, '', '',
    '        ↓',
    '  ┌──────────┐',
    '  │███░░░░░░░│  2026-10-12 10:00 UTC  build (2h 0m) 🤖 Thor (30m 0s) $0.61   →   done',
    '  └──────────┘',
    '    75% idle',
  ]);
});

test('ASS-64 AC1/AC2/AC3: an entry too wide for its bar\'s row wraps between the bar\'s text row and its bottom border, side borders beside it, the → starting its own row', () => {
  const out = historyOf(60);   // 44 columns of text beside the bar
  assert.deepEqual(out.slice(out.indexOf('        ↓') + 1), [
    '  ┌──────────┐',
    '  │███░░░░░░░│  2026-10-12 10:00 UTC  build (2h 0m)',
    `${SIDE}🤖 Thor (30m 0s) $0.61`,
    `${SIDE}→   done`,
    '  └──────────┘',
    '    75% idle',
  ]);
  assert.ok(!out.some(l => l.includes('…')));
});

test('ASS-64 AC3: an entry without a bar wraps onto rows at the same column, its two blank rows kept after them', () => {
  const out = historyOf(60, () => false);
  assert.deepEqual(out.slice(out.indexOf('        ↓') + 1), [
    '', `${INDENT}2026-10-12 10:00 UTC  build (2h 0m)`, `${INDENT}🤖 Thor (30m 0s) $0.61`, `${INDENT}→   done`, '', '',
  ]);
});

test('ASS-64 AC2: an entry that does not fit breaks before → even when the → would fit on the first row', () => {
  // "2026-10-12 08:00 UTC  plan   →   build 🤖 Thor $0.61" is 48 columns, 4 too many.
  assert.deepEqual(historyOf(60).slice(0, 4), ['', `${INDENT}2026-10-12 08:00 UTC  plan`, `${INDENT}→   build 🤖 Thor $0.61`, '']);
});

test('ASS-64 AC1/AC5: a piece wider than its row wraps by words — no row past the width, no emoji split; a narrow box floors the width at 20 and does not throw', async () => {
  const { visible } = await import('../../src/tui/text.js');
  const long = { ...thor, 'dispatched-to': 'Captain-Marvel-Of-The-Kree' };
  const out = historyOf(36, () => false, [change('plan', 'build', 0, [long]), change('build', 'done', 2)], id => (id === 'build' ? 'Building the whole thing' : id));
  const rows = out.filter(l => l.startsWith(INDENT)).map(l => l.slice(16));
  assert.ok(rows.every(r => visible(r) <= 20 || !r.includes(' ')), rows.join('\n'));   // only a lone word may run past
  assert.ok(rows.every(r => !/[\ud800-\udbff]$|^[\udc00-\udfff]/.test(r)), 'no emoji split');
  assert.ok(rows.some(r => r.startsWith('→   ')), 'the → starts a row');
  assert.ok(rows.join(' ').includes('🤖 Captain-Marvel-Of-The-Kree'));
  assert.doesNotThrow(() => historyOf(4));
  assert.ok(historyOf(4).filter(l => l.startsWith(INDENT)).every(l => visible(l) - 16 <= 20 || !l.trim().includes(' ')));
});

test('ASS-145 AC1: ticketLines gives each History entry\'s first row, whatever its height — the row after the ↓ between them', () => {
  const changes = [...moves, change('done', 'build', 3)];
  const { history, starts } = ticketLines({ icon: '✨', key: 'ABC-1', title: 'T', variation: { 'local-testing': {}, 'state-changes': changes } },
    { status: 'Done', stepName: id => id, prompted: id => id === 'build', agents: [], columns: 60, steps: [] });
  // A wrapped entry without a bar (5 rows), a wrapped barred one (6 rows), a wrapped one without a bar (5 rows: its time says UTC, ASS-294).
  assert.deepEqual(starts, [0, 6, 13]);
  assert.deepEqual(starts.map(at => history[at - 1]), [undefined, '        ↓', '        ↓']);
  assert.equal(history.length, 18);
});

test('ASS-145: a ticket with no history has no entry starts', () => {
  assert.deepEqual(ticketLines({ icon: '✨', key: 'ABC-1', title: 'T', variation: { 'local-testing': {}, 'state-changes': [] } },
    { status: 'Done', stepName: id => id, prompted: () => false, agents: [], columns: 60, steps: [] }).starts, []);
});

test('ASS-78 AC2, ASS-184 AC1: a pending requirements change is drawn by pendingChange — when it was detected, the current description and the new side by side, each wrapped to its column — and no longer in the details', async () => {
  const { visible } = await import('../../src/tui/text.js');
  const { pendingChange } = await import('../../src/tui/ticket.js');
  const t = { icon: '✨', key: 'ABC-1', title: 'T', description: 'Keep the old login form exactly as it is today',
    'pending-requirements-change': { description: 'Replace the login form with single sign on\nand drop passwords', 'detected-at': '2026-10-25T12:00:00Z', 'paused-variations': ['A'] },
    variation: { 'local-testing': {} } };
  const section = pendingChange(t, 60);
  assert.match(section[0], /detected 2026-10-25 12:00 UTC/);
  assert.match(section[1], /^ {2}Current +│ New$/);
  const rows = section.slice(2).map(l => l.slice(2).split(' │ ').map(s => s.trim()));
  assert.equal(rows.map(r => r[0]).filter(Boolean).join(' '), 'Keep the old login form exactly as it is today');
  assert.equal(rows.map(r => r[1]).filter(Boolean).join(' '), 'Replace the login form with single sign on and drop passwords');
  assert.equal(rows.find(r => r[1].startsWith('and'))[1], 'and drop passwords', 'a line break in a description is kept');
  assert.ok(section.every(l => visible(l) <= 60), 'fits the column');
  const { details } = ticketLines(t, { status: 'Build', stepName: id => id, prompted: () => false, agents: [], columns: 60 });
  assert.ok(!details.includes('Pending requirements change'), 'the Actions tab shows it, beside its Keep current / Take new');
});

// ASS-42: one History renderer for a backlog variation's refinement history and a sprint variation's development history.
test('ASS-42 AC3: a History entry shows its cause when it has one, a rejection\'s reason with it; one without shows none', () => {
  const reset = { ...change('ready', 'groom', 1), cause: 'requirements-changed' };
  const rejected = { ...change('awaiting-approval', 'groom', 2), cause: 'operator', reason: 'AC3 is vague' };
  const out = historyOf(120, () => false, [change('groom', 'awaiting-approval', 0), reset, rejected], id => ({ groom: 'Groom', ready: 'Ready', 'awaiting-approval': 'Awaiting Approval' }[id]));
  const rows = out.filter(l => l.startsWith(INDENT)).map(l => l.slice(16));
  assert.deepEqual(rows, [
    '2026-10-12 08:00 UTC  Groom   →   Awaiting Approval',
    '2026-10-12 09:00 UTC  Ready (1h 0m)   →   Groom   (requirements-changed)',
    '2026-10-12 10:00 UTC  Awaiting Approval (1h 0m)   →   Groom   (operator: AC3 is vague)',
  ]);
});

test('ASS-42 AC4: given its refinement history, History lists it first, then the development history, each part under its engine — the starts each entry\'s first row', () => {
  const names = { groom: 'Groom', ready: 'Ready', plan: 'Plan', build: 'Build' };
  const t = { icon: '✨', key: 'ABC-1', title: 'T', variation: { 'local-testing': {}, 'harness-status': { state: 'build', 'state-engine': 'harness-development' },
    'state-changes': [{ ...change('backlog', 'plan', 3), 'state-engine': 'harness-development' }, { ...change('plan', 'build', 4), 'state-engine': 'harness-development' }] } };
  const refinement = { engine: 'harness-backlog-refinement', changes: [{ ...change('groom', 'ready', 0), cause: 'operator' }], stepName: id => names[id] };
  const { history, starts } = ticketLines(t, { status: 'Build', stepName: id => names[id] ?? id, prompted: () => false, agents: [], columns: 100, steps: [], refinement });
  const text = history.map(l => l.trim()).filter(Boolean);
  assert.deepEqual(text, [
    'harness-backlog-refinement',
    '2026-10-12 08:00 UTC  Groom   →   Ready   (operator)',
    'harness-development',
    '2026-10-12 11:00 UTC  backlog   →   Plan',
    '↓',
    '2026-10-12 12:00 UTC  Plan (1h 0m)   →   Build',
  ]);
  assert.deepEqual(starts.map(at => history[at + 1].trim().slice(0, 16)), ['2026-10-12 08:00', '2026-10-12 11:00', '2026-10-12 12:00']);
});

test('ASS-42 AC4: with no refinement history, History is the development history alone, unlabelled, as before', () => {
  const plain = historyOf(90);
  assert.deepEqual(ticketLines({ icon: '✨', key: 'ABC-1', title: 'T', variation: { 'local-testing': {}, 'state-changes': moves } },
    { status: 'Done', stepName: id => id, prompted: id => id === 'build', agents: [], columns: 90, steps: [], refinement: { engine: 'e', changes: [], stepName: id => id } }).history, plain);
});

test('ASS-83 AC3, AC4: a fast-tracked ticket\'s screen marks its key ⚡; a variation pre-empted for one says why it is paused; another\'s pause just that it is', () => {
  const lines = (ticket, v = {}) => ticketLines({ icon: '🐞', key: 'ASS-160', title: 'T', ...ticket, variation: { 'local-testing': {}, 'state-changes': [], ...v } }, { status: 'Build', stepName: id => id, prompted: () => false, agents: [], columns: 100, steps: [] }).details;
  assert.ok(lines({ 'fast-track': true }).some(l => l.startsWith('Ticket number') && l.includes('🐞 ⚡ ASS-160')));
  assert.ok(!lines({}).some(l => l.includes('⚡')));
  assert.ok(lines({}, { 'is-paused': true, 'paused-for-fast-track': 'ASS-160' }).some(l => /^Paused +to free a seat for fast-tracked ASS-160$/.test(l)));
  assert.ok(lines({}, { 'is-paused': true }).some(l => /^Paused +yes$/.test(l)));
  assert.ok(!lines({}).some(l => l.startsWith('Paused')));
});

test('ASS-147 AC3: a ticket\'s History shows a dispatch\'s memory use beside it — 🧠 recalls↓returned ↑saves, ✗deletes when any — and nothing when all are zero or uncounted', () => {
  const used = (memory, name) => ({ ...ran(1, 30), 'dispatched-to': name, memory });
  const history = ticketLines({ key: 'ABC-1', title: 'T', variation: { 'state-changes': [
    change('backlog', 'plan', 0),
    change('plan', 'build', 1, [used({ recalls: 3, returned: 4, saves: 1, deletes: 0 }, 'Thor'), used({ recalls: 0, returned: 0, saves: 0, deletes: 0 }, 'Loki'), used(undefined, 'Odin')]),
    change('build', 'test', 2, [used({ recalls: 0, returned: 0, saves: 2, deletes: 1 }, 'Hela')]),
  ] } }, { status: 'Test', stepName: id => id, prompted: () => false, agents: [], columns: 200 }).history.join('\n');
  assert.match(history, /→ {3}build 🤖 Thor 🧠 3↓4 ↑1 {2}🤖 Loki {2}🤖 Odin\n/);              // arriving
  assert.match(history, /build \(1h 0m\) 🤖 Thor \(30m 0s\) 🧠 3↓4 ↑1 {2}🤖 Loki \(30m 0s\) {2}🤖 Odin \(30m 0s\) /);   // leaving
  assert.match(history, /🤖 Hela 🧠 0↓0 ↑2 ✗1/);
});

test('ASS-166 AC3: a ticket worked by hand has its screen mark its key ✋ and say who has worked it since when, with the note', () => {
  const lines = ticket => ticketLines({ icon: '🐞', key: 'ASS-166', title: 'T', ...ticket, variation: { 'local-testing': {}, 'state-changes': [] } }, { status: 'Build', stepName: id => id, prompted: () => false, agents: [], columns: 120, steps: [] }).details;
  const hand = lines({ 'worked-manually': { by: 'alice', since: '2026-10-27T10:05:00Z', note: 'in the coordinator' } });
  assert.ok(hand.some(l => l.startsWith('Ticket number') && l.includes('🐞 ✋ ASS-166')));
  assert.ok(hand.some(l => /^By hand +worked by hand by alice since 2026-10-27 10:05 UTC: in the coordinator$/.test(l)), hand.join('\n'));
  assert.ok(!lines({}).some(l => l.includes('✋') || l.startsWith('By hand')));
});

// ASS-184: the ticket screen's tabs and its quick-details panel.
const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const NOW = new Date('2026-10-27T12:00:00Z');
const quick = (ticket = {}, v = {}, extra = {}) => quickLines({
  icon: '✨', key: 'ASS-171', url: 'http://t/ASS-171', title: 'Operator-needed tiles on the sprint header', priority: 3, points: 2,
  'ticket-system-status': 'In Progress', 'ticket-system-assignment': 'alice', ...ticket,
  variation: { name: 'A', 'ai-feedback-long': 'On track; review ready.\nThe rest of the story.', build: { branch: 'change/ASS-171', 'branch-url': 'http://b/ASS-171' },
    'local-testing': { 'number-of-passing-relevant-automated-tests': 41, 'number-of-relevant-automated-tests': 41 },
    'merge-request': [{ key: '!412', url: 'http://mr/412', status: 'Open', 'build-status': 'Passed' }],
    'state-changes': [{ 'from-state': 'build', 'to-state': 'human-review', timestamp: '2026-10-27T09:46:00Z',
      'agent-dispatch-log': [{ 'dispatched-to': 'Teal', timestamp: '2026-10-27T08:00:00Z', 'completed-timestamp': '2026-10-27T09:36:00Z', 'cost-usd': 4.12 }] }],
    ...v },
}, { status: 'Human Review (1, 1)', agents: [], needs: null, now: NOW, ...extra });

test('ASS-184 AC2: the panel shows, in order, key and variation, title, state with since and how long, agents, priority · points, Jira status · assignee, MRs, tests, Health\'s first line, spend · agent time, branch', () => {
  const out = quick().map(strip);
  assert.deepEqual(out, [
    '✨ ASS-171 · A',
    'Operator-needed tiles on the sprint',
    'header',
    '',
    'State: Human Review (1, 1)',
    '  since 10-27 09:46 UTC (2h 14m)',
    'Agents: —',
    '',
    'Priority 3 · Points 2',
    'Jira: In Progress · alice',
    '',
    'MRs: !412 Open Passed',
    'Tests: 41/41 passing',
    'Health: On track; review ready.',
    '',
    'Spend $4.12 · Agent time 1h 36m',
    'Branch: change/ASS-171',
  ]);
  assert.ok(quick()[0].includes('http://t/ASS-171') && quick().at(-1).includes('http://b/ASS-171'), 'key and branch linked');
});

test('ASS-184 AC2: Needs you, in red, after the title when something does; Paused and By hand only when they apply; agents named', () => {
  const out = quick({ 'fast-track': true, 'worked-manually': { by: 'alice', since: '2026-10-27T10:05:00Z' } }, { 'is-paused': true, 'paused-for-fast-track': 'ASS-160' },
    { needs: 'Human Review — tab 1', agents: ['Teal', 'Orange'] });
  const plain = out.map(strip);
  assert.equal(plain[0], '✨ ⚡ ✋ ASS-171 · A');
  assert.equal(plain[4], 'Needs you: Human Review — tab 1');
  assert.match(out[4], /\x1b\[31m/);
  assert.deepEqual(plain.slice(5, 10), ['State: Human Review (1, 1)', '  since 10-27 09:46 UTC (2h 14m)', 'Paused: for fast-track ASS-160', 'By hand: alice since 10-27 10:05 UTC', 'Agents: 🤖 Teal, 🤖 Orange']);
  assert.ok(quick({}, { 'is-paused': true }).map(strip).includes('Paused: yes'));
});

test('ASS-184 AC2: the title takes at most two lines; a manual priority shows with 🪪; three MRs then "+n more"; a variation among several says "of n"; nothing wider than the panel', async () => {
  const { visible } = await import('../../src/tui/text.js');
  const mrs = Array.from({ length: 5 }, (_, i) => ({ key: `!${i + 1}`, url: `http://mr/${i + 1}`, status: 'Open', 'build-status': 'Running' }));
  const out = quick({ title: 'A very long title that goes on and on well past what two lines of the panel can hold', 'manual-priority': 1, variations: [{ name: 'A' }, { name: 'B' }] },
    { 'merge-request': mrs }).map(strip);
  assert.equal(out[0], '✨ ASS-171 · A of 2');
  assert.match(out[2], /…$/);
  assert.equal(out[3], '');
  assert.ok(out.includes('Priority 1 🪪 · Points 2'));
  const at = out.findIndex(l => l.startsWith('MRs:'));
  assert.deepEqual(out.slice(at, at + 4), ['MRs: !1 Open Running', '     !2 Open Running', '     !3 Open Running', '     +2 more — tab 2']);
  assert.ok(out.every(l => visible(l) <= PANEL - 4), out.join('\n'));
  const bare = quickLines({ icon: '✨', key: 'ABC-1', variation: {} }, { status: 'Backlog', agents: [], now: NOW }).map(strip);
  assert.deepEqual(bare.filter(l => /^(MRs|Tests|Health|Branch):/.test(l) || l.startsWith('Spend')), ['MRs: —', 'Tests: —', 'Health: —', 'Spend — · Agent time —', 'Branch: —']);
});

// ASS-359 AC5: Await Sequential Merge (a step of Build's
// grouped-build run) records what a dependency needs as the variation's
// ai-feedback, which no move within the run clears: the panel's Health shows
// it while the step waits, the Health field the whole of it.
test('ASS-359 AC5: while the ticket waits at Build\'s Await Sequential Merge, the panel\'s Health and the details\' Health show the dependency feedback', () => {
  const long = 'acme/api !12 https://gitlab.example.com/acme/api/-/merge_requests/12: is a draft; its pipeline failed (lint); it needs 1 approval. MR 2 depends on it.';
  const waiting = { 'harness-status': { state: 'build', 'state-engine': 'example-development-grouped', 'sub-status': { state: 'await-dependencies', 'state-engine': 'grouped-build' } },
    'ai-feedback-short': 'Waiting on acme/api !12: is a draft, its pipeline failed (lint), it needs 1 approval', 'ai-feedback-long': long };
  const panel = quick({}, waiting, { status: 'Build › Await Sequential Merge' }).map(strip);
  assert.ok(panel.some(l => l.startsWith('Health: acme/api !12')), panel.join('\n'));
  const details = ticketLines({ key: 'ABC-1', title: 'T', variation: waiting }, { status: 'Build', stepName: id => id, prompted: () => false, agents: [], columns: 400 }).details.map(strip);
  assert.ok(details.some(l => /^Health +acme\/api !12 .*it needs 1 approval\. MR 2 depends on it\.$/.test(l)), details.join('\n'));
});

test('ASS-184 AC4: the screen opens on Actions when a gate waits, else Questions when one is open, else Chat; Needs you says the same', () => {
  const approve = [{ decision: 'Approve', leadsTo: 'Done' }];
  const gate = { step: { name: 'Human Review', action: { type: 'human' } }, choices: approve };
  assert.equal(defaultTab(gate, 2), 'actions');
  assert.equal(defaultTab(null, 2), 'questions');
  assert.equal(defaultTab(null, 0), 'chat');
  assert.equal(needsYou(gate, 2), 'Human Review — tab 1');
  assert.equal(needsYou({ step: { name: 'Build' }, choices: approve }, 0), 'Approve leaving Build — tab 1');
  assert.equal(needsYou({ title: 'Pending requirements change', step: { name: 'Build' }, choices: approve }, 0), 'Requirements changed — tab 1');
  assert.equal(needsYou(null, 1), '1 open question — tab 4');
  assert.equal(needsYou(null, 2), '2 open questions — tab 4');
  assert.equal(needsYou(null, 0), null);
});

test('a gate with nothing to choose (Awaiting Answers: its exit is no open questions) sends the operator to Questions, not Actions', () => {
  const gate = { step: { name: 'Awaiting Answers', action: { type: 'human' } }, choices: [] };
  assert.equal(defaultTab(gate, 1), 'questions');
  assert.equal(needsYou(gate, 1), '1 open question — tab 4');
  assert.equal(defaultTab(gate, 0), 'chat');
  assert.equal(needsYou(gate, 0), null);
});

test('ASS-262 AC4: without the Chat tab, four tabs numbered 1–4, the screen opening on Details where it would have on Chat', () => {
  const approve = [{ decision: 'Approve', leadsTo: 'Done' }];
  const gate = { step: { name: 'Human Review', action: { type: 'human' } }, choices: approve };
  assert.deepEqual(tabsOf(false).map(([id]) => id), ['actions', 'details', 'history', 'questions']);
  assert.equal(tabsOf(true), TABS);
  assert.deepEqual([defaultTab(gate, 2, false), defaultTab(null, 2, false), defaultTab(null, 0, false)], ['actions', 'questions', 'details']);
  assert.match(strip(tabBar('details', 100, {}, tabsOf(false))), /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions ─+$/);
  const out = ticketTabs({ tab: 'details', panes: [{ lines: ['detail one'] }], panel: ['key'], columns: 120, height: 3, tabs: tabsOf(false) });
  assert.match(strip(out[0]), /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions ─+┬ Ticket ─+┐$/);
});

test('ASS-184 AC1/AC4: five tabs in order, numbered; the active one alone in reverse video', () => {
  assert.deepEqual(TABS.map(([id]) => id), ['actions', 'details', 'history', 'questions', 'chat']);
  const bar = tabBar('history', 100);
  assert.match(strip(bar), /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions │ 5 Chat ─+$/);
  assert.equal(strip(bar).length, 100);
  assert.deepEqual([...bar.matchAll(/\x1b\[7m([^\x1b]*)\x1b\[0m/g)].map(m => m[1]), [' 3 History ']);
});

test('ASS-184 AC1/AC2: the tabbed box — the tab bar over the active tab\'s panes, the panel 40 wide at the right, every row the screen\'s width', async () => {
  const { visible } = await import('../../src/tui/text.js');
  const out = ticketTabs({ tab: 'details', panes: [{ lines: ['detail one', 'detail two'] }], panel: ['✨ ABC-1'], columns: 120, height: 5 });
  assert.equal(out.length, 7);
  assert.ok(out.every(l => visible(l) === 120), out.map(visible).join(','));
  assert.match(strip(out[0]), /^┌ 1 Actions .*─┬ Ticket ─+┐$/);
  assert.equal(strip(out[0]).indexOf('┬'), 120 - PANEL);
  assert.match(strip(out[1]), /^│ detail one +│ ✨ ABC-1 +│$/);
  assert.match(strip(out.at(-1)), /^└─+┴─+┘$/);
  const two = ticketTabs({ tab: 'history', panes: [{ lines: ['States'], width: 28 }, { lines: ['entry'] }], panel: [], columns: 120, height: 3 });
  assert.match(strip(two[1]), /^│ States +│ entry +│ +│$/);
  assert.equal(strip(two[1]).indexOf('│ entry'), 27);
  const short = ticketTabs({ tab: 'chat', panes: [{ lines: [] }], panel: ['key', '', 'State', '', 'Spend', 'Branch'], columns: 120, height: 4 });
  assert.deepEqual(short.slice(1, -1).map(l => strip(l).slice(120 - PANEL + 2, -2).trim()), ['key', 'State', 'Spend', 'Branch'], 'too short for its blank lines: they go first');
});

// ===== ASS-185: narrow terminals, tab badges, the full description =====

test('ASS-185 AC1: the panel is 40 wide from 120 columns up, 28 from 100 to 119, and none below 100 — the tabs take the rest, or the whole width', () => {
  assert.deepEqual([200, 120, 119, 100, 99, 60].map(panelWidth), [40, 40, 28, 28, 0, 0]);
  assert.deepEqual([200, 120, 119, 100, 99, 60].map(tabWidth), [161, 81, 92, 73, 99, 60]);
});

test('ASS-185 AC1: below 100 columns the panel is a 3-line strip above the tabs, which span the whole width', async () => {
  const { visible } = await import('../../src/tui/text.js');
  const out = ticketTabs({ tab: 'details', panes: [{ lines: ['detail one'] }], panel: ['one', 'two', 'three'], columns: 96, height: 4 });
  assert.equal(out.length, 3 + 6);
  assert.deepEqual(out.slice(0, 3).map(strip), ['one', 'two', 'three']);
  assert.match(strip(out[3]), /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions │ 5 Chat ─+┐$/);
  assert.match(strip(out[4]), /^│ detail one +│$/);
  assert.match(strip(out.at(-1)), /^└─+┘$/);
  assert.ok(out.slice(3).every(l => visible(l) === 96), out.map(visible).join(','));
  const mid = ticketTabs({ tab: 'details', panes: [{ lines: [] }], panel: ['key'], columns: 110, height: 3 });
  assert.equal(strip(mid[0]).indexOf('┬'), 110 - 28);
  assert.ok(mid.every(l => visible(l) === 110));
});

test('ASS-185 AC1: the strip — key · variation · title; state · Needs you; priority · agents · tests · spend — each line cut to the width', async () => {
  const { visible } = await import('../../src/tui/text.js');
  const t = { icon: '✨', key: 'ASS-171', url: 'http://t/ASS-171', title: 'Operator-needed tiles', priority: 3, 'manual-priority': 1,
    variation: { name: 'A', 'local-testing': { 'number-of-passing-relevant-automated-tests': 4, 'number-of-relevant-automated-tests': 5 },
      'state-changes': [{ 'from-state': 'a', 'to-state': 'b', timestamp: '2026-10-27T09:00:00Z', 'agent-dispatch-log': [{ 'dispatched-to': 'Teal', timestamp: '2026-10-27T08:00:00Z', 'cost-usd': 4.12 }] }] } };
  const out = stripLines(t, { status: 'Build', agents: ['Teal'], needs: 'Human Review — tab 1', width: 96 });
  assert.deepEqual(out.map(strip), [
    '✨ ASS-171 · A · Operator-needed tiles',
    'State: Build · Needs you: Human Review — tab 1',
    'Priority 1 🪪 · Agents: 🤖 Teal · Tests: 4/5 passing · Spend $4.12',
  ]);
  assert.match(out[1], /\x1b\[31mNeeds you/);
  const bare = stripLines({ icon: '✨', key: 'ABC-1', variation: {} }, { status: 'Backlog', agents: [], needs: null, width: 60 }).map(strip);
  assert.deepEqual(bare, ['✨ ABC-1 · —', 'State: Backlog', 'Priority — · Agents: — · Tests: — · Spend —']);
  assert.ok(stripLines({ ...t, title: 'x'.repeat(200) }, { status: 'Build', agents: [], width: 50 }).every(l => visible(l) <= 50));
});

test('ASS-185 AC2: Actions shows a red ● while a gate waits, Questions its open count and a red ●; labels stay whole, active or not', () => {
  const bar = tabBar('details', 100, { gate: true, open: 2 });
  assert.match(strip(bar), /^┌ 1 Actions ● │ 2 Details │ 3 History │ 4 Questions \(2\) ● │ 5 Chat ─+$/);
  assert.match(bar, /Questions \(2\) \x1b\[31m●/);
  assert.equal(strip(bar).length, 100);
  assert.match(bar, /\x1b\[31m●/);
  assert.match(strip(tabBar('actions', 100, { gate: true, open: 0 })), /^┌ 1 Actions ● │ 2 Details │ 3 History │ 4 Questions │ 5 Chat/);
  assert.match(tabBar('actions', 100, { gate: true }), /^┌\x1b\[7m 1 Actions \x1b\[31m●\x1b\[39m \x1b\[0m/, 'the ● keeps the reverse video');
  assert.match(strip(tabBar('chat', 100, { gate: false, open: 0 })), /^┌ 1 Actions │ 2 Details │ 3 History │ 4 Questions │ 5 Chat ─+$/);
});

// ASS-196: an overlap is stored once — on the ticket whose Find Dependencies
// run found it — and shown on both tickets by a reverse lookup, overlapsOf;
// ticketLines renders an Overlaps field right after Dependencies.
test('ASS-196 AC3: overlapsOf is own overlaps ∪ the keys of other tickets whose overlaps name this one, case-insensitive, own-first, deduped; ticketLines shows Overlaps right after Dependencies, empty → NONE', async () => {
  const { overlapsOf } = await import('../../src/tui/ticket.js');
  const A = { key: 'A', overlaps: ['B'] };
  const B = { key: 'B', overlaps: [] };
  // Stored once on A; shown on both sides by lookup.
  assert.deepEqual(overlapsOf(A, [A, B]), ['B']);
  assert.deepEqual(overlapsOf(B, [A, B]), ['A']);
  // Case-insensitive match, own first then the reverse ones, deduped.
  const C = { key: 'c', overlaps: ['A'] };
  const D = { key: 'D', overlaps: ['C', 'c'] };
  assert.deepEqual(overlapsOf(C, [A, C, D]), ['A', 'D']);
  assert.deepEqual(overlapsOf({ key: 'E' }, [A, B]), []);                 // no overlaps field, none name it → []

  const details = (t, overlaps) => ticketLines({ icon: '✨', title: 'T', ...t, variation: { 'local-testing': {}, 'state-changes': [] } },
    { status: 'Build', stepName: id => id, prompted: () => false, agents: [], columns: 100, steps: [], overlaps }).details;
  const shown = details({ key: 'A', dependencies: ['X'] }, ['B']);
  const depAt = shown.findIndex(l => l.startsWith('Dependencies'));
  const ovAt = shown.findIndex(l => l.startsWith('Overlaps'));
  assert.ok(depAt >= 0 && ovAt === depAt + 1, shown.join('\n'));          // right after Dependencies
  assert.match(shown[ovAt], /^Overlaps +B$/);
  assert.match(details({ key: 'A' }, []).find(l => l.startsWith('Overlaps')), /^Overlaps +—$/);   // empty → NONE
});

test('ASS-185 AC4: Details shows the whole description, however long', () => {
  const description = `${'word '.repeat(120)}the end`;
  const { details } = ticketLines({ icon: '✨', key: 'ABC-1', title: 'T', description, variation: { 'local-testing': {}, 'state-changes': [] } },
    { status: 'Build', stepName: id => id, prompted: () => false, agents: [], columns: 120, steps: [] });
  const text = details.map(strip).filter(l => !/^(Ticket number|Variation|Ticket name)/.test(l)).join(' ');
  assert.ok(text.replace(/\s+/g, ' ').includes(description.replace(/\s+/g, ' ')), text);
  assert.ok(!details.some(l => l.includes('…')));
});

// ASS-244: the ticket's screenshots in the panel, linked to their files; a count linked to the folder in the strip.
const SHOTS = { folder: '/w/ASS-171/screenshots', groups: [
  { name: 'A', shots: [{ label: 'AC1 · the tiles', path: '/w/ASS-171/screenshots/criterion-1.png' }, { label: 'AC2 · the badge', path: '/w/ASS-171/screenshots/7/criterion-2.png' }] },
  { name: 'Other', shots: [{ label: '7/later.png', path: '/w/ASS-171/screenshots/7/later.png' }] },
] };

test('ASS-244 AC1/AC2: the panel ends with a Screenshots section — each variation\'s name, then its screenshots, each a file:// link, the unrecorded after', () => {
  const out = quick({}, {}, { screenshots: SHOTS });
  assert.deepEqual(out.map(strip).slice(-8), ['Branch: change/ASS-171', '', 'Screenshots', '  A', '    AC1 · the tiles', '    AC2 · the badge', '  Other', '    7/later.png']);
  assert.ok(out.at(-4).includes('\x1b]8;;file:///w/ASS-171/screenshots/criterion-1.png\x1b\\AC1 · the tiles'));
  assert.ok(out.at(-1).includes('\x1b]8;;file:///w/ASS-171/screenshots/7/later.png\x1b\\'));
});

test('ASS-244 AC3: no screenshots, no section; the strip shows the count linked to the folder instead of the list', async () => {
  const { visible } = await import('../../src/tui/text.js');
  assert.equal(quick().map(strip).at(-1), 'Branch: change/ASS-171');
  assert.ok(!quick({}, {}, { screenshots: null }).map(strip).includes('Screenshots'));
  const t = { icon: '✨', key: 'ABC-1', variation: {} };
  const out = stripLines(t, { status: 'Build', agents: [], screenshots: SHOTS, width: 60 });
  assert.equal(out.length, 4);
  assert.equal(strip(out[3]), 'Screenshots: 3 — open the folder');
  assert.ok(out[3].includes('\x1b]8;;file:///w/ASS-171/screenshots\x1b\\'));
  assert.equal(stripLines(t, { status: 'Build', agents: [], width: 60 }).length, 3);
  assert.ok(stripLines(t, { status: 'Build', agents: [], screenshots: SHOTS, width: 20 }).every(l => visible(l) <= 20));
});

// ASS-261: the variation's Documents (review.js ticketDocuments) in the panel,
// each linked to its file, and its risk level just below the ticket number.
const DOCS = { risk: 'High', links: [
  { label: 'Execution plan', path: '/w/ASS-171/execution-plan-A.md' }, { label: 'Test plan', path: '/w/ASS-171/test-plan.md' },
  { label: 'Root cause analysis', path: '/w/ASS-171/root-cause-analysis-A.md' }, { label: 'Risk assessment', path: '/w/ASS-171/risk-assessment-A.md' },
] };

test('ASS-261 AC1: the panel has a Documents section after the branch, before the screenshots — each document a file:// link to its path', () => {
  const out = quick({}, {}, { documents: DOCS, screenshots: SHOTS });
  const plain = out.map(strip);
  const at = plain.indexOf('Documents');
  assert.deepEqual(plain.slice(at - 2, at + 6), ['Branch: change/ASS-171', '', 'Documents', '  Execution plan', '  Test plan', '  Root cause analysis', '  Risk assessment', '']);
  assert.equal(plain[at + 6], 'Screenshots');
  assert.ok(out[at + 1].includes('\x1b]8;;file:///w/ASS-171/execution-plan-A.md\x1b\\Execution plan\x1b]8;;\x1b\\'));
  assert.ok(out[at + 2].includes('\x1b]8;;file:///w/ASS-171/test-plan.md\x1b\\Test plan'));
  assert.ok(out[at + 4].includes('\x1b]8;;file:///w/ASS-171/risk-assessment-A.md\x1b\\Risk assessment'));
  assert.deepEqual(quick({}, {}, { documents: { risk: null, links: [DOCS.links[1]] } }).map(strip).slice(-3), ['', 'Documents', '  Test plan']);
});

test('ASS-261 AC1/AC3: no documents, no section and no risk line — the panel as before', () => {
  assert.deepEqual(quick({}, {}, { documents: null }).map(strip), quick().map(strip));
  assert.ok(!quick({}, {}, { documents: { risk: 'Low', links: [] } }).map(strip).includes('Documents'));
});

test('ASS-261 AC3: "Risk: <level>" just below the ticket number, High in the attention red, Low and Medium plain', () => {
  const out = quick({}, {}, { documents: DOCS });
  assert.deepEqual(out.slice(0, 3).map(strip), ['✨ ASS-171 · A', 'Risk: High', 'Operator-needed tiles on the sprint']);
  assert.equal(out[1], '\x1b[31mRisk: High\x1b[0m');
  for (const risk of ['Low', 'Medium']) assert.equal(quick({}, {}, { documents: { risk, links: [] } })[1], `Risk: ${risk}`);
  assert.equal(strip(quick({}, {}, { documents: { risk: null, links: DOCS.links } })[1]), 'Operator-needed tiles on the sprint');
});

test('ASS-261 AC4: the strip shows the risk after the key when there is room, and is unchanged without one', async () => {
  const { visible } = await import('../../src/tui/text.js');
  const t = { icon: '✨', key: 'ABC-1', title: 'Operator-needed tiles', variation: { name: 'A' } };
  const out = stripLines(t, { status: 'Build', agents: [], documents: DOCS, width: 96 });
  assert.equal(strip(out[0]), '✨ ABC-1 · A · Risk: High · Operator-needed tiles');
  assert.match(out[0], /\x1b\[31mRisk: High\x1b\[0m/);
  assert.equal(out.length, 3);
  assert.equal(strip(stripLines(t, { status: 'Build', agents: [], documents: { risk: 'Low', links: [] }, width: 23 })[0]), '✨ ABC-1 · A · Risk: L…');
  assert.ok(stripLines(t, { status: 'Build', agents: [], documents: DOCS, width: 20 }).every(l => visible(l) <= 20));
  assert.deepEqual(stripLines(t, { status: 'Build', agents: [], documents: null, width: 96 }), stripLines(t, { status: 'Build', agents: [], width: 96 }));
});

test('ASS-345: a ticket held as reassigned away from the operator says so on its screen and its quick panel — "Reassigned to <name>", or "Unassigned", and when that was detected; nothing for another', () => {
  const away = to => ({ reassigned: { to, 'to-id': to && 'acc-bea', 'detected-at': '2026-11-10T13:05:42Z', 'paused-variations': ['A'] } });
  const lines = ticket => ticketLines({ icon: '✨', key: 'ABC-1', title: 'T', ...ticket, variation: { 'local-testing': {}, 'state-changes': [], 'is-paused': true } },
    { status: 'Build', stepName: id => id, prompted: () => false, agents: [], columns: 100, steps: [] }).details;
  assert.ok(lines(away('Bea Other')).some(l => /^Held +Reassigned to Bea Other, detected 2026-11-10 13:05 UTC$/.test(l)), lines(away('Bea Other')).join('\n'));
  assert.ok(lines(away(null)).some(l => /^Held +Unassigned, detected 2026-11-10 13:05 UTC$/.test(l)));
  assert.ok(!lines({}).some(l => l.startsWith('Held')));
  const panel = ticket => { const plain = quick(ticket).map(strip); const at = plain.findIndex(l => l.startsWith('Held')); return plain.slice(at, at + 2); };
  assert.deepEqual(panel(away('Bea Other')), ['Held: Reassigned to Bea Other', '  since 11-10 13:05 UTC']);
  assert.deepEqual(panel(away(null)), ['Held: Unassigned', '  since 11-10 13:05 UTC']);
  assert.ok(!quick().map(strip).some(l => l.startsWith('Held')));
});

// ASS-355 AC7: the ticket screen names each dependency with its status and
// assignee — control's dependencyRows, through sprintTickets — where it is
// when not in the sprint, and whether it is done; a ticket without them (a
// backlog one) lists its keys as before.
test('ASS-355: the Dependencies field lists each dependency on its own line with its status, assignee, where it is and whether it is done', async () => {
  const { sprintTickets } = await import('../../src/tui/screens/shared.js');
  const { initialState } = await import('../../src/tui/app.js');
  const steps = [{ id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } }, { id: 'done', name: 'Done', sequence: 10, 'is-done': true, 'paired-ticket-system-status': 'Done', action: { type: 'none' } }];
  const v = state => [{ name: 'A', 'harness-status': { state, 'state-engine': 'e' } }];
  const features = [
    { key: 'PRJ-1', title: 'Needs three', dependencies: ['PRJ-2', 'EX-301', 'ZZ-9'], variations: v('build') },
    { key: 'PRJ-2', title: 'Ours', 'ticket-system-status': 'In Progress', 'ticket-system-assignment': 'Me Myself', variations: v('build') },
  ];
  const project = { id: 'p', name: 'P', stateEngine: 'e', waitForDependencies: true, outside: [{ key: 'EX-301', 'ticket-system-status': 'Done', 'ticket-system-assignment': 'A Teammate' }], sprint: { number: 1, features, bugs: [], spikes: [] }, questions: [] };
  const t = sprintTickets(initialState({ projects: [project], workflows: [{ name: 'e', steps }], assignments: [] })).tickets.find(x => x.key === 'PRJ-1');
  const shown = ticketLines(t, { status: 'Build', stepName: id => id, prompted: () => false, agents: [], columns: 120 }).details.map(strip);
  const at = shown.findIndex(l => l.startsWith('Dependencies'));
  assert.deepEqual(shown.slice(at, at + 3).map(l => l.slice(28)), [
    'PRJ-2 — In Progress, Me Myself, not done',
    'EX-301 — Done, A Teammate, outside the sprint and backlog, done',
    'ZZ-9 — not found',
  ]);
  const plain = ticketLines({ key: 'B-1', title: 'Backlog', dependencies: ['B-2', 'B-3'], variation: {} }, { status: '', stepName: id => id, prompted: () => false, agents: [], columns: 120 }).details.map(strip);
  assert.equal(plain.find(l => l.startsWith('Dependencies')).slice(28), 'B-2, B-3');
});
