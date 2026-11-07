// ticket:set-manual-priority — sets or clears a ticket's manual-priority in
// the active sprint's sprint.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// A harness-status at `state` of the example-development engine.
const hs = state => ({ state, 'state-engine': 'example-development' });

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A projects/ folder whose project p has sprint 10 active, its tickets
// ranked 1 to 5 across features, bugs and spikes, ABC-3's set by hand.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'mp-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  const ticket = (key, priority, manual = null) => ({ key, priority, 'manual-priority': manual });
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10,
    features: [ticket('ABC-1', 1), { ...ticket('ABC-2', 2), variations: [{ name: 'A', 'harness-status': hs('backlog') }] }, ticket('ABC-3', 3, 3)],
    bugs: [ticket('ABC-4', 4)],
    spikes: [ticket('ABC-5', 5)],
  }, null, 4));
  return dir;
}
const sprintFile = dir => join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
const set = (dir, ...args) => run(AGENT, ['ticket:set-manual-priority', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
// Each ticket's "priority/manual-priority" by key ("-" for null).
const ranks = dir => {
  const s = JSON.parse(readFileSync(sprintFile(dir), 'utf8'));
  return Object.fromEntries([...s.features, ...s.bugs, ...s.spikes].map(t => [t.key, `${t.priority}/${t['manual-priority'] ?? '-'}`]));
};

test('ticket:set-manual-priority moves the ticket up to its priority, those from there to where it was one down; it is its priority too', async () => {
  const dir = projects();
  await set(dir, 'p', 'abc-4', '1');
  assert.deepEqual(ranks(dir), { 'ABC-4': '1/1', 'ABC-1': '2/-', 'ABC-2': '3/-', 'ABC-3': '4/4', 'ABC-5': '5/-' });   // one set by hand moves with them
});

test('ticket:set-manual-priority moves the ticket down to its priority, those from where it was to there one up', async () => {
  const dir = projects();
  await set(dir, 'p', 'ABC-1', '4');
  assert.deepEqual(ranks(dir), { 'ABC-2': '1/-', 'ABC-3': '2/2', 'ABC-4': '3/-', 'ABC-1': '4/4', 'ABC-5': '5/-' });
});

test('ticket:set-manual-priority to the priority it has moves no other', async () => {
  const dir = projects();
  await set(dir, 'p', 'ABC-2', '2');
  assert.deepEqual(ranks(dir), { 'ABC-1': '1/-', 'ABC-2': '2/2', 'ABC-3': '3/3', 'ABC-4': '4/-', 'ABC-5': '5/-' });
});

// A sprint to rank by the rules once a manual priority is cleared: S-20 keeps
// the 2 set by hand; F-7's is cleared. Steps: s1 (sequence 1), s5 (sequence 5).
function ranking() {
  const dir = mkdtempSync(join(tmpdir(), 'mp-'));
  const engines = join(dir, 'engines');
  mkdirSync(join(engines, 'e'), { recursive: true });
  writeFileSync(join(engines, 'e', 'state-engine.json'), JSON.stringify({ steps: [{ id: 's1', sequence: 1 }, { id: 's5', sequence: 5 }] }));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'P', 'execution-state-engine': 'e' }));
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  const ticket = (key, fields = {}) => ({
    key, priority: null, 'manual-priority': null, 'ticket-system-priority': 'High', points: 3, dependencies: [],
    variations: [{ name: 'A', 'harness-status': hs('s1') }], ...fields,
  });
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10,
    features: [
      ticket('F-7', { priority: 1, 'manual-priority': 1 }),
      ticket('F-6', { points: 8 }),                                           // bigger
      ticket('F-5'),
      ticket('F-4', { variations: [{ name: 'A', 'harness-status': hs('s1') }, { name: 'B', 'harness-status': hs('s5') }] }),   // closer to done
      ticket('F-3', { dependencies: ['F-2'] }),
      ticket('F-2'),                                                          // depended on
      ticket('F-1', { variations: [{ name: 'A', 'harness-status': hs('s5'), 'is-deleted': true }, { name: 'B', 'harness-status': hs('s1') }] }),
    ],
    bugs: [ticket('B-10', { 'ticket-system-priority': 'High' }), ticket('B-11', { 'ticket-system-priority': 'Highest' }), ticket('B-12', { 'ticket-system-priority': null })],
    spikes: [ticket('S-20', { priority: 2, 'manual-priority': 2 })],
  }, null, 4));
  return { dir, engines };
}

test('clearing a manual priority ranks every ticket not set by hand again by the rules, around those set by hand', async () => {
  const { dir, engines } = ranking();
  await run(AGENT, ['ticket:set-manual-priority', 'p', 'F-7', ''], { env: { ...process.env, PROJECTS_DIR: dir, ENGINES_DIR: engines } });
  assert.deepEqual(ranks(dir), {
    'B-11': '1/-', 'S-20': '2/2',                                         // Highest first; S-20 keeps its place
    'B-10': '3/-',                                                        // High: the bug before the stories
    'F-2': '4/-', 'F-4': '5/-', 'F-6': '6/-',                              // depended on, closer to done, bigger
    'F-1': '7/-', 'F-3': '8/-', 'F-5': '9/-', 'F-7': '10/-',               // then by ticket number; F-1's deleted variation counts for nothing
    'B-12': '11/-',                                                       // no Jira priority last, bug or not
  });
});

test('a ticket without a priority set to one makes room there: every ticket from there one down', async () => {
  const dir = projects();
  const file = sprintFile(dir);
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  sprint.bugs.push({ key: 'ABC-6', priority: null, 'manual-priority': null });
  writeFileSync(file, JSON.stringify(sprint));
  await set(dir, 'p', 'ABC-6', '2');
  assert.deepEqual(ranks(dir), { 'ABC-1': '1/-', 'ABC-6': '2/2', 'ABC-2': '3/-', 'ABC-3': '4/4', 'ABC-4': '5/-', 'ABC-5': '6/-' });
});

test('ticket:set-manual-priority fails, writing nothing, on a priority that is not a whole number from 1, or an unknown ticket', async () => {
  const dir = projects();
  const before = readFileSync(sprintFile(dir), 'utf8');
  for (const bad of ['0', '-1', '2.5', 'high', ' 3']) await assert.rejects(set(dir, 'p', 'ABC-3', bad), /whole number from 1/);
  await assert.rejects(set(dir, 'p', 'ABC-9', '3'), /no ABC-9/);
  await assert.rejects(set(dir, 'p', 'ABC-3'), /usage/);
  await assert.rejects(set(dir, '../p', 'ABC-3', '3'), /invalid project/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

// ASS-195: an optional 4th arg <for>, the dependent a hold raised the ticket
// for. With a priority, the write also records priority-raised-by { field,
// value, for } on the ticket — the same locked write. With "", the raise is
// released: only when the record is there and for <for> — the field cleared
// when it still holds the recorded value, the record dropped either way.
// Without it, an operator's write: the record is dropped.
const RAISED = 'priority-raised-by';
const sprintTicket = (dir, key) => { const s = JSON.parse(readFileSync(sprintFile(dir), 'utf8')); return [...s.features, ...s.bugs, ...s.spikes].find(t => t.key === key); };
// projects() with ABC-3's manual-priority 3 recorded as raised by a hold: `record` merged over { field, value: 3, for: ABC-9 }.
function raised(record = {}) {
  const dir = projects();
  const sprint = JSON.parse(readFileSync(sprintFile(dir), 'utf8'));
  sprint.features[2][RAISED] = { field: 'manual-priority', value: 3, for: 'ABC-9', ...record };
  writeFileSync(sprintFile(dir), JSON.stringify(sprint, null, 4));
  return dir;
}

test('ASS-195 AC2: ticket:set-manual-priority with a 4th arg sets the priority as ever and records priority-raised-by { field, value, for } on the ticket', async () => {
  const dir = projects();
  await set(dir, 'p', 'ABC-5', '2', 'ABC-3');
  assert.deepEqual(ranks(dir), { 'ABC-1': '1/-', 'ABC-5': '2/2', 'ABC-2': '3/-', 'ABC-3': '4/4', 'ABC-4': '5/-' });
  assert.deepEqual(sprintTicket(dir, 'ABC-5')[RAISED], { field: 'manual-priority', value: 2, for: 'ABC-3' });
  assert.equal(RAISED in sprintTicket(dir, 'ABC-3'), false);
});

test('ASS-195 AC2: ticket:set-manual-priority "" <for> on a ticket still at its raised value clears it and drops the record', async () => {
  const dir = raised();
  await set(dir, 'p', 'ABC-3', '', 'ABC-9');
  const t = sprintTicket(dir, 'ABC-3');
  assert.equal(t['manual-priority'], null);
  assert.equal(RAISED in t, false);
});

test('ASS-195 AC2: ticket:set-manual-priority "" <for> without a record writes nothing', async () => {
  const dir = projects();
  const before = readFileSync(sprintFile(dir), 'utf8');
  await set(dir, 'p', 'ABC-3', '', 'ABC-9');
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

test('ASS-195 AC2: ticket:set-manual-priority "" <for> on a ticket no longer at its raised value leaves the value, drops the record', async () => {
  const dir = raised({ value: 2 });
  await set(dir, 'p', 'ABC-3', '', 'ABC-9');
  const t = sprintTicket(dir, 'ABC-3');
  assert.equal(t['manual-priority'], 3);
  assert.equal(RAISED in t, false);
});

test('ASS-195 AC2: ticket:set-manual-priority "" <for> with a record for another dependent changes nothing', async () => {
  const dir = raised({ for: 'ABC-8' });
  const before = readFileSync(sprintFile(dir), 'utf8');
  await set(dir, 'p', 'ABC-3', '', 'ABC-9');
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});

test('ASS-195 AC2: a plain ticket:set-manual-priority (no 4th arg) on a raised ticket is the operator\'s: the value is written, the record dropped', async () => {
  const dir = raised();
  await set(dir, 'p', 'ABC-3', '2');
  const t = sprintTicket(dir, 'ABC-3');
  assert.equal(t['manual-priority'], 2);
  assert.equal(RAISED in t, false);
  // Set back to the very value the hold wrote: still the operator's, no record.
  const g = raised();
  await set(g, 'p', 'ABC-3', '3');
  assert.deepEqual([sprintTicket(g, 'ABC-3')['manual-priority'], RAISED in sprintTicket(g, 'ABC-3')], [3, false]);
});

test('ASS-195 AC2: ticket:set-manual-priority\'s usage names the optional 4th arg; a bad priority with one, or a 5th arg, still fails writing nothing', async () => {
  const dir = projects();
  const before = readFileSync(sprintFile(dir), 'utf8');
  await assert.rejects(set(dir, 'p', 'ABC-3'), /usage: ticket:set-manual-priority <project> <ticket-key> <priority> \[<for>\]/);
  await assert.rejects(set(dir, 'p', 'ABC-3', 'high', 'ABC-9'), /whole number from 1/);
  await assert.rejects(set(dir, 'p', 'ABC-3', '2', 'ABC-9', 'x'), /usage/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
});
