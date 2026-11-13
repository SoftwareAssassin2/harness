import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressSince, progressLines, lastWeekdayMorning, boardOf } from '../../src/tui/updates.js';
import { enginesOf } from '../../src/tui/status.js';
import { link, visible } from '../../src/tui/text.js';

// ASS-332: the update written the way the team sees the work on the board,
// grouped by the ticket system's status. ASS-415: a short list per status,
// in the order the engine gives. An execution engine whose steps pair with
// the board's statuses, and the engines of the steps that have their own.
const step = (id, name, sequence, fields = {}) => ({ id, name, sequence, action: { type: 'prompt' }, ...fields });
const workflows = [
  { name: 'prj-dev', steps: [
    step('blocked-for-human', 'Blocked for Human', 0, { area: 'quarantine', 'is-blocked-state': true, 'paired-ticket-system-status': 'On Hold', action: { type: 'human' } }),
    step('blocked', 'Blocked', 0, { area: 'quarantine', 'paired-ticket-system-status': 'On Hold', action: { type: 'state-engine', engine: 'prj-blocked' } }),
    step('reqs-changed', 'Requirements Changed', 0, { area: 'quarantine' }),
    step('committed', 'Committed', 2, { 'paired-ticket-system-status': 'To Do', 'is-planning-stage': true, action: { type: 'none' } }),
    step('setup', 'Setup', 3, { 'paired-ticket-system-status': 'In Progress', 'is-planning-stage': true }),
    step('plan', 'Plan', 4, { 'paired-ticket-system-status': 'In Progress', 'is-planning-stage': true, action: { type: 'state-engine', engine: 'prj-plan' } }),
    step('build', 'Build', 5, { 'paired-ticket-system-status': 'In Progress', action: { type: 'state-engine', engine: 'prj-build' } }),
    step('release', 'Release', 6, { 'paired-ticket-system-status': 'In Review' }),
    step('qa', 'QA', 7, { 'paired-ticket-system-status': 'In Testing' }),
    step('done', 'Done', 8, { 'paired-ticket-system-status': 'Done', 'is-done': true, action: { type: 'none' } }),
  ] },
  { name: 'prj-plan', steps: [step('write-plan', 'Write the Plan', 1), step('check-plan', 'Review the Plan', 2)] },
  { name: 'prj-build', steps: [step('gen-tests', 'Generate Tests', 1), step('run-tests', 'Run Automated Tests', 2), step('build-blocked', 'Blocked', 3, { action: { type: 'none' } })] },
  { name: 'prj-blocked', steps: [step('troubleshoot-it', 'Troubleshoot', 1), step('await-fix', 'Await the Fix', 2)] },
];
const ENGINES = { plan: 'prj-plan', build: 'prj-build', blocked: 'prj-blocked' };
// A status or a change's side as 'top' or 'top/sub'.
const at = path => path.split('/');
const status = (path, engine = 'prj-dev') => {
  const [top, sub] = at(path);
  return { state: top, 'state-engine': engine, ...(sub ? { 'sub-status': { state: sub, 'state-engine': ENGINES[top] } } : {}) };
};
// A move from one 'top' or 'top/sub' to another, as the state-changes it
// makes: within one top step, the sub-step's change beneath it; into another
// with a sub-step, the move and then the sub-step's start beneath it, as control records them.
const change = (a, b, timestamp, sub) => ({ 'state-engine': 'prj-dev', 'from-state': a, 'to-state': b, ...(sub ? { 'sub-state-change': { 'state-engine': ENGINES[a], 'from-state': sub[0], 'to-state': sub[1] } } : {}), timestamp, 'agent-dispatch-log': [] });
const move = (from, to, timestamp) => {
  const [a, aSub] = at(from), [b, bSub] = at(to);
  if (a === b) return [change(a, b, timestamp, [aSub, bSub])];
  return [change(a, b, timestamp), ...(bSub ? [change(b, b, timestamp, [null, bSub])] : [])];
};
// A one-variation ticket whose status is where its last move went (else `where`).
const ticket = (key, title, fields, moves = [], where = moves.at(-1)?.[1], variation = {}) => ({
  key, title, ...fields,
  variations: [{ name: 'A', 'harness-status': status(where, variation.engine), 'state-changes': moves.flatMap(m => move(...m)), ...variation }],
});

const since = Date.parse('2026-11-06T04:00:00Z');
const before = '2026-11-05T12:00:00Z', after = n => `2026-11-09T0${n}:00:00Z`;
const sprint = {
  features: [
    ticket('EX-1', 'Shipped it', { 'ticket-system-status': 'Done' }, [['committed', 'build/gen-tests', before], ['build/gen-tests', 'qa', after(1)], ['qa', 'done', after(2)]]),
    ticket('EX-2', 'Old news', { 'ticket-system-status': 'Done' }, [['qa', 'done', before]]),
    ticket('EX-3', 'Being verified', { 'ticket-system-status': 'In Testing' }, [['committed', 'build/run-tests', before], ['build/run-tests', 'qa', after(1)]]),
    ticket('EX-4', 'Back to building', { 'ticket-system-status': 'On Hold' }, [['build/gen-tests', 'blocked/troubleshoot-it', before], ['blocked/troubleshoot-it', 'build/run-tests', after(1)]]),
    ticket('EX-5', 'Planning it', { 'ticket-system-status': 'In Progress' }, [['committed', 'plan/write-plan', before], ['plan/write-plan', 'plan/check-plan', after(1)]]),
    ticket('EX-6', 'Held back', { 'ticket-system-status': 'In Progress', dependencies: ['EX-3'] }, [['committed', 'plan/write-plan', before]], undefined, { 'is-paused': true }),
    ticket('EX-7', 'Queued', { 'ticket-system-status': 'To Do', dependencies: ['EX-5', 'EX-1', 'OTHER-1'] }, [], 'committed'),
    ticket('EX-11', 'Not started yet', { 'ticket-system-status': 'To Do' }, [], 'committed'),
    ticket('EX-13', 'Made room', { 'ticket-system-status': 'In Progress' }, [['committed', 'build/gen-tests', before]], undefined, { 'is-paused': true, 'paused-for-fast-track': 'EX-99' }),
    ticket('EX-14', 'By hand', { 'ticket-system-status': 'In Progress', 'worked-manually': { by: 'someone', since: '2026-11-05T10:00:00Z' } }, [['committed', 'setup', before]]),
  ],
  bugs: [
    ticket('EX-8', 'Stuck', { 'ticket-system-status': 'On Hold' }, [['committed', 'build/gen-tests', before], ['build/gen-tests', 'blocked/await-fix', after(2)]], undefined, { 'waits-on': { project: 'prj', ticket: 'EX-9' } }),
    ticket('EX-10', 'Needs a person', { 'ticket-system-status': 'On Hold' }, [['committed', 'build/run-tests', before], ['build/run-tests', 'blocked-for-human', after(3)]]),
  ],
  spikes: [
    ticket('EX-12', 'Released', {}, [['qa', 'release', after(4)]]),
  ],
};
const progress = progressSince({ sprint, workflows, since });
const section = (out, name) => out.sections.find(s => s.name === name);
const keysOf = list => list.map(b => b.key);

test('the default moment is 04:00 UTC on the weekday before today\'s UTC date: Monday\'s is Friday\'s, a weekend\'s Friday\'s (ASS-332)', () => {
  const morning = now => new Date(lastWeekdayMorning(new Date(now))).toISOString();
  assert.equal(morning('2026-11-09T15:00:00Z'), '2026-11-06T04:00:00.000Z');   // Monday
  assert.equal(morning('2026-11-10T03:00:00Z'), '2026-11-09T04:00:00.000Z');   // Tuesday, before 04:00 too
  assert.equal(morning('2026-11-11T23:59:00Z'), '2026-11-10T04:00:00.000Z');   // Wednesday
  assert.equal(morning('2026-11-12T00:00:00Z'), '2026-11-11T04:00:00.000Z');   // Thursday
  assert.equal(morning('2026-11-13T12:00:00Z'), '2026-11-12T04:00:00.000Z');   // Friday
  assert.equal(morning('2026-11-14T12:00:00Z'), '2026-11-13T04:00:00.000Z');   // Saturday
  assert.equal(morning('2026-11-15T12:00:00Z'), '2026-11-13T04:00:00.000Z');   // Sunday
});

test('ASS-415 AC1: each section is a bold heading with its count, one "- <KEY>: <title>" line per ticket and a blank line; no notes and no closing line', () => {
  const lines = progressLines(progress, 200);
  assert.deepEqual(lines, [
    '*Done (1):*', '- EX-1: Shipped it', '',
    '*In Testing (1):*', '- EX-3: Being verified', '',
    '*In Review (1):*', '- EX-12: Released', '',
    '*In Progress (4):*', '- EX-4: Back to building', '- EX-5: Planning it', '- EX-13: Made room', '- EX-14: By hand', '',
    '*On Hold (4):*',
    'Paused on purpose (1):', '- EX-6: Held back', '',
    'Waiting on another ticket (1):', '- EX-7: Queued', '',
    'Stopped until a problem is fixed (2):', '- EX-8: Stuck', '- EX-10: Needs a person', '',
  ]);
  assert.equal(progress.net, undefined);
  const keys = progress.sections.flatMap(s => keysOf(s.bullets));
  assert.equal(new Set(keys).size, keys.length, 'each ticket once');
});

test('ASS-415 AC1: a title longer than 20 characters is cut to its first 20 and "..."; one of 20 or fewer stays whole', () => {
  const titled = title => progressSince({ sprint: { features: [ticket('EX-20', title, {}, [['build/run-tests', 'qa', after(1)]])] }, workflows, since }).sections[0].bullets[0].text;
  assert.equal(titled('Capture parent court records'), 'EX-20: Capture parent court...');
  assert.equal(titled('Exactly twenty chars'), 'EX-20: Exactly twenty chars');
  assert.equal(titled('Twenty-one characters'), 'EX-20: Twenty-one character...');
});

test('ASS-415 AC2: sections follow the highest sequence of the steps paired with each status, closest to done first, the held one last', () => {
  assert.deepEqual(progress.sections.map(s => s.name), ['Done', 'In Testing', 'In Review', 'In Progress', 'On Hold']);
  const board = boardOf(enginesOf(workflows), ['prj-dev']);
  assert.deepEqual(Object.fromEntries(board.rank), { 'On Hold': 0, 'To Do': 2, 'In Progress': 5, 'In Review': 6, 'In Testing': 7, Done: 8 });
  assert.deepEqual([board.held, board.queued, board.done], ['On Hold', 'To Do', 'Done']);
  // A status no step pairs with (the ticket system's alone) follows the engine's, before the held one.
  const unpaired = progressSince({ sprint: { features: [ticket('EX-21', 'Changed', { 'ticket-system-status': 'Selected' }, [['build/gen-tests', 'reqs-changed', after(1)]]), sprint.bugs[1], sprint.features[0]] }, workflows, since });
  assert.deepEqual(unpaired.sections.map(s => s.name), ['Done', 'Selected', 'On Hold']);
});

test('ASS-415 AC3: In Progress is one flat list, whether planning, planned, building or held on purpose', () => {
  const inProgress = section(progress, 'In Progress');
  assert.deepEqual(keysOf(inProgress.bullets), ['EX-4', 'EX-5', 'EX-13', 'EX-14']);   // building, planning, paused for a fast-track, worked by hand
  assert.equal(inProgress.groups, undefined);
  assert.ok(!progress.sections.some(s => s.name.startsWith('In Progress:')));
});

test('ASS-415 AC4: the held section keeps its three plain sub-groups in order, each counted, the empty ones left out, its heading counting them all (ASS-352, ASS-355)', () => {
  const onHold = section(progress, 'On Hold');
  assert.deepEqual(onHold.groups.map(g => [g.name, keysOf(g.bullets)]), [
    ['Paused on purpose', ['EX-6']], ['Waiting on another ticket', ['EX-7']], ['Stopped until a problem is fixed', ['EX-8', 'EX-10']],
  ]);
  assert.deepEqual(keysOf(onHold.bullets), onHold.groups.flatMap(g => keysOf(g.bullets)));
  const onlyStopped = progressSince({ sprint: { bugs: [sprint.bugs[1]] }, workflows, since });
  assert.deepEqual(progressLines(onlyStopped, 80), ['*On Hold (1):*', 'Stopped until a problem is fixed (1):', '- EX-10: Needs a person', '']);
  // A paused ticket at any step not done is Paused on purpose; a paused one that is done stays Done.
  const paused = { 'is-paused': true };
  const out = progressSince({ sprint: { features: [
    ticket('EX-30', 'Verify later', { 'ticket-system-status': 'In Testing' }, [['build/run-tests', 'qa', before]], undefined, paused),
    ticket('EX-31', 'Paused and done', { 'ticket-system-status': 'Done' }, [['qa', 'done', after(1)]], undefined, paused),
    ticket('EX-32', 'Blocked and paused', { 'ticket-system-status': 'On Hold' }, [['build/gen-tests', 'blocked/await-fix', before]], undefined, paused),
  ] }, workflows, since });
  assert.deepEqual(out.sections.map(s => [s.name, keysOf(s.bullets)]), [['Done', ['EX-31']], ['On Hold', ['EX-30', 'EX-32']]]);
  assert.deepEqual(section(out, 'On Hold').groups.map(g => g.name), ['Paused on purpose']);
});

test('ASS-415 AC5: the committed queue\'s status (To Do) is left out; Done lists only tickets that became done since the moment', () => {
  assert.equal(section(progress, 'To Do'), undefined);
  const keys = progress.sections.flatMap(s => keysOf(s.bullets));
  assert.ok(!keys.includes('EX-11'), 'at the committed queue: left out');
  assert.ok(!keys.includes('EX-2'), 'done before the moment and not changed since: left out');
  assert.deepEqual(keysOf(section(progress, 'Done').bullets), ['EX-1']);
});

test('ASS-415 AC6: empty sections are left out; nothing to list says so; the key is linked for display only and the text stays plain', () => {
  const quiet = progressSince({ sprint: { features: [sprint.features[1], sprint.features[7]] }, workflows, since });
  assert.deepEqual(quiet.sections, []);
  assert.deepEqual(progressLines(quiet, 80), ['Nothing on the sprint has moved since then.']);
  const linked = progressSince({ sprint: { features: [{ ...sprint.features[0], url: 'http://t/1' }] }, workflows, since });
  assert.equal(linked.sections[0].bullets[0].text, 'EX-1: Shipped it');
  assert.ok(progressLines(linked, 200).includes(`- ${link('EX-1', 'http://t/1')}: Shipped it`));
  assert.ok(progressLines(progress, 200).every(l => !l.includes('\x1b')));
  const narrow = progressLines(progress, 14);
  assert.ok(narrow.every(l => visible(l) <= 14), narrow.join('\n'));
});

test('a ticket with more than one variation is listed by variation (ASS-332)', () => {
  const two = { ...ticket('EX-40', 'Two ways', { 'ticket-system-status': 'In Progress' }, [['committed', 'setup', after(1)]]) };
  two.variations.push({ ...two.variations[0], name: 'B' });
  assert.deepEqual(progressSince({ sprint: { features: [two] }, workflows, since }).sections[0].bullets.map(b => b.text), ['EX-40.A: Two ways', 'EX-40.B: Two ways']);
});

// ASS-415 AC7: an engine whose status names are none of today's — and whose
// blocked state sits at a high sequence — orders and groups the same way,
// proving nothing is read by name.
const alt = [{ name: 'alt-dev', steps: [
  step('needs-eyes', 'Needs Eyes', 99, { area: 'quarantine', 'is-blocked-state': true, 'paired-ticket-system-status': 'Parked', action: { type: 'human' } }),
  step('waiting-room', 'Waiting Room', 1, { 'paired-ticket-system-status': 'Icebox', 'is-planning-stage': true, action: { type: 'none' } }),
  step('ready', 'Ready', 2, { 'paired-ticket-system-status': 'Ready', 'is-planning-stage': true, action: { type: 'none' } }),
  step('think', 'Think', 3, { 'paired-ticket-system-status': 'Underway', 'is-planning-stage': true }),
  step('make', 'Make', 4, { 'paired-ticket-system-status': 'Underway' }),
  step('look', 'Look', 5, { 'paired-ticket-system-status': 'Being Looked At' }),
  step('try', 'Try', 6, { 'paired-ticket-system-status': 'Aiming' }),
  step('shipped', 'Shipped', 7, { 'paired-ticket-system-status': 'Zipped', 'is-done': true, action: { type: 'none' } }),
] }];
const altTicket = (key, title, where, fields = {}, variation = {}, moves = [{ 'state-engine': 'alt-dev', 'from-state': 'ready', 'to-state': where, timestamp: after(1) }]) => ({
  key, title, ...fields, variations: [{ name: 'A', 'harness-status': { state: where, 'state-engine': 'alt-dev' }, 'state-changes': moves, ...variation }],
});

test('ASS-415 AC7: an engine with other status names gets its order, held section and left-out queue from its steps alone', () => {
  const out = progressSince({ sprint: { features: [
    altTicket('EX-50', 'Thinking it over', 'think'),
    altTicket('EX-51', 'Made it', 'shipped'),
    altTicket('EX-52', 'In the queue', 'ready', {}, {}, []),
    altTicket('EX-53', 'Help wanted', 'needs-eyes'),
    altTicket('EX-54', 'Trying it', 'try'),
    altTicket('EX-55', 'Looking it over', 'look'),
    altTicket('EX-56', 'Making it', 'make', {}, { 'is-paused': true }),
    altTicket('EX-57', 'Old ship', 'shipped', {}, {}, []),
  ] }, workflows: alt, since, hold: () => ({ waits: [] }) });
  assert.deepEqual(progressLines(out, 200), [
    '*Zipped (1):*', '- EX-51: Made it', '',
    '*Aiming (1):*', '- EX-54: Trying it', '',
    '*Being Looked At (1):*', '- EX-55: Looking it over', '',
    '*Underway (1):*', '- EX-50: Thinking it over', '',
    '*Parked (2):*',
    'Paused on purpose (1):', '- EX-56: Making it', '',
    'Stopped until a problem is fixed (1):', '- EX-53: Help wanted', '',
  ]);
});

test('ASS-415 AC7: when the blocked state pairs with a working status, the engine has no held section and that status stays one flat list', () => {
  const shared = [{ name: 'alt-dev', steps: alt[0].steps.map(s => (s.id === 'needs-eyes' ? { ...s, 'paired-ticket-system-status': 'Underway' } : s)) }];
  assert.equal(boardOf(enginesOf(shared), ['alt-dev']).held, undefined);
  const out = progressSince({ sprint: { features: [
    altTicket('EX-60', 'Help wanted', 'needs-eyes'),
    altTicket('EX-61', 'Making it', 'make', {}, { 'is-paused': true }),
  ] }, workflows: shared, since, hold: () => ({ waits: [] }) });
  assert.deepEqual(out.sections.map(s => [s.name, keysOf(s.bullets), s.groups]), [['Underway', ['EX-60', 'EX-61'], undefined]]);
});

// ASS-355 AC7: the held section's Waiting on another ticket holds the
// variations control's dependencyHold holds; one both paused and waiting is
// under Paused on purpose alone. The screen judges with control's predicate
// over the project as control sees it.
test('ASS-355 AC7: Waiting on another ticket holds the variations `hold` holds; paused and waiting goes under Paused on purpose only', () => {
  const sprintOf = {
    features: [
      ticket('EX-70', 'Waits outside', { 'ticket-system-status': 'In Progress', dependencies: ['EX-1'] }, [['committed', 'build/gen-tests', before]]),
      ticket('EX-71', 'Paused and waiting', { 'ticket-system-status': 'In Progress', dependencies: ['EX-1'] }, [['committed', 'build/gen-tests', before]], undefined, { 'is-paused': true }),
      ticket('EX-72', 'Free', { 'ticket-system-status': 'In Progress', dependencies: ['EX-2'] }, [['committed', 'build/gen-tests', before]]),
    ],
    bugs: [ticket('EX-73', 'Needs a look', { 'ticket-system-status': 'On Hold' }, [['committed', 'build/run-tests', before], ['build/run-tests', 'blocked-for-human', after(1)]])],
  };
  const hold = (t, v) => ({ waits: (t.dependencies ?? []).filter(k => k === 'EX-1').filter(() => v['harness-status'].state !== 'done'), ignores: [] });
  const out = progressSince({ sprint: sprintOf, workflows, since, hold });
  assert.deepEqual(section(out, 'On Hold').groups.map(g => [g.name, keysOf(g.bullets)]), [
    ['Paused on purpose', ['EX-71']], ['Waiting on another ticket', ['EX-70']], ['Stopped until a problem is fixed', ['EX-73']],
  ]);
  assert.deepEqual(keysOf(section(out, 'In Progress').bullets), ['EX-72']);
});

test('ASS-355 AC7: the updates screen judges the hold with control\'s predicate — the project\'s flag, its engine\'s done status and its outside-tickets.json', async () => {
  const { view } = await import('../../src/tui/screens/updates.js');
  const { initialState } = await import('../../src/tui/app.js');
  const features = [ticket('EX-80', 'Waits on a teammate', { 'ticket-system-status': 'In Progress', dependencies: ['EX-9'] }, [['committed', 'build/gen-tests', after(1)]])];
  const screen = (flag, status) => {
    const project = { id: 'prj', name: 'Prj', stateEngine: 'prj-dev', waitForDependencies: flag, outside: [{ key: 'EX-9', 'ticket-system-status': status, 'ticket-system-assignment': 'A Teammate' }], sprint: { number: 1, features, bugs: [], spikes: [] }, questions: [] };
    const state = { ...initialState({ projects: [project], workflows, assignments: [] }), updatesSince: since, updatesScroll: 0 };
    return view(state, { columns: 200, rows: 60, now: new Date(since) }).join('\n');
  };
  assert.match(screen(true, 'In Progress'), /\*On Hold \(1\):\*\nWaiting on another ticket \(1\):\n- EX-80: Waits on a teammate\n/);
  assert.match(screen(true, 'Done'), /\*In Progress \(1\):\*\n- EX-80/);   // the engine's done step pairs Done
  assert.doesNotMatch(screen(false, 'In Progress'), /Waiting on another ticket/);   // flag off: control holds nothing
});
