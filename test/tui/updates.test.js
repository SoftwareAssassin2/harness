import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressSince, progressLines, lastWeekdayMorning } from '../../src/tui/updates.js';
import { link, visible } from '../../src/tui/text.js';

// ASS-332: the update written the way the team sees the work on the board,
// grouped by the ticket system's status. An execution engine whose steps pair
// with the board's statuses, and the engines of the steps that have their own.
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
const status = path => {
  const [top, sub] = at(path);
  return { state: top, 'state-engine': 'prj-dev', ...(sub ? { 'sub-status': { state: sub, 'state-engine': ENGINES[top] } } : {}) };
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
  variations: [{ name: 'A', 'harness-status': status(where), 'state-changes': moves.flatMap(m => move(...m)), ...variation }],
});

const since = Date.parse('2026-11-06T04:00:00Z');
const before = '2026-11-05T12:00:00Z', after = n => `2026-11-09T0${n}:00:00Z`;
const sprint = {
  features: [
    ticket('PRJ-1', 'Shipped it', { 'ticket-system-status': 'Done' }, [['committed', 'build/gen-tests', before], ['build/gen-tests', 'qa', after(1)], ['qa', 'done', after(2)]]),
    ticket('PRJ-2', 'Old news', { 'ticket-system-status': 'Done' }, [['qa', 'done', before]]),
    ticket('PRJ-3', 'Being verified', { 'ticket-system-status': 'In Testing' }, [['committed', 'build/run-tests', before], ['build/run-tests', 'qa', after(1)]]),
    ticket('PRJ-4', 'Back to building', { 'ticket-system-status': 'On Hold' }, [['build/gen-tests', 'blocked/troubleshoot-it', before], ['blocked/troubleshoot-it', 'build/run-tests', after(1)]]),
    ticket('PRJ-5', 'Planning it', { 'ticket-system-status': 'In Progress' }, [['committed', 'plan/write-plan', before], ['plan/write-plan', 'plan/check-plan', after(1)]]),
    ticket('PRJ-6', 'Held back', { 'ticket-system-status': 'In Progress', dependencies: ['PRJ-3'] }, [['committed', 'plan/write-plan', before]], undefined, { 'is-paused': true }),
    ticket('PRJ-7', 'Queued', { 'ticket-system-status': 'To Do', dependencies: ['PRJ-5', 'PRJ-1', 'OTHER-1'] }, [], 'committed'),
  ],
  bugs: [
    ticket('PRJ-8', 'Stuck', { 'ticket-system-status': 'On Hold' }, [['committed', 'build/gen-tests', before], ['build/gen-tests', 'blocked/await-fix', after(2)]], undefined, { 'waits-on': { project: 'prj', ticket: 'PRJ-9' }, 'ai-feedback-short': 'gen-tests failed 3 times' }),
    ticket('PRJ-10', 'Needs a person', { 'ticket-system-status': 'On Hold' }, [['committed', 'build/run-tests', before], ['build/run-tests', 'blocked-for-human', after(3)]]),
  ],
  spikes: [
    ticket('PRJ-12', 'Released', {}, [['qa', 'release', after(4)]]),
  ],
};
const progress = progressSince({ sprint, workflows, since });
const group = title => progress.sections.find(s => s.title.startsWith(`${title} (`));
const texts = title => group(title)?.bullets.map(b => b.text);

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

test('each ticket is listed once, under its board status now, in board order, each heading counting it and saying what it means (ASS-332)', () => {
  assert.deepEqual(progress.sections.map(s => s.title), [
    'Done (1). Finished and accepted.',
    'In Testing (1). The work is done and being verified.',
    'In Progress: building (1). Code is written or being written, and tests are running.',
    'In Progress: planning (1). Being analyzed and planned before any code.',
    'To Do (1). Committed to the sprint, not started yet.',
    'On Hold (3). Paused on purpose, or stopped until a problem is fixed.',
    'In Review (1)',
  ]);
  const keys = progress.sections.flatMap(s => s.bullets.map(b => b.key));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(!keys.includes('PRJ-2'), 'done before the moment and not changed since: left out');
});

test('the status is the ticket system\'s, else the one its step pairs with; one its step pairs with none keeps the ticket system\'s (ASS-332)', () => {
  assert.deepEqual(texts('In Review'), ['PRJ-12: Released. At the Release step.']);
  const unpaired = progressSince({ sprint: { features: [ticket('PRJ-20', 'Changed', { 'ticket-system-status': 'Selected' }, [['build/gen-tests', 'reqs-changed', after(1)]])] }, workflows, since });
  assert.deepEqual(unpaired.sections.map(s => s.title), ['Selected (1)']);
});

test('in progress splits into building, planning (a planning-stage step) and held on purpose (waiting on its dependencies); a paused one is On Hold (ASS-332, ASS-352)', () => {
  assert.deepEqual(group('In Progress: building').bullets.map(b => b.key), ['PRJ-4']);
  assert.deepEqual(group('In Progress: planning').bullets.map(b => b.key), ['PRJ-5']);
  assert.equal(group('In Progress: held on purpose'), undefined);
  assert.deepEqual(group('On Hold').groups[0].bullets.map(b => b.key), ['PRJ-6']);
  const waiting = progressSince({ sprint: { features: [
    ticket('PRJ-30', 'First', { 'ticket-system-status': 'In Testing' }, [['build/run-tests', 'qa', after(1)]]),
    ticket('PRJ-31', 'Second', { 'ticket-system-status': 'In Progress', dependencies: ['PRJ-30'] }, [['committed', 'setup', after(2)]]),
  ] }, workflows, since });
  assert.deepEqual(waiting.sections.find(s => s.title.startsWith('In Progress: held')).bullets.map(b => b.text), ['PRJ-31: Second. At the Setup step, waits for PRJ-30 to finish.']);
});

test('each line is the key, title and where it is in plain words, with why when it is held or on hold; no step id shows (ASS-332)', () => {
  assert.deepEqual(texts('Done'), ['PRJ-1: Shipped it.']);
  assert.deepEqual(texts('In Testing'), ['PRJ-3: Being verified. At the QA step.']);
  assert.deepEqual(texts('In Progress: planning'), ['PRJ-5: Planning it. At the Review the Plan step.']);
  assert.deepEqual(texts('To Do'), ['PRJ-7: Queued. Waits for PRJ-5 to finish.']);
  assert.deepEqual(texts('On Hold'), [
    'PRJ-6: Held back. Paused at the Write the Plan step, waits for PRJ-3 to finish.',
    'PRJ-8: Stuck. Stopped at the Generate Tests step, waiting for a fix in PRJ-9.',
    'PRJ-10: Needs a person. Stopped at the Run Automated Tests step, needs a person to look at it.',
  ]);
  const endedInBlocked = ticket('PRJ-21', 'Gave up', { 'ticket-system-status': 'On Hold' }, [['committed', 'build/run-tests', before], ['build/run-tests', 'build/build-blocked', after(1)], ['build/build-blocked', 'blocked/troubleshoot-it', after(1)]]);
  assert.deepEqual(progressSince({ sprint: { bugs: [endedInBlocked] }, workflows, since }).sections[0].bullets.map(b => b.text),
    ['PRJ-21: Gave up. Stopped at the Run Automated Tests step, being looked into.'], 'a sub-engine\'s own Blocked end is not where it stopped');
  const all = progressLines(progress, 200).join('\n');
  for (const id of workflows.flatMap(w => w.steps.map(s => s.id)).filter(id => id.includes('-'))) assert.ok(!all.includes(id), id);
  for (const word of ['prj-dev', 'prj-build', 'Blocked for Human']) assert.ok(!all.includes(word), word);
});

test('a ticket whose board status differs from the one its step pairs with is placed by its step and flagged (ASS-332)', () => {
  assert.deepEqual(texts('In Progress: building'), ['PRJ-4: Back to building. At the Run Automated Tests step. (board may still show On Hold)']);
});

test('a closing line nets the change since the moment: holds cleared, On Hold then and now, active then and now, in testing and reached Done (ASS-332)', () => {
  assert.equal(progress.net, 'Net since Fri Nov 6, 04:00 UTC: 1 hold cleared; On Hold went from 2 tickets to 3, 1 of them paused on purpose. 2 tickets are actively being built or planned, down from 5. 1 in testing, 1 reached Done.');
});

test('a ticket with more than one variation is listed by variation; nothing to list says so (ASS-332)', () => {
  const two = { ...ticket('PRJ-40', 'Two ways', { 'ticket-system-status': 'In Progress' }, [['committed', 'setup', after(1)]]) };
  two.variations.push({ ...two.variations[0], name: 'B' });
  assert.deepEqual(progressSince({ sprint: { features: [two] }, workflows, since }).sections[0].bullets.map(b => b.key), ['PRJ-40.A', 'PRJ-40.B']);
  const quiet = progressSince({ sprint: { features: [sprint.features[1]] }, workflows, since });
  assert.deepEqual(quiet.sections, []);
  assert.deepEqual(progressLines(quiet, 80)[0], 'Nothing on the sprint has moved since then.');
});

test('the lines are plain text with "- " bullets, the key linked when the sprint has its url, a long one wrapped under its own text for display (ASS-332)', () => {
  const plain = progressLines(progress, 200);
  assert.ok(plain.every(l => !l.includes('\x1b')));
  assert.equal(plain[0], 'Done (1). Finished and accepted.');
  assert.equal(plain[1], '- PRJ-1: Shipped it.');
  assert.equal(plain.at(-1), progress.net);
  assert.equal(plain.at(-2), '');
  const linked = progressSince({ sprint: { features: [{ ...sprint.features[0], url: 'http://t/1' }] }, workflows, since });
  assert.ok(progressLines(linked, 200).includes(`- ${link('PRJ-1', 'http://t/1')}: Shipped it.`));
  const narrow = progressLines(progress, 30);
  assert.ok(narrow.every(l => visible(l) <= 30), narrow.join('\n'));
  const first = narrow.findIndex(l => l.startsWith('  - PRJ-10'));
  assert.match(narrow[first + 1], /^ {4}\S/, 'under On Hold\'s sub-group, indented two more');
});

// ASS-352: a ticket paused on purpose — by the operator, a requirements
// change's hold or a reassignment's — is On Hold, apart from one stopped by a
// problem, whatever its step; control's pause to free a seat for a fast-track is not.
const paused = { 'is-paused': true };
const pausedSprint = {
  features: [
    ticket('PRJ-50', 'Verify later', { 'ticket-system-status': 'In Testing' }, [['build/run-tests', 'qa', before]], undefined, paused),
    ticket('PRJ-51', 'Not started', { 'ticket-system-status': 'To Do', 'is-paused': true, dependencies: ['PRJ-50'] }, [], 'committed'),
    ticket('PRJ-52', 'Mid build', { 'ticket-system-status': 'In Progress' }, [['committed', 'build/run-tests', before]], undefined, paused),
    ticket('PRJ-55', 'Went to someone', { 'ticket-system-status': 'In Progress', reassigned: { to: 'Sam Lee', 'detected-at': '2026-11-05T10:00:00Z', 'paused-variations': ['A'] } }, [['committed', 'build/gen-tests', before]], undefined, paused),
    ticket('PRJ-56', 'Went to no one', { 'ticket-system-status': 'In Progress', reassigned: { to: null, 'detected-at': '2026-11-05T10:00:00Z', 'paused-variations': ['A'] } }, [['committed', 'plan/write-plan', before]], undefined, paused),
    ticket('PRJ-57', 'Made room', { 'ticket-system-status': 'In Progress' }, [['committed', 'build/gen-tests', before]], undefined, { 'is-paused': true, 'paused-for-fast-track': 'PRJ-99' }),
    ticket('PRJ-58', 'By hand', { 'ticket-system-status': 'In Progress', 'worked-manually': { by: 'someone', since: '2026-11-05T10:00:00Z' } }, [['committed', 'setup', before]]),
    ticket('PRJ-59', 'Paused and done', { 'ticket-system-status': 'Done' }, [['qa', 'done', after(1)]], undefined, paused),
    ticket('PRJ-60', 'Requirements changed', { 'ticket-system-status': 'In Progress', 'pending-requirements-change': { description: 'new' } }, [['build/gen-tests', 'reqs-changed', before]], undefined, paused),
    ticket('PRJ-61', 'Paused after moving', { 'ticket-system-status': 'In Testing' }, [['build/run-tests', 'qa', after(2)]], undefined, paused),
  ],
  bugs: [
    ticket('PRJ-53', 'Blocked and paused', { 'ticket-system-status': 'On Hold' }, [['committed', 'build/gen-tests', before], ['build/gen-tests', 'blocked/await-fix', before]], undefined, { ...paused, 'waits-on': { project: 'prj', ticket: 'PRJ-9' } }),
    ticket('PRJ-54', 'Needs a look', { 'ticket-system-status': 'On Hold' }, [['committed', 'build/run-tests', before], ['build/run-tests', 'blocked-for-human', after(1)]]),
  ],
};
const held = progressSince({ sprint: pausedSprint, workflows, since });
const heldSection = title => held.sections.find(s => s.title.startsWith(`${title} (`));
const onHold = held.sections.find(s => s.title.startsWith('On Hold ('));
const subGroup = name => onHold.groups.find(g => g.title.startsWith(`${name} (`));

test('a ticket paused on purpose at any step, not Done, is On Hold under Paused on purpose, its note still saying where it is paused and what it waits for (ASS-352 AC1)', () => {
  assert.deepEqual(subGroup('Paused on purpose').bullets.map(b => b.text), [
    'PRJ-50: Verify later. Paused at the QA step.',                                       // In Testing's step
    'PRJ-51: Not started. Paused, waits for PRJ-50 to finish.',                           // To Do's, the ticket paused
    'PRJ-52: Mid build. Paused at the Run Automated Tests step.',                          // In Progress's
    'PRJ-55: Went to someone. Reassigned to Sam Lee, paused at the Generate Tests step.',  // reassigned away (ASS-345)
    'PRJ-56: Went to no one. Unassigned, paused at the Write the Plan step.',
    'PRJ-60: Requirements changed. Stopped at the Build step, being looked into.', // a requirements change's hold
    'PRJ-61: Paused after moving. Paused at the QA step.',
    'PRJ-53: Blocked and paused. Stopped at the Generate Tests step, waiting for a fix in PRJ-9.', // a blocked step, its fix noted
  ]);
  for (const title of ['In Testing', 'To Do', 'In Progress: building', 'In Progress: planning']) assert.equal(heldSection(title), undefined, title);
});

test('On Hold has Paused on purpose then Stopped until a problem is fixed, each counted and saying what it means, the heading their sum; a blocked and paused ticket once; an empty one left out (ASS-352 AC2)', () => {
  assert.equal(onHold.title, 'On Hold (9). Paused on purpose, or stopped until a problem is fixed.');
  assert.deepEqual(onHold.groups.map(g => g.title), [
    'Paused on purpose (8). Held until resumed.',
    'Stopped until a problem is fixed (1). Blocked, not paused.',
  ]);
  assert.deepEqual(subGroup('Stopped until a problem is fixed').bullets.map(b => b.key), ['PRJ-54']);
  assert.deepEqual(onHold.bullets.map(b => b.key), onHold.groups.flatMap(g => g.bullets.map(b => b.key)));
  const keys = held.sections.flatMap(s => s.bullets.map(b => b.key));
  assert.equal(keys.filter(k => k === 'PRJ-53').length, 1);
  assert.equal(new Set(keys).size, keys.length);
  const onlyStopped = progressSince({ sprint: { bugs: [pausedSprint.bugs[1]] }, workflows, since }).sections[0];
  assert.deepEqual(onlyStopped.groups.map(g => g.title), ['Stopped until a problem is fixed (1). Blocked, not paused.']);
  const onlyPaused = progressSince({ sprint: { features: [pausedSprint.features[0]] }, workflows, since }).sections[0];
  assert.deepEqual(onlyPaused.groups.map(g => g.title), ['Paused on purpose (1). Held until resumed.']);
  const lines = progressLines(held, 200);
  const at = lines.indexOf(onHold.title);
  assert.deepEqual(lines.slice(at, at + 3), [onHold.title, '  Paused on purpose (8). Held until resumed.', '  - PRJ-50: Verify later. Paused at the QA step.']);
  assert.ok(lines.includes('  Stopped until a problem is fixed (1). Blocked, not paused.'));
});

test('In Progress: held on purpose keeps only the ones worked by hand or waiting on a dependency, and control\'s pause for a fast-track (ASS-352 AC3)', () => {
  assert.deepEqual(heldSection('In Progress: held on purpose').bullets.map(b => b.text), [
    'PRJ-57: Made room. Paused for fast-tracked PRJ-99 at the Generate Tests step.',
    'PRJ-58: By hand. Worked by hand at the Setup step.',
  ]);
  assert.ok(!subGroup('Paused on purpose').bullets.some(b => b.key === 'PRJ-57'), 'a fast-track\'s pause is not on purpose');
});

test('the net line counts the paused on purpose as On Hold now and then, says how many of now\'s are, and leaves them out of the other counts (ASS-352 AC4)', () => {
  // Then: the seven paused now with no state change since (PRJ-61 moved since, so it was running then);
  // now: those, PRJ-61 and PRJ-54. Paused PRJ-61 is not in testing; only PRJ-54 was being built then.
  assert.equal(held.net, 'Net since Fri Nov 6, 04:00 UTC: 0 holds cleared; On Hold went from 7 tickets to 9, 8 of them paused on purpose. 0 tickets are actively being built or planned, down from 1. 0 in testing, 1 reached Done.');
  const one = progressSince({ sprint: { features: [pausedSprint.features[0]] }, workflows, since });
  assert.match(one.net, /On Hold went from 1 ticket to 1, paused on purpose\. .* 0 in testing,/);
  const none = progressSince({ sprint: { bugs: [pausedSprint.bugs[1]] }, workflows, since });
  assert.match(none.net, /On Hold went from 0 tickets to 1\. /);
});

test('a paused ticket that is Done is still listed under Done (ASS-352 AC5)', () => {
  assert.deepEqual(heldSection('Done').bullets.map(b => b.key), ['PRJ-59']);
});
