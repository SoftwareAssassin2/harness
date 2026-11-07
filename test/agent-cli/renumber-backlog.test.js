// ticket:renumber-backlog — sets each backlog ticket's priority to its place
// in control's refinement order (rankBacklog), a manual backlog priority kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

const item = (key, extra = {}) => ({ key, priority: 99, 'manual-backlog-priority': null, 'sprint-tag': null, 'ticket-system-priority': null, dependencies: [], ...extra });
// A projects/ folder whose project p has sprint 3 active, holding `sprint`, and a backlog of `backlog`.
function projects(backlog, sprint = []) {
  const dir = mkdtempSync(join(tmpdir(), 'rb-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-3'), { recursive: true });
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 3, 'is-active': true }] }));
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-3', 'sprint.json'), JSON.stringify({ number: 3, features: sprint, bugs: [], spikes: [] }));
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify({ tickets: backlog }));
  return dir;
}
const renumber = (dir, ...args) => run(AGENT, ['ticket:renumber-backlog', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
// Each backlog ticket's "priority/manual-backlog-priority" by key ("-" for null).
const ranks = dir => Object.fromEntries(JSON.parse(readFileSync(join(dir, 'p', 'backlog.json'), 'utf8')).tickets
  .map(t => [t.key, `${t.priority}/${t['manual-backlog-priority'] ?? '-'}`]));

test('ticket:renumber-backlog sets each backlog ticket\'s priority to its 1-based place in the refinement order', async () => {
  const dir = projects([item('T-3'), item('T-1', { 'ticket-system-priority': 'Low' }), item('T-2', { 'sprint-tag': 'Sprint 4' })]);
  const { stdout } = await renumber(dir, 'p', '--by', 'control');
  assert.deepEqual(ranks(dir), { 'T-3': '3/-', 'T-1': '2/-', 'T-2': '1/-' });
  assert.deepEqual(JSON.parse(stdout), { project: 'p', by: 'control', renumbered: 3 });
});

test('ticket:renumber-backlog --by control keeps the operator\'s manual backlog priority as the ticket\'s priority, ranking the rest around it', async () => {
  const dir = projects([item('T-1'), item('T-2'), item('T-3', { 'manual-backlog-priority': 1 }), item('T-4', { 'manual-backlog-priority': 7 })]);
  await renumber(dir, 'p', '--by', 'control');
  assert.deepEqual(ranks(dir), { 'T-3': '1/1', 'T-1': '2/-', 'T-2': '3/-', 'T-4': '7/7' });
});

test('ticket:renumber-backlog leaves a ticket in the sprint, or deleted, as it was: not ranked, its last backlog priority kept', async () => {
  const dir = projects(
    [item('T-1', { priority: 5, 'manual-backlog-priority': 1 }), item('T-2', { priority: 8, 'is-deleted': true }), item('T-3'), item('T-4')],
    [{ key: 't-1', 'manual-priority': null }]);
  await renumber(dir, 'p', '--by', 'human');
  assert.deepEqual(ranks(dir), { 'T-1': '5/1', 'T-2': '8/-', 'T-3': '1/-', 'T-4': '2/-' });   // T-1's 1 holds no place here
});

// ASS-202 AC1: a Done backlog entry is not ranked, its last priority kept —
// the same shape as a soft-deleted or sprint-kept entry (above). Through the
// shared isLiveBacklogEntry predicate.
test('ASS-202 AC1: ticket:renumber-backlog leaves a Done ticket as it was: not ranked, its last backlog priority kept', async () => {
  const dir = projects([item('T-1', { priority: 5, 'ticket-system-status': 'Done' }), item('T-2'), item('T-3')]);
  await renumber(dir, 'p', '--by', 'control');
  assert.deepEqual(ranks(dir), { 'T-1': '5/-', 'T-2': '1/-', 'T-3': '2/-' });
});

test('ticket:renumber-backlog is deterministic: run again, nothing changes', async () => {
  const dir = projects([item('T-2', { dependencies: ['T-1'] }), item('T-1'), item('T-5', { 'manual-backlog-priority': 2 })]);
  await renumber(dir, 'p', '--by', 'control');
  const once = readFileSync(join(dir, 'p', 'backlog.json'), 'utf8');
  await renumber(dir, 'p', '--by', 'control');
  assert.equal(readFileSync(join(dir, 'p', 'backlog.json'), 'utf8'), once);
});

test('ticket:renumber-backlog ranks the whole backlog when the project has no active sprint, and does nothing without a backlog', async () => {
  const dir = projects([item('T-2'), item('T-1')]);
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [] }));
  await renumber(dir, 'p', '--by', 'control');
  assert.deepEqual(ranks(dir), { 'T-2': '2/-', 'T-1': '1/-' });
  mkdirSync(join(dir, 'q'));
  assert.deepEqual(JSON.parse((await renumber(dir, 'q', '--by', 'control')).stdout), { project: 'q', by: 'control', renumbered: 0 });
});

test('ticket:renumber-backlog fails, writing nothing, without --by control|human or with an invalid project', async () => {
  const dir = projects([item('T-1')]);
  for (const args of [['p'], ['p', '--by', 'robot'], ['p', 'control'], ['../p', '--by', 'control']]) {
    await assert.rejects(renumber(dir, ...args), /usage|invalid/);
  }
  assert.deepEqual(ranks(dir), { 'T-1': '99/-' });
});

test('ticket:renumber-backlog reads and writes inside backlog.json.lock, every backlog writer\'s lock, and takes no other (ASS-179 AC3): a ticket added while it waits is ranked', async t => {
  const dir = projects([item('T-1'), item('T-2')]);
  const file = join(dir, 'p', 'backlog.json');
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', `${file}.lock`]);
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const renumbering = renumber(dir, 'p', '--by', 'control');
  await new Promise(r => setTimeout(r, 1000));
  // A backlog writer holding the lock adds a ticket, then lets go.
  writeFileSync(file, JSON.stringify({ tickets: [item('T-1'), item('T-2'), item('T-3', { 'ticket-system-priority': 'Highest' })] }));
  holder.kill('SIGKILL');
  assert.equal(JSON.parse((await renumbering).stdout).renumbered, 3);
  assert.deepEqual(ranks(dir), { 'T-3': '1/-', 'T-1': '2/-', 'T-2': '3/-' });
  assert.deepEqual(readdirSync(join(dir, 'p')).filter(f => f.endsWith('.lock')), ['backlog.json.lock']);
});
