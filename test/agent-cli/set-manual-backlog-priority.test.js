// ticket:set-manual-backlog-priority — sets or clears a backlog ticket's
// manual-backlog-priority in backlog.json, making room for it (ASS-100).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A projects/ folder whose project p has a backlog ranked by hand: B-1 1, B-2 2,
// B-3 3, B-4 none, B-5 4 (in the sprint), B-6 none; B-7 is only in the sprint.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'mbp-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-3'), { recursive: true });
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 3, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-3', 'sprint.json'), JSON.stringify({ number: 3,
    features: [{ key: 'B-5', priority: 1, 'manual-priority': 1 }, { key: 'B-7', priority: 2, 'manual-priority': null }], bugs: [], spikes: [] }));
  const item = (key, manual) => ({ key, priority: 50, 'manual-backlog-priority': manual, dependencies: [] });
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify({ tickets: [item('B-1', 1), item('B-2', 2), item('B-3', 3), item('B-4', null), item('B-5', 4), item('B-6', null)] }));
  return dir;
}
const backlogFile = dir => join(dir, 'p', 'backlog.json');
const sprintFile = dir => join(dir, 'p', 'sprints', 'sprint-3', 'sprint.json');
const set = (dir, ...args) => run(AGENT, ['ticket:set-manual-backlog-priority', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const tickets = dir => JSON.parse(readFileSync(backlogFile(dir), 'utf8')).tickets;
// Each backlog ticket's manual-backlog-priority by key ("-" for null).
const manual = dir => Object.fromEntries(tickets(dir).map(t => [t.key, t['manual-backlog-priority'] ?? '-']));

test('ticket:set-manual-backlog-priority on a ticket without one moves every ticket from there on down one', async () => {
  const dir = projects();
  const { stdout } = await set(dir, 'p', 'b-4', '2');
  assert.deepEqual(manual(dir), { 'B-1': 1, 'B-2': 3, 'B-3': 4, 'B-4': 2, 'B-5': 5, 'B-6': '-' });   // over the whole file, B-5 in the sprint too
  assert.deepEqual(JSON.parse(stdout), { ticket: 'B-4', 'manual-backlog-priority': 2 });
});

test('ticket:set-manual-backlog-priority moves a ticket up, those from there to where it was one down', async () => {
  const dir = projects();
  await set(dir, 'p', 'B-3', '1');
  assert.deepEqual(manual(dir), { 'B-1': 2, 'B-2': 3, 'B-3': 1, 'B-4': '-', 'B-5': 4, 'B-6': '-' });
});

test('ticket:set-manual-backlog-priority moves a ticket down, those from where it was to there one up; to where it is, no other', async () => {
  const dir = projects();
  await set(dir, 'p', 'B-1', '3');
  assert.deepEqual(manual(dir), { 'B-1': 3, 'B-2': 1, 'B-3': 2, 'B-4': '-', 'B-5': 4, 'B-6': '-' });
  await set(dir, 'p', 'B-1', '3');
  assert.deepEqual(manual(dir), { 'B-1': 3, 'B-2': 1, 'B-3': 2, 'B-4': '-', 'B-5': 4, 'B-6': '-' });
});

test('ticket:set-manual-backlog-priority "" clears it, those after it one up so the set stays whole from 1', async () => {
  const dir = projects();
  await set(dir, 'p', 'B-2', '');
  assert.deepEqual(manual(dir), { 'B-1': 1, 'B-2': '-', 'B-3': 2, 'B-4': '-', 'B-5': 3, 'B-6': '-' });
  await set(dir, 'p', 'B-6', '');   // none to clear: nothing moves
  assert.deepEqual(manual(dir), { 'B-1': 1, 'B-2': '-', 'B-3': 2, 'B-4': '-', 'B-5': 3, 'B-6': '-' });
});

test('ticket:set-manual-backlog-priority then renumbers the backlog --by human: priority is the manual one where set, else the place left', async () => {
  const dir = projects();
  await set(dir, 'p', 'B-6', '1');
  const priority = Object.fromEntries(tickets(dir).map(t => [t.key, t.priority]));
  assert.deepEqual(priority, { 'B-6': 1, 'B-1': 2, 'B-2': 3, 'B-3': 4, 'B-4': 5, 'B-5': 50 });   // B-5 is in the sprint: kept
});

test('ticket:set-manual-backlog-priority never reads or writes manual-priority, in the backlog or the sprint', async () => {
  const dir = projects();
  const t = tickets(dir);
  t[3]['manual-priority'] = 7;
  writeFileSync(backlogFile(dir), JSON.stringify({ tickets: t }));
  const sprint = readFileSync(sprintFile(dir), 'utf8');
  await set(dir, 'p', 'B-4', '1');
  assert.equal(tickets(dir)[3]['manual-priority'], 7);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), sprint);
});

test('ticket:set-manual-priority never reads or writes manual-backlog-priority', async () => {
  const dir = projects();
  const before = readFileSync(backlogFile(dir), 'utf8');
  await run(AGENT, ['ticket:set-manual-priority', 'p', 'B-7', '1'], { env: { ...process.env, PROJECTS_DIR: dir } });
  assert.equal(readFileSync(backlogFile(dir), 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(sprintFile(dir), 'utf8')).features.some(t => 'manual-backlog-priority' in t), false);
});

test('ticket:set-manual-backlog-priority fails, writing nothing, on an unknown ticket, one not in the backlog, or any other value', async () => {
  const dir = projects();
  const before = readFileSync(backlogFile(dir), 'utf8');
  for (const args of [['p', 'B-9', '1'], ['p', 'B-7', '1'], ['p', 'B-1', '0'], ['p', 'B-1', 'x'], ['p', 'B-1', '-1'], ['p', 'B-1', '1.5'], ['p', 'B-1'], ['q', 'B-1', '1']]) {
    await assert.rejects(set(dir, ...args), /usage|whole number|no B-/);
  }
  assert.equal(readFileSync(backlogFile(dir), 'utf8'), before);
});

// ASS-195: an optional 4th arg <for>, as ticket:set-manual-priority's — the
// record priority-raised-by { field: manual-backlog-priority, value, for }.
const RAISED = 'priority-raised-by';
const backlogTicket = (dir, key) => tickets(dir).find(t => t.key === key);
// projects() with `key`'s manual-backlog-priority recorded as raised by a hold: `record` merged over { field, value: its own, for: B-7 }.
function raised(key = 'B-2', record = {}) {
  const dir = projects();
  const t = tickets(dir);
  const it = t.find(x => x.key === key);
  it[RAISED] = { field: 'manual-backlog-priority', value: it['manual-backlog-priority'], for: 'B-7', ...record };
  writeFileSync(backlogFile(dir), JSON.stringify({ tickets: t }));
  return dir;
}

test('ASS-195 AC2: ticket:set-manual-backlog-priority with a 4th arg makes room as ever and records priority-raised-by { field, value, for } on the ticket', async () => {
  const dir = projects();
  await set(dir, 'p', 'B-4', '1', 'B-7');
  assert.deepEqual(manual(dir), { 'B-1': 2, 'B-2': 3, 'B-3': 4, 'B-4': 1, 'B-5': 5, 'B-6': '-' });
  assert.equal(backlogTicket(dir, 'B-4').priority, 1);                                           // renumbered --by human
  assert.deepEqual(backlogTicket(dir, 'B-4')[RAISED], { field: 'manual-backlog-priority', value: 1, for: 'B-7' });
  assert.ok(tickets(dir).filter(t => t.key !== 'B-4').every(t => !(RAISED in t)));
});

test('ASS-195 AC2: ticket:set-manual-backlog-priority "" <for> on a ticket still at its raised value clears it and drops the record', async () => {
  const dir = raised();
  await set(dir, 'p', 'B-2', '', 'B-7');
  assert.deepEqual(manual(dir), { 'B-1': 1, 'B-2': '-', 'B-3': 2, 'B-4': '-', 'B-5': 3, 'B-6': '-' });
  assert.equal(RAISED in backlogTicket(dir, 'B-2'), false);
});

test('ASS-195 AC2: ticket:set-manual-backlog-priority "" <for> releases a ticket already in the sprint, its backlog.json row kept (joined)', async () => {
  const dir = raised('B-5');
  await set(dir, 'p', 'B-5', '', 'B-7');
  assert.equal(backlogTicket(dir, 'B-5')['manual-backlog-priority'], null);
  assert.equal(RAISED in backlogTicket(dir, 'B-5'), false);
});

test('ASS-195 AC2: ticket:set-manual-backlog-priority "" <for> without a record writes nothing', async () => {
  const dir = projects();
  const before = readFileSync(backlogFile(dir), 'utf8');
  await set(dir, 'p', 'B-2', '', 'B-7');
  assert.equal(readFileSync(backlogFile(dir), 'utf8'), before);
});

test('ASS-195 AC2: ticket:set-manual-backlog-priority "" <for> on a ticket no longer at its raised value leaves the value, drops the record', async () => {
  const dir = raised('B-2', { value: 1 });
  await set(dir, 'p', 'B-2', '', 'B-7');
  assert.equal(backlogTicket(dir, 'B-2')['manual-backlog-priority'], 2);
  assert.equal(RAISED in backlogTicket(dir, 'B-2'), false);
});

test('ASS-195 AC2: ticket:set-manual-backlog-priority "" <for> with a record for another dependent changes nothing', async () => {
  const dir = raised('B-2', { for: 'B-8' });
  const before = readFileSync(backlogFile(dir), 'utf8');
  await set(dir, 'p', 'B-2', '', 'B-7');
  assert.equal(readFileSync(backlogFile(dir), 'utf8'), before);
});

test('ASS-195 AC2: a plain ticket:set-manual-backlog-priority (no 4th arg) on a raised ticket is the operator\'s: the value is written, the record dropped', async () => {
  const dir = raised();
  await set(dir, 'p', 'B-2', '1');
  assert.deepEqual([backlogTicket(dir, 'B-2')['manual-backlog-priority'], RAISED in backlogTicket(dir, 'B-2')], [1, false]);
  const g = raised();
  await set(g, 'p', 'B-2', '2');                                                                  // the very value the hold wrote
  assert.deepEqual([backlogTicket(g, 'B-2')['manual-backlog-priority'], RAISED in backlogTicket(g, 'B-2')], [2, false]);
});

test('ASS-195 AC2: ticket:set-manual-backlog-priority\'s usage names the optional 4th arg; a bad priority with one, or a 5th arg, still fails writing nothing', async () => {
  const dir = projects();
  const before = readFileSync(backlogFile(dir), 'utf8');
  await assert.rejects(set(dir, 'p', 'B-1'), /usage: ticket:set-manual-backlog-priority <project> <ticket-key> <priority> \[<for>\]/);
  await assert.rejects(set(dir, 'p', 'B-1', 'x', 'B-7'), /whole number/);
  await assert.rejects(set(dir, 'p', 'B-1', '1', 'B-7', 'x'), /usage/);
  assert.equal(readFileSync(backlogFile(dir), 'utf8'), before);
});
