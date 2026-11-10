// ticket:sync — merges tickets the downloader fetched from the ticket system
// into the active sprint's sprint.json or backlog.json, owning only the
// ticket-system fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExampleEngines } from '../support/engine-walk.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// What the downloader fetches for one ticket.
const fetched = (key, extra = {}) => ({
  key, title: `Title ${key}`, description: `About ${key}`, url: `https://x.atlassian.net/browse/${key}`,
  'ticket-system-status': 'In Progress', 'ticket-system-priority': 'High', 'ticket-system-assignment': 'Ann',
  points: 3, 'issue-type': 'Story', dependencies: [], overlaps: [], 'sprint-tag': 'Sprint 10', ...extra,
});
// A sprint ticket as control left it: harness fields set, two variations, one deleted.
const existing = {
  ...fetched('ABC-1', { title: 'Old title', 'ticket-system-status': 'To Do', points: 1, 'issue-type': 'Story' }),
  priority: 2, 'manual-priority': 1, qa: { status: 'Passed' },
  variations: [
    { name: 'A', 'harness-status': { state: 'generate-solution', 'state-engine': 'example-development' }, 'merge-request': [{ key: '!1', 'build-status': 'Pending', url: 'u1' }], 'acceptance-criteria': [{ 'criteria-number': 1 }], 'state-changes': [{ 'to-state': 'generate-solution' }], 'is-paused': true },
    { name: 'B', 'is-deleted': true, 'harness-status': { state: 'backlog', 'state-engine': 'example-development' }, 'merge-request': [{ key: '!2', 'build-status': 'Failed', url: 'u2' }] },
  ],
};

// A projects/ folder whose project p has sprint 10 active holding ABC-1 (feature) and ABC-2 (bug, priority 5), and a backlog of one.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'sync-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ 'execution-state-engine': 'example-development', 'work-sources': [{ type: 'off-board' }, { type: 'jira', url: 'https://x' }] }));
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10, start: '2026-09-26',
    features: [existing],
    bugs: [{ ...fetched('ABC-2', { 'issue-type': 'Bug' }), priority: 5, 'manual-priority': null, qa: { status: null }, variations: [{ name: 'A', 'harness-status': { state: 'backlog', 'state-engine': 'example-development' } }] }],
    spikes: [],
  }, null, 4));
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify({ tickets: [{ ...fetched('ABC-9'), priority: 1, 'manual-backlog-priority': null, variations: [{ name: 'A', 'harness-status': refined('ready') }] }] }, null, 4));
  withExampleEngines(join(dir, 'p'));   // p's own example-development and its refinement (ASS-276)
  return dir;
}
// A harness-status at `state` of p's backlog refinement engine, the one its execution engine (the example project's own example-development) names.
function refined(state) { return { state, 'state-engine': 'example-backlog-refinement' }; }
const file = (dir, data) => { const f = join(dir, 'fetched.json'); writeFileSync(f, JSON.stringify(data)); return f; };
const sync = (dir, ...args) => run(AGENT, ['ticket:sync', ...args], { env: { ...process.env, PROJECTS_DIR: dir, ACLI_DISABLED: '1' } });
const sprint = dir => JSON.parse(readFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8'));
const backlog = dir => JSON.parse(readFileSync(join(dir, 'p', 'backlog.json'), 'utf8'));

test('ticket:sync overwrites only the ticket-system fields of a ticket already there, and adds the scan\'s new merge requests for it to a live variation', async () => {
  const dir = projects();
  const mrs = [{ key: '!7', 'build-status': 'Passed', url: 'u7', ticket: 'ABC-1' }];
  const { stdout } = await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('abc-1', { dependencies: ['ABC-2'], overlaps: ['ABC-2'], 'ticket-system-assignment': null })], 'merge-requests': mrs }));
  assert.equal(stdout.trim(), 'synced 1 tickets (0 new)');
  const s = sprint(dir);
  assert.deepEqual([s.number, s.start, s.bugs.length, s.spikes.length], [10, '2026-09-26', 1, 0]);
  const [t] = s.features;
  assert.equal(t.key, 'ABC-1');                                   // the key as the file had it
  assert.deepEqual([t.title, t['ticket-system-status'], t.points, t.dependencies, t['ticket-system-assignment']], ['Title abc-1', 'In Progress', 3, ['ABC-2'], null]);
  assert.deepEqual(t.overlaps, ['ABC-2']);                        // ASS-196: overlaps carried onto the synced ticket, for the TUI
  assert.deepEqual([t.priority, t['manual-priority'], t.qa], [2, 1, { status: 'Passed' }]);
  const [a, b] = t.variations;
  assert.deepEqual({ ...a, 'merge-request': undefined }, { ...existing.variations[0], 'merge-request': undefined });
  assert.deepEqual(a['merge-request'], [...existing.variations[0]['merge-request'], { key: '!7', 'build-status': 'Passed', url: 'u7' }]);
  assert.deepEqual(b, existing.variations[1]);                     // deleted: untouched, merge requests included
});

test('ticket:sync leaves merge requests alone when the file has none for the key, and tickets missing from the fetch alone', async () => {
  const dir = projects();
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-2', { 'issue-type': 'Bug', title: 'Bug title' })] }));
  const s = sprint(dir);
  assert.deepEqual(s.features, [existing]);
  assert.equal(s.bugs[0].title, 'Bug title');
  assert.equal(s.bugs[0].priority, 5);
});

test('ASS-344 AC1, AC2: ticket:sync carries ticket-system-assignment-id as a ticket-system field: a reassigned ticket takes the new holder\'s name and account id, an unassigned one both null; a ticket fetched without the key (off-board) gets none and keeps what it has', async () => {
  const dir = projects();
  const mine = { 'ticket-system-assignment': 'Ann', 'ticket-system-assignment-id': 'acc-ann' };
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', mine), fetched('ABC-2', { 'issue-type': 'Bug', ...mine })] }));
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', mine)] }));
  assert.deepEqual([sprint(dir).features[0]['ticket-system-assignment-id'], sprint(dir).bugs[0]['ticket-system-assignment-id'], backlog(dir).tickets[0]['ticket-system-assignment-id']], ['acc-ann', 'acc-ann', 'acc-ann']);
  // Reassigned (AC1) and unassigned (AC2) in Jira, read by key and synced like any other.
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [
    fetched('ABC-1', { 'ticket-system-assignment': 'Bea Other', 'ticket-system-assignment-id': 'acc-bea' }),
    fetched('ABC-2', { 'issue-type': 'Bug', 'ticket-system-assignment': null, 'ticket-system-assignment-id': null }),
  ] }));
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { 'ticket-system-assignment': null, 'ticket-system-assignment-id': null })] }));
  const s = sprint(dir), b = backlog(dir);
  assert.deepEqual([s.features[0]['ticket-system-assignment'], s.features[0]['ticket-system-assignment-id']], ['Bea Other', 'acc-bea']);
  assert.deepEqual([s.features[0].priority, s.features[0]['manual-priority'], s.features[0].qa], [2, 1, { status: 'Passed' }]);   // the harness's fields stay
  assert.deepEqual([s.bugs[0]['ticket-system-assignment'], s.bugs[0]['ticket-system-assignment-id']], [null, null]);
  assert.deepEqual([b.tickets[0]['ticket-system-assignment'], b.tickets[0]['ticket-system-assignment-id']], [null, null]);
  // An off-board ticket (no such key fetched): new, it has none; one already there keeps its own.
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('HD-1', { 'ticket-system-assignment': null }), fetched('ABC-1', { 'ticket-system-assignment': 'Bea Other' })] }));
  const after = sprint(dir);
  assert.equal('ticket-system-assignment-id' in after.features.find(t => t.key === 'HD-1'), false);
  assert.equal(after.features.find(t => t.key === 'ABC-1')['ticket-system-assignment-id'], 'acc-bea');
});

test('ticket:sync adds a new ticket in the full shape, ranked last, one variation A at the step its ticket-system status pairs with', async () => {
  const dir = projects();
  const { stdout } = await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-3', { 'issue-type': 'Spike' }), fetched('ABC-4', { 'issue-type': 'Bug' })], 'merge-requests': [{ key: '!3', 'build-status': 'Running', url: 'u3', ticket: 'abc-3' }, { key: '!4', 'build-status': 'Running', url: 'u4', ticket: null }] }));
  assert.equal(stdout.trim(), 'synced 2 tickets (2 new)');
  const s = sprint(dir);
  assert.deepEqual(s.spikes.map(t => t.key), ['ABC-3']);
  assert.deepEqual(s.bugs.map(t => t.key), ['ABC-2', 'ABC-4']);
  assert.deepEqual([s.spikes[0].priority, s.bugs[1].priority], [6, 7]);
  assert.deepEqual(s.bugs[1].variations[0]['merge-request'], []);       // !4 belongs to no ticket
  assert.deepEqual(s.spikes[0], {
    ...fetched('ABC-3', { 'issue-type': 'Spike' }), priority: 6, 'manual-priority': null, qa: { status: null },
    variations: [{
      name: 'A', 'ai-feedback-short': null, 'ai-feedback-long': null,
      'harness-status': { state: 'enrich-ac', 'state-engine': 'example-development' },     // In Progress: the first step it pairs with
      build: { branch: null, 'branch-url': null, worktree: null, 'worktree-folder': null },
      'local-testing': {}, 'acceptance-criteria': [], 'merge-request': [{ key: '!3', 'build-status': 'Running', url: 'u3' }],
      'gate-when-leaving-state': [], 'is-paused': false, 'human-review': null, 'ai-variation-feedback': null, 'state-changes': [],
    }],
  });
});

test('ticket:sync starts a new sprint ticket where its ticket-system status says it is: the earliest pipeline step paired with it, else a quarantine one (a human step first), else backlog', async () => {
  const dir = projects();
  rmSync(join(dir, 'p', 'engines'), { recursive: true });   // p runs this test's own example-development, from ENGINES_DIR
  const engines = join(dir, 'engines');
  mkdirSync(join(engines, 'example-development'), { recursive: true });
  const step = (id, sequence, paired, extra = {}) => ({ id, sequence, 'paired-ticket-system-status': paired, action: { type: 'none' }, ...extra });
  writeFileSync(join(engines, 'example-development', 'state-engine.json'), JSON.stringify({ steps: [
    step('fix', 0, 'In Progress', { area: 'quarantine', action: { type: 'state-engine', engine: 'x' } }),
    step('blocked', 0, 'On Hold', { area: 'quarantine', action: { type: 'state-engine', engine: 'blocked' } }),
    step('blocked-for-human', 0, 'On Hold', { area: 'quarantine', action: { type: 'human' } }),
    step('backlog', 1, 'Backlog'), step('committed', 2, 'To Do'), step('review', 4, 'In Progress'), step('build', 3, 'In Progress'),
    step('qa', 5, 'In Testing'), step('done', 6, 'Done'),
  ] }));
  const statuses = { 'ABC-11': 'Done', 'ABC-12': 'In Progress', 'ABC-13': 'To Do', 'ABC-14': 'On Hold', 'ABC-15': 'In Review', 'ABC-16': 'Backlog', 'ABC-17': 'In Testing' };
  await run(AGENT, ['ticket:sync', 'p', 'sprint', file(dir, { tickets: Object.entries(statuses).map(([key, status]) => fetched(key, { 'ticket-system-status': status })) })], { env: { ...process.env, PROJECTS_DIR: dir, ENGINES_DIR: engines } });
  const at = Object.fromEntries(sprint(dir).features.filter(t => t.key in statuses).map(t => [t.key, t.variations[0]['harness-status'].state]));
  assert.deepEqual(at, { 'ABC-11': 'done', 'ABC-12': 'build', 'ABC-13': 'committed', 'ABC-14': 'blocked-for-human', 'ABC-15': 'backlog', 'ABC-16': 'backlog', 'ABC-17': 'qa' });
  assert.equal(sprint(dir).features.find(t => t.key === 'ABC-1').variations[0]['harness-status'].state, 'generate-solution');   // a ticket already there keeps its state
});

test('ticket:sync moves a ticket whose issue type changed to the matching array, keeping its harness fields', async () => {
  const dir = projects();
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { 'issue-type': 'Bug' })] }));
  const s = sprint(dir);
  assert.deepEqual(s.features, []);
  assert.deepEqual(s.bugs.map(t => t.key), ['ABC-2', 'ABC-1']);
  assert.deepEqual([s.bugs[1]['issue-type'], s.bugs[1].priority, s.bugs[1].variations.length], ['Bug', 2, 2]);
});

test('ticket:sync backlog merges into backlog.json, a new ticket at its refinement engine\'s first step; a ready ticket whose requirements change goes back there, stamped (ASS-144 AC5)', async () => {
  const dir = projects();
  const { stdout } = await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { title: 'New title' }), fetched('ABC-10', { 'issue-type': 'Bug' })] }));
  assert.equal(stdout.trim(), 'synced 2 tickets (1 new)');
  const { tickets } = backlog(dir);
  assert.deepEqual(tickets.map(t => [t.key, t.priority, t.title]), [['ABC-9', 1, 'New title'], ['ABC-10', 2, 'Title ABC-10']]);
  assert.deepEqual(tickets[0].variations[0]['harness-status'], refined('groom'));   // was ready: its title changed
  assert.match(tickets[0]['changed-at'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(tickets[1].variations[0]['harness-status'], refined('groom'));
  assert.deepEqual(tickets[1].variations[0]['state-changes'], []);
  assert.equal(tickets[1]['issue-type'], 'Bug');
  // Synced again unchanged, a ready ticket stays ready.
  const ready = backlog(dir);
  ready.tickets[1].variations[0]['harness-status'].state = 'ready';
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(ready));
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { title: 'New title' }), fetched('ABC-10', { 'issue-type': 'Bug' })] }));
  assert.equal(backlog(dir).tickets[1].variations[0]['harness-status'].state, 'ready');
});

test('ticket:sync gives a new backlog ticket manual-backlog-priority null and no manual-priority, and keeps a backlog ticket\'s manual-backlog-priority (ASS-100 AC7)', async () => {
  const dir = projects();
  const was = backlog(dir);
  was.tickets[0]['manual-backlog-priority'] = 1;
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(was));
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9'), fetched('ABC-10')] }));
  const [kept, added] = backlog(dir).tickets;
  assert.equal(kept['manual-backlog-priority'], 1);
  assert.equal(added['manual-backlog-priority'], null);
  assert.equal('manual-priority' in added, false);
});

test('ticket:sync renumbers the backlog after a backlog sync: each priority is its place in control\'s refinement order (ASS-84 AC1)', async () => {
  const dir = projects();
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9'), fetched('ABC-10', { 'ticket-system-priority': 'Highest' })] }));
  assert.deepEqual(backlog(dir).tickets.map(t => [t.key, t.priority]), [['ABC-9', 2], ['ABC-10', 1]]);   // arrival order would have given ABC-10 2
});

test('ticket:sync brings a ticket into the sprint without its backlog rank: manual-priority null, no manual-backlog-priority; the backlog is renumbered without it, its backlog entry kept as it was (ASS-100 AC3, ASS-84 AC4)', async () => {
  const dir = projects();
  const was = backlog(dir);
  was.tickets = [{ ...was.tickets[0], priority: 7, 'manual-backlog-priority': 1 }, { ...fetched('ABC-11'), priority: 9, 'manual-backlog-priority': null }];
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(was));
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-9')] }));
  const joined = sprint(dir).features.find(t => t.key === 'ABC-9');
  assert.equal(joined['manual-priority'], null);
  assert.equal('manual-backlog-priority' in joined, false);
  assert.deepEqual(backlog(dir).tickets.map(t => [t.key, t.priority, t['manual-backlog-priority']]), [['ABC-9', 7, 1], ['ABC-11', 1, null]]);
});

test('ticket:sync sends a backlog ticket whose description changed at a resting step — a human step or the done step — back to its engine\'s first step, the move recorded; one at a mid-run step is left there, stamped, for control (ASS-144 Q7)', async () => {
  for (const [state, after] of [['awaiting-answers', 'groom'], ['awaiting-approval', 'groom'], ['ready', 'groom'], ['groom', 'groom'], ['check-answers', 'check-answers'], ['estimate', 'estimate']]) {
    const dir = projects();
    const was = backlog(dir);
    was.tickets[0].variations[0]['harness-status'].state = state;
    writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(was));
    await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { description: 'Changed' })] }));
    const [t] = backlog(dir).tickets;
    assert.deepEqual(t.variations[0]['harness-status'], refined(after), state);
    assert.match(t['changed-at'], /^\d{4}-/, state);
    assert.deepEqual((t.variations[0]['state-changes'] ?? []).map(c => [c['from-state'], c['to-state'], c['state-engine']]), state === after ? [] : [[state, after, 'example-backlog-refinement']], state);
  }
});

const history = (dir, key) => join(dir, 'p', 'work', key, 'requirements-history.jsonl');
const lines = f => readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('ticket:sync appends each changed title or description, in a sprint or the backlog, to the ticket\'s requirements-history.jsonl (ASS-38)', async () => {
  const dir = projects();
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('abc-1', { description: 'About ABC-1' })] }));   // title was Old title; description the same
  const [entry, ...rest] = lines(history(dir, 'ABC-1'));                       // the key as the file had it
  assert.deepEqual(rest, []);
  assert.deepEqual({ ...entry, at: undefined }, { at: undefined, field: 'title', from: 'Old title', to: 'Title abc-1' });
  assert.match(entry.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { title: 'T2', description: 'D2' })] }));
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { description: 'D3' })] }));
  assert.deepEqual(lines(history(dir, 'ABC-9')).map(({ field, from, to }) => [field, from, to]),
    [['title', 'Title ABC-9', 'T2'], ['description', 'About ABC-9', 'D2'], ['title', 'T2', 'Title ABC-9'], ['description', 'D2', 'D3']]);
});

test('ticket:sync appends nothing for an unchanged ticket or a first sight (ASS-38)', async () => {
  const dir = projects();
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-2', { 'issue-type': 'Bug', 'ticket-system-status': 'Done' }), fetched('ABC-3', { title: 'Brand new' })] }));
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-1', { title: 'Edited on its way out' })] }));   // in the sprint, new to the backlog
  for (const key of ['ABC-2', 'ABC-3', 'ABC-1']) assert.equal(existsSync(history(dir, key)), false, key);
});

// A sprint whose ABC-1 has variations at the given states ({ name: [state, is-paused, is-deleted] }).
function sprintAt(dir, states, extra = {}) {
  const s = sprint(dir);
  s.features[0] = { ...s.features[0], ...extra, variations: Object.entries(states).map(([name, [state, paused = false, deleted = false]]) => ({
    name, 'harness-status': { state, 'state-engine': 'example-development' }, 'is-paused': paused, ...(deleted ? { 'is-deleted': true } : {}),
  })) };
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(s));
}
const abc1 = dir => sprint(dir).features.find(t => t.key === 'ABC-1');

test('ticket:sync holds a sprint ticket\'s changed description as its pending-requirements-change, keeping the current one (ASS-77 AC1)', async () => {
  const dir = projects();
  sprintAt(dir, { A: ['generate-solution'] });
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { description: 'New requirements' })] }));
  const t = abc1(dir);
  assert.equal(t.description, 'About ABC-1');
  assert.equal(t['pending-requirements-change'].description, 'New requirements');
  assert.match(t['pending-requirements-change']['detected-at'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('ticket:sync pauses each variation actively worked when it holds a description change, listing only those it paused (ASS-77 AC2)', async () => {
  const dir = projects();
  sprintAt(dir, { A: ['generate-solution'], B: ['blocked'], C: ['enrich-ac', true], D: ['backlog'], E: ['committed'], F: ['done'], G: ['generate-solution', false, true] });
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { description: 'New requirements' })] }));
  const t = abc1(dir);
  assert.deepEqual(Object.fromEntries(t.variations.map(v => [v.name, v['is-paused']])), { A: true, B: true, C: true, D: false, E: false, F: false, G: false });
  assert.deepEqual(t['pending-requirements-change']['paused-variations'], ['A', 'B']);
});

test('ticket:sync leaves a pending change alone while the fetched description stays the same, and replaces it when it changes again, pausing the variations active since (ASS-77)', async () => {
  const dir = projects();
  sprintAt(dir, { A: ['generate-solution'], B: ['committed'] });
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { description: 'New requirements' })] }));
  const first = abc1(dir)['pending-requirements-change'];
  // The operator resumes A and B moves on; the same description again changes nothing.
  const s = sprint(dir);
  s.features[0].variations[0]['is-paused'] = false;
  s.features[0].variations[1]['harness-status'].state = 'write-execution-plan';
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(s));
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { description: 'New requirements' })] }));
  let t = abc1(dir);
  assert.deepEqual(t['pending-requirements-change'], first);
  assert.deepEqual(t.variations.map(v => v['is-paused']), [false, false]);
  // A third description replaces the pending one and pauses both.
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { description: 'Newer requirements' })] }));
  t = abc1(dir);
  assert.equal(t.description, 'About ABC-1');
  assert.equal(t['pending-requirements-change'].description, 'Newer requirements');
  assert.deepEqual(t['pending-requirements-change']['paused-variations'], ['A', 'B']);
  assert.deepEqual(t.variations.map(v => v['is-paused']), [true, true]);
});

test('ticket:sync syncs a sprint ticket\'s changed title straight away, never holding it or pausing (ASS-77 AC3)', async () => {
  const dir = projects();
  sprintAt(dir, { A: ['generate-solution'] });
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { title: 'Renamed', description: 'About ABC-1' })] }));
  const t = abc1(dir);
  assert.equal(t.title, 'Renamed');
  assert.equal(t['pending-requirements-change'], undefined);
  assert.equal(t.variations[0]['is-paused'], false);
});

test('ticket:sync appends a held description change to the requirements history once, not on every sync that sees it again (ASS-77)', async () => {
  const dir = projects();
  sprintAt(dir, { A: ['generate-solution'] });
  for (const description of ['D2', 'D2', 'D3', 'D3']) await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { title: 'Old title', description })] }));
  assert.deepEqual(lines(history(dir, 'ABC-1')).map(({ field, from, to }) => [field, from, to]),
    [['description', 'About ABC-1', 'D2'], ['description', 'D2', 'D3']]);
});

test('ticket:sync keeps a delivered (Done) sprint ticket\'s description, holds nothing, and comments once per changed description on the ticket (ASS-77 AC4)', async () => {
  const dir = projects();
  sprintAt(dir, { A: ['done'] }, { 'ticket-system-status': 'Done' });
  // A fake acli on PATH that logs each comment's key and body.
  const bin = join(dir, 'bin'), log = join(dir, 'comments.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'acli'), `#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do case "$1" in --key) k="$2"; shift;; --body-file) b="$(cat "$2")"; shift;; esac; shift; done\necho "$k: $b" >> '${log}'\n`);
  chmodSync(join(bin, 'acli'), 0o755);
  const delivered = (extra = {}) => run(AGENT, ['ticket:sync', 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { 'ticket-system-status': 'Done', ...extra })] })],
    { env: { ...process.env, PROJECTS_DIR: dir, PATH: `${bin}:${process.env.PATH}` } });
  await delivered({ title: 'Renamed', description: 'After delivery' });
  await delivered({ title: 'Renamed', description: 'After delivery' });
  const t = abc1(dir);
  assert.deepEqual([t.title, t.description, t['pending-requirements-change'], t.variations[0]['is-paused']], ['Renamed', 'About ABC-1', undefined, false]);
  assert.equal(readFileSync(log, 'utf8'), 'ABC-1: DETECTED CHANGING REQUIREMENTS AFTER TICKET IS ALREADY DELIVERED\n');
  await delivered({ title: 'Renamed', description: 'Changed again' });
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
});

test('ticket:sync still applies a backlog ticket\'s changed description, sending it back to its first step and holding nothing (ASS-77 AC5)', async () => {
  const dir = projects();
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { description: 'Changed' })] }));
  const [t] = backlog(dir).tickets;
  assert.deepEqual([t.description, t['pending-requirements-change'], t.variations[0]['harness-status'].state], ['Changed', undefined, 'groom']);
  assert.deepEqual(lines(history(dir, 'ABC-9')).map(({ field, from, to }) => [field, from, to]), [['description', 'About ABC-9', 'Changed']]);
});

test('ticket:sync fails, writing nothing, on a bad target, file, project or usage', async () => {
  const dir = projects();
  const before = readFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8');
  await assert.rejects(sync(dir, 'p', 'sprint'), /usage/);
  await assert.rejects(sync(dir, 'p', 'epic', file(dir, { tickets: [] })), /sprint\|backlog/);
  await assert.rejects(sync(dir, 'p', 'sprint', join(dir, 'missing.json')), /no file/);
  await assert.rejects(sync(dir, 'p', 'sprint', file(dir, { tickets: [{ title: 'no key' }] })), /key/);
  await assert.rejects(sync(dir, '../p', 'sprint', file(dir, { tickets: [] })), /invalid project/);
  assert.equal(readFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8'), before);
});

test('ticket:sync keeps a variation\'s planned merge requests (ASS-80), filling each from the scan\'s new one on its branch; its other records stay and the rest are added', async () => {
  const dir = projects();
  const planned = (id, extra = {}) => ({ id, repository: 'https://gitlab.com/g/app', branch: `change/ABC-2-${id}`, contents: `part ${id}`, 'depends-on': [], status: 'Not Created', key: null, url: null, 'build-status': null, ...extra });
  const s0 = sprint(dir);
  s0.bugs[0].variations[0]['merge-request'] = [planned(1), planned(2), { key: '!1', 'build-status': 'Pending', url: 'u1' }];
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(s0));
  const mrs = [
    { key: '!8', 'build-status': 'Passed', url: 'u8', status: 'Merged', branch: 'change/abc-2-1', ticket: 'ABC-2' },
    { key: '!9', 'build-status': 'Running', url: 'u9', status: 'Open', branch: 'change/ABC-2', ticket: 'ABC-2' },
  ];
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-2', { 'issue-type': 'Bug' })], 'merge-requests': mrs }));
  assert.deepEqual(sprint(dir).bugs[0].variations[0]['merge-request'], [
    planned(1, { key: '!8', 'build-status': 'Passed', url: 'u8', status: 'Merged' }),
    planned(2),
    { key: '!1', 'build-status': 'Pending', url: 'u1' },
    { key: '!9', 'build-status': 'Running', url: 'u9', status: 'Open', branch: 'change/ABC-2' },
  ]);
});

// A merge request as the downloader's scan sends it (ASS-92/98): every one it fetched, each with the ticket it belongs to, or null.
const scanned = (iid, ticket, extra = {}) => ({ key: `!${iid}`, 'build-status': 'Passed', url: `https://gitlab.com/g/p/-/merge_requests/${iid}`, status: 'Open', branch: `change/${ticket ?? 'other'}`, ticket, ...extra });
const variationMrs = (dir, key) => [...sprint(dir).features, ...sprint(dir).bugs].find(t => t.key === key).variations.map(v => v['merge-request']);

test('ticket:sync never removes a recorded merge request the scan did not return (ASS-92 AC3, ASS-98 AC3)', async () => {
  const dir = projects();
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1')], 'merge-requests': [scanned(7, null)] }));
  assert.deepEqual(variationMrs(dir, 'ABC-1'), existing.variations.map(v => v['merge-request']));
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1')], 'merge-requests': [] }));
  assert.deepEqual(variationMrs(dir, 'ABC-1'), existing.variations.map(v => v['merge-request']));
});

// Sprint ticket ABC-1 with variations A and B (live) and C (deleted), each recording its own merge request.
function variations(dir) {
  const s = sprint(dir);
  s.features[0].variations = [
    { name: 'A', build: { branch: 'change/ABC-1' }, 'merge-request': [{ key: '!1', 'build-status': 'Running', url: 'https://gitlab.com/g/p/-/merge_requests/1', status: 'Open' }] },
    { name: 'B', build: { branch: null }, 'merge-request': [{ key: '!2', 'build-status': 'Running', url: 'https://gitlab.com/g/p/-/merge_requests/2', status: 'Open' }] },
    { name: 'C', 'is-deleted': true, 'merge-request': [{ key: '!3', 'build-status': 'Running', url: 'https://gitlab.com/g/p/-/merge_requests/3', status: 'Open' }] },
  ];
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(s));
}

test('ticket:sync keeps each variation\'s own merge request when the scan returns them all for the ticket (ASS-92 AC2)', async () => {
  const dir = projects();
  variations(dir);
  const before = variationMrs(dir, 'ABC-1');
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1')], 'merge-requests': [
    scanned(2, 'ABC-1', { branch: 'change/ABC-1.B', 'build-status': 'Running' }), scanned(1, 'ABC-1', { 'build-status': 'Running' }), scanned(3, 'ABC-1', { 'build-status': 'Running' }),
  ] }));
  assert.deepEqual(variationMrs(dir, 'ABC-1'), before);
});

test('ticket:sync refreshes a recorded merge request from the scanned one with its url, whatever ticket the scan gave it (ASS-92 AC4)', async () => {
  const dir = projects();
  variations(dir);
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1')], 'merge-requests': [
    scanned(1, null, { 'build-status': 'Merged', status: 'Merged', url: 'https://GitLab.com/g/p/-/merge_requests/1/' }),
    scanned(2, 'ABC-7', { 'build-status': 'Failed' }),
    scanned(3, 'ABC-1', { 'build-status': 'Merged', status: 'Merged' }),
    { ...scanned(1, 'ABC-1', { 'build-status': 'Passed' }), url: 'https://gitlab.com/other/repo/-/merge_requests/1', key: '!1' },   // the same iid in another repository
  ] }));
  const [a, b, c] = variationMrs(dir, 'ABC-1');
  assert.deepEqual(a, [{ key: '!1', 'build-status': 'Merged', url: 'https://GitLab.com/g/p/-/merge_requests/1/', status: 'Merged' },
    { key: '!1', 'build-status': 'Passed', url: 'https://gitlab.com/other/repo/-/merge_requests/1', status: 'Open', branch: 'change/ABC-1' }]);
  assert.deepEqual(b, [{ key: '!2', 'build-status': 'Failed', url: 'https://gitlab.com/g/p/-/merge_requests/2', status: 'Open' }]);
  assert.equal(c[0]['build-status'], 'Running');                  // a deleted variation is left alone
});

test('ticket:sync adds a new merge request to the variation on its branch, else the first live one; one a deleted variation records is not added again', async () => {
  const dir = projects();
  variations(dir);
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1')], 'merge-requests': [
    scanned(5, 'ABC-1', { branch: 'CHANGE/abc-1.b' }), scanned(6, 'ABC-1', { branch: 'feature/x' }), scanned(3, 'ABC-1'),
  ] }));
  const [a, b] = variationMrs(dir, 'ABC-1');
  assert.deepEqual(a.map(m => m.key), ['!1', '!6']);
  assert.deepEqual(b.map(m => m.key), ['!2', '!5']);
});

test('ticket:sync records a scanned merge request only on the ticket the scan gave it, whatever its title says (ASS-92 AC1)', async () => {
  const dir = projects();
  const s0 = sprint(dir);
  s0.features[0].variations[0]['merge-request'] = [];
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(s0));
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1'), fetched('ABC-2', { 'issue-type': 'Bug' })], 'merge-requests': [
    scanned(9, 'ABC-2', { title: 'X (ABC-1 producer)', branch: 'change/ABC-2' }),
  ] }));
  assert.deepEqual(variationMrs(dir, 'ABC-1')[0], []);
  assert.deepEqual(variationMrs(dir, 'ABC-2')[0].map(m => m.key), ['!9']);
});

test('ticket:sync refreshes the recorded merge requests of a sprint ticket missing from the fetch too, and changes nothing else of it — never adds one (ASS-122 AC1)', async () => {
  const dir = projects();
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-2', { 'issue-type': 'Bug' })], 'merge-requests': [
    { key: '!1', 'build-status': 'Merged', url: 'U1/', status: 'Merged', branch: 'change/ABC-1', ticket: null },
    { key: '!8', 'build-status': 'Passed', url: 'u8', status: 'Open', branch: 'change/ABC-1', ticket: 'ABC-1' },
  ] }));
  const [t] = sprint(dir).features;
  assert.deepEqual(t, { ...existing, variations: [
    { ...existing.variations[0], 'merge-request': [{ key: '!1', 'build-status': 'Merged', url: 'U1/', status: 'Merged' }] },
    existing.variations[1],                                      // a deleted variation is left alone
  ] });
});

// ASS-128: a list read before control set a ticket's status does not take it back.
const stamped = (dir, at) => {
  const s = sprint(dir);
  s.features[0] = { ...s.features[0], 'ticket-system-status': 'Committed', 'ticket-system-status-at': at };
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(s, null, 4));
};

test('ticket:sync keeps a sprint ticket\'s status set after its list was read (fetched-at), and takes the rest of the ticket from the list (ASS-128 AC3)', async () => {
  const dir = projects();
  stamped(dir, '2026-10-24T19:21:47Z');
  await sync(dir, 'p', 'sprint', file(dir, { 'fetched-at': '2026-10-24T19:20:20.512Z', tickets: [fetched('ABC-1', { 'ticket-system-status': 'To Do', title: 'New title' })] }));
  const [t] = sprint(dir).features;
  assert.deepEqual([t['ticket-system-status'], t['ticket-system-status-at'], t.title], ['Committed', '2026-10-24T19:21:47Z', 'New title']);
});

test('ticket:sync replaces a sprint ticket\'s status from a list read after it was set, or from one with no fetched-at (an older caller, a manual sync) (ASS-128 AC3)', async () => {
  const status = async data => {
    const dir = projects();
    stamped(dir, '2026-10-24T19:21:47Z');
    await sync(dir, 'p', 'sprint', file(dir, { ...data, tickets: [fetched('ABC-1', { 'ticket-system-status': 'Done' })] }));
    return sprint(dir).features[0]['ticket-system-status'];
  };
  assert.equal(await status({ 'fetched-at': '2026-10-24T19:21:48.001Z' }), 'Done');
  assert.equal(await status({}), 'Done');
  assert.equal(await status({ 'fetched-at': '2026-10-24T19:21:47.900Z' }), 'Committed');   // the same second: the sprint's, the next list settles it
});

test('ticket:sync replaces a status never stamped, and a backlog sync takes the list\'s status whatever its fetched-at (ASS-128)', async () => {
  const dir = projects();
  await sync(dir, 'p', 'sprint', file(dir, { 'fetched-at': '2000-01-01T00:00:00Z', tickets: [fetched('ABC-1', { 'ticket-system-status': 'Done' })] }));
  assert.equal(sprint(dir).features[0]['ticket-system-status'], 'Done');
  const b = backlog(dir);
  b.tickets[0]['ticket-system-status-at'] = '2026-10-24T19:21:47Z';
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(b, null, 4));
  await sync(dir, 'p', 'backlog', file(dir, { 'fetched-at': '2000-01-01T00:00:00Z', tickets: [fetched('ABC-9', { 'ticket-system-status': 'Backlog' })] }));
  assert.equal(backlog(dir).tickets[0]['ticket-system-status'], 'Backlog');
});

// ASS-42: the reset a requirements change makes is no step's exit, so its history entry says so.
test('ASS-42 AC2: ticket:sync\'s reset of a changed backlog ticket records cause requirements-changed', async () => {
  const dir = projects();
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { description: 'Changed' })] }));
  const [change] = backlog(dir).tickets[0].variations[0]['state-changes'];
  assert.deepEqual([change['from-state'], change['to-state'], change.cause], ['ready', 'groom', 'requirements-changed']);
});

// ASS-42 AC1: the backlog entry and the sprint entry are two objects; joining the sprint copies no history.
test('ASS-42 AC1: a ticket joining the sprint keeps its refinement history on its backlog entry, and starts the sprint with none', async () => {
  const dir = projects();
  const was = backlog(dir);
  const history = [{ 'state-engine': 'example-backlog-refinement', 'from-state': 'awaiting-approval', 'to-state': 'ready', timestamp: '2026-10-20T00:00:00Z', 'agent-dispatch-log': [], 'work-is-done': false, cause: 'operator' }];
  was.tickets[0].variations[0]['state-changes'] = history;
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(was));
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-9')] }));
  assert.deepEqual(backlog(dir).tickets[0].variations[0]['state-changes'], history);
  assert.deepEqual(sprint(dir).features.find(t => t.key === 'ABC-9').variations.map(v => v['state-changes']), [[]]);
});

// ASS-152 AC3: a local estimate (ticket:set-points: points with points-set-at)
// is never overwritten with null while the ticket system's copy is pending
// (it still shows null) or unread (the fetched ticket has no points).
test('ticket:sync keeps a local estimate while the ticket system shows null or its points went unread, and drops the pending mark once it shows a number (ASS-152 AC3)', async () => {
  const dir = projects();
  const edit = change => { const b = backlog(dir); change(b.tickets[0]); writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(b)); };
  const { points: _, ...unread } = fetched('ABC-9');
  const at = () => backlog(dir).tickets[0];
  edit(t => { t.points = 5; t['points-set-at'] = '2026-10-26T10:00:00Z'; });
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { points: null })] }));
  assert.deepEqual([at().points, at()['points-set-at']], [5, '2026-10-26T10:00:00Z']);          // pending: Jira still shows null
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [unread] }));
  assert.equal(at().points, 5);                                                                   // unread
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { points: 5 })] }));
  assert.deepEqual([at().points, 'points-set-at' in at()], [5, false]);                          // written: no longer pending
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { points: null })] }));
  assert.equal(at().points, null);                                                                // cleared in the ticket system afterwards: taken
  edit(t => { t.points = 2; });
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [unread] }));
  assert.equal(at().points, 2);                                                                   // unread never clears points
  const { points: __, ...unreadNew } = fetched('ABC-77');
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [unreadNew] }));
  assert.equal(backlog(dir).tickets.find(t => t.key === 'ABC-77').points, null);                  // a new ticket unread: none yet
});

// ASS-322 AC3: a ticket whose links went unread (no dependencies key) keeps the
// harness's dependencies; a fetched list, even [], is taken.
test('ticket:sync keeps a ticket\'s dependencies when the fetched ticket left them unread, and takes a fetched list, [] included (ASS-322 AC3)', async () => {
  const dir = projects();
  const edit = change => { const b = backlog(dir); change(b.tickets[0]); writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(b)); };
  const { dependencies: _, ...unread } = fetched('ABC-9');
  const at = () => backlog(dir).tickets[0];
  edit(t => { t.dependencies = ['ABC-2']; });
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [unread] }));
  assert.deepEqual(at().dependencies, ['ABC-2']);                                                 // unread: kept
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { dependencies: ['ABC-3'] })] }));
  assert.deepEqual(at().dependencies, ['ABC-3']);                                                 // read: taken
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { dependencies: [] })] }));
  assert.deepEqual(at().dependencies, []);                                                        // cleared in the ticket system: taken
  edit(t => { delete t.dependencies; });
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [unread] }));
  assert.deepEqual(at().dependencies, []);                                                        // none before, unread: none
  const { dependencies: __, ...unreadNew } = fetched('ABC-77');
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [unreadNew] }));
  assert.deepEqual(backlog(dir).tickets.find(t => t.key === 'ABC-77').dependencies, []);          // a new ticket unread: none yet
});

// ASS-166: a ticket worked by hand (ticket:set-manual's worked-manually) has its data synced, and nothing held or moved.
const MANUAL = { 'worked-manually': { by: 'alice', since: '2026-10-27T10:00:00Z', note: null } };

test('ASS-166 AC2: ticket:sync updates a sprint ticket worked by hand — title, description, status — holding no requirements change and pausing nothing', async () => {
  const dir = projects();
  sprintAt(dir, { A: ['generate-solution'] }, MANUAL);
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { title: 'New title', description: 'New requirements', 'ticket-system-status': 'In Review' })] }));
  const t = abc1(dir);
  assert.deepEqual([t.title, t.description, t['ticket-system-status']], ['New title', 'New requirements', 'In Review']);
  assert.deepEqual([t['pending-requirements-change'], t.variations[0]['is-paused']], [undefined, false]);
  assert.deepEqual(t['worked-manually'], MANUAL['worked-manually']);
});

test('ASS-166 AC2: ticket:sync updates a backlog ticket worked by hand without sending it back to its first step', async () => {
  const dir = projects();
  const b = backlog(dir);
  Object.assign(b.tickets[0], MANUAL);
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(b));
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { description: 'Changed' })] }));
  const [t] = backlog(dir).tickets;
  assert.deepEqual([t.description, t.variations[0]['harness-status'].state], ['Changed', 'ready']);
});

// ASS-202 AC2: a sprint sync copies Done onto the ticket's kept backlog.json
// entry (ASS-42), reading the Done keys from the just-written sprint.json
// (not from the fetch, so a status_kept hole cannot wrongly mark an entry
// Done). The entry's other fields — variations, state-changes, refinement
// history, priority, manual-backlog-priority, is-deleted — stay as they
// were. Case-insensitive key match. The Jira backlog JQL is not widened
// (jira.js:51 unchanged).

// `projects()` with ABC-9 added to sprint-10 (active) so its backlog.json entry models a real kept entry (ASS-42).
function projectsWithKeptABC9() {
  const dir = projects();
  const s = sprint(dir);
  s.features.push({ ...fetched('ABC-9'), 'ticket-system-status': 'In Progress', priority: 3, 'manual-priority': null, qa: { status: null },
    variations: [{ name: 'A', 'harness-status': { state: 'committed', 'state-engine': 'example-development' }, 'state-changes': [] }] });
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(s));
  return dir;
}

test('ASS-202 AC2: sprint sync of a Done fetched ticket stamps its kept backlog entry Done, every other field byte-identical', async () => {
  const dir = projectsWithKeptABC9();
  const b0 = backlog(dir);
  b0.tickets[0]['manual-backlog-priority'] = 2;
  b0.tickets[0].variations[0]['state-changes'] = [{ 'state-engine': 'example-backlog-refinement', 'from-state': 'groom', 'to-state': 'ready', timestamp: '2026-10-20T00:00:00Z', 'agent-dispatch-log': [], 'work-is-done': false, cause: 'operator' }];
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(b0));
  const before = { ...backlog(dir).tickets[0] };
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('abc-9', { 'ticket-system-status': 'Done' })] }));   // case-insensitive key
  const [t] = backlog(dir).tickets;
  assert.equal(t['ticket-system-status'], 'Done');
  assert.deepEqual({ ...t, 'ticket-system-status': before['ticket-system-status'] }, before);                   // the only change
});

test('ASS-202 AC2: a non-Done sprint sync leaves the backlog entry\'s ticket-system-status alone', async () => {
  const dir = projectsWithKeptABC9();
  const before = backlog(dir);
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-9', { 'ticket-system-status': 'In Progress' })] }));
  assert.deepEqual(backlog(dir), before);
});

test('ASS-202 AC2: a sprint sync without any Done fetched ticket does not change any backlog entry\'s status', async () => {
  const dir = projectsWithKeptABC9();
  const before = backlog(dir);
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { title: 'Renamed' })] }));
  assert.deepEqual(backlog(dir).tickets.map(t => [t.key, t['ticket-system-status']]), before.tickets.map(t => [t.key, t['ticket-system-status']]));
});

test('ASS-202 AC2: a sprint sync with no backlog.json leaves no error and still writes sprint.json', async () => {
  const dir = projects();
  rmSync(join(dir, 'p', 'backlog.json'));
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-1', { 'ticket-system-status': 'Done' })] }));
  assert.equal(sprint(dir).features[0]['ticket-system-status'], 'Done');
  assert.equal(existsSync(join(dir, 'p', 'backlog.json')), false);
});

test('ASS-202 AC2: a Done fetched ticket whose sprint.json entry keeps a non-Done status (ASS-128 status_kept) does NOT stamp the backlog entry Done — Done keys read from the just-written sprint.json, not the fetch', async () => {
  const dir = projectsWithKeptABC9();
  // Sprint-10's ABC-9 holds a locally-set non-Done status, stamped after the fetch (ASS-128 status_kept).
  const s = sprint(dir);
  const abc9 = s.features.find(t => t.key === 'ABC-9');
  abc9['ticket-system-status'] = 'In Progress';
  abc9['ticket-system-status-at'] = '2026-10-24T19:21:47Z';
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify(s));
  await sync(dir, 'p', 'sprint', file(dir, { 'fetched-at': '2026-10-24T19:20:20Z', tickets: [fetched('ABC-9', { 'ticket-system-status': 'Done' })] }));
  assert.equal(sprint(dir).features.find(t => t.key === 'ABC-9')['ticket-system-status'], 'In Progress');       // kept
  assert.notEqual(backlog(dir).tickets[0]['ticket-system-status'], 'Done');                                     // and so is the kept backlog entry
});

test('ASS-202 AC2: a sprint sync of a Done ticket whose backlog entry is soft-deleted still stamps it Done; is-deleted is kept', async () => {
  const dir = projectsWithKeptABC9();
  const b = backlog(dir);
  b.tickets[0]['is-deleted'] = true;
  b.tickets[0]['deleted-timestamp'] = '2026-10-20T00:00:00Z';
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(b));
  await sync(dir, 'p', 'sprint', file(dir, { tickets: [fetched('ABC-9', { 'ticket-system-status': 'Done' })] }));
  const [t] = backlog(dir).tickets;
  assert.equal(t['ticket-system-status'], 'Done');
  assert.equal(t['is-deleted'], true);
  assert.equal(t['deleted-timestamp'], '2026-10-20T00:00:00Z');
});

test('ASS-202 AC2: the Jira backlog JQL (src/downloader/jira.js) is not widened — statusCategory != Done unchanged', () => {
  const src = readFileSync(new URL('../../src/downloader/jira.js', import.meta.url), 'utf8');
  assert.ok(/statusCategory\s*!=\s*Done/.test(src), 'Jira backlog JQL still excludes statusCategory Done');
});

// ASS-202 AC2: a backlog sync of a ticket whose fetched ticket-system-status
// is Done takes field updates and the requirements-history append, but no
// `changed-at` stamp and no restart to the refinement engine's first step.
// Done-exemption keys on the fetched status so a reopen is NOT swallowed:
// fetched Backlog on a Done entry still restarts and stamps.

test('ASS-202 AC2: a backlog sync of a Done fetched ticket with a changed description merges fields and appends history but does not restart or stamp changed-at — at a resting step and a mid-run step alike', async () => {
  for (const state of ['ready', 'estimate']) {
    const dir = projects();
    const b = backlog(dir);
    b.tickets[0]['ticket-system-status'] = 'Done';
    b.tickets[0].variations[0]['harness-status'].state = state;
    writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(b));
    await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { 'ticket-system-status': 'Done', description: 'Changed' })] }));
    const [t] = backlog(dir).tickets;
    assert.equal(t.description, 'Changed', state);
    assert.equal(t.variations[0]['harness-status'].state, state, state);
    assert.deepEqual(t.variations[0]['state-changes'] ?? [], [], state);
    assert.equal('changed-at' in t, false, state);
    assert.deepEqual(lines(history(dir, 'ABC-9')).map(({ field, from, to }) => [field, from, to]), [['description', 'About ABC-9', 'Changed']], state);
  }
});

test('ASS-202 AC2: a backlog sync of a Done entry whose description did not change appends no requirements history', async () => {
  const dir = projects();
  const b = backlog(dir);
  b.tickets[0]['ticket-system-status'] = 'Done';
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(b));
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { 'ticket-system-status': 'Done' })] }));
  assert.equal(existsSync(history(dir, 'ABC-9')), false);
  assert.equal('changed-at' in backlog(dir).tickets[0], false);
});

test('ASS-202 AC2: a backlog sync of a reopened ticket (fetched Backlog, entry Done) sets the entry Backlog and restarts to the first step, stamped — Done exemption keys on the fetched status', async () => {
  const dir = projects();
  const b = backlog(dir);
  b.tickets[0]['ticket-system-status'] = 'Done';
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify(b));
  await sync(dir, 'p', 'backlog', file(dir, { tickets: [fetched('ABC-9', { 'ticket-system-status': 'Backlog', description: 'Changed' })] }));
  const [t] = backlog(dir).tickets;
  assert.equal(t['ticket-system-status'], 'Backlog');
  assert.equal(t.variations[0]['harness-status'].state, 'groom');
  assert.match(t['changed-at'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});
