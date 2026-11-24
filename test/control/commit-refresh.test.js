// ASS-558 AC3: control keeps each sprint variation's commit list fresh — periodically, and after a step that commits —
// by running ticket:refresh-commits in the background (src/control/commit-refresh.js); never with
// COMMIT_LISTS_DISABLED=1 (the fixtures' env).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitsDue, commits, refreshCommitLists, COMMITS_REFRESH_MINUTES, MAX_PER_CHECK, CHECK_EVERY_MS } from '../../src/control/commit-refresh.js';
import { createContext } from '../../src/control/tick.js';

const MIN = 60e3;
const engines = {
  e: { steps: [
    { id: 'plan', action: { type: 'state-engine', engine: 'build' } },
    { id: 'gate', action: { type: 'human' } },
    { id: 'wait', action: { type: 'script', command: './agent.sh ticket:dependency-wait {project} {ticket}' } },
    { id: 'merge', action: { type: 'script', command: './agent.sh merge-request:merge {project} {ticket} {variation}' } },
    { id: 'done', 'is-done': true, action: { type: 'none' } },
  ] },
  build: { steps: [{ id: 'generate', action: { type: 'prompt' } }, { id: 'await', action: { type: 'script', command: './agent.sh merge-request:await-dependencies {project}' } }, { id: 'pause', action: { type: 'human' } }] },
};
const at = minutes => new Date(Date.parse('2026-11-23T10:00:00Z') + minutes * MIN).toISOString().replace('.000', '');
const move = (from, to, minutes, extra = {}) => ({ 'state-engine': 'e', 'from-state': from, 'to-state': to, timestamp: at(minutes), 'agent-dispatch-log': [], ...extra });
const worked = (changes, extra = {}) => ({ name: 'A', build: { branch: 'change/ABC-1' }, 'harness-status': { state: 'plan', 'state-engine': 'e' }, 'state-changes': changes, ...extra });
const list = minutes => ({ 'refreshed-at': at(minutes) });
const due = (v, l, now) => commitsDue(v, l, { engines, engineName: 'e', now: Date.parse(at(now)) });

test('ASS-558 AC3: which steps can leave commits — an agent\'s turn, an in-machine script, a merge-request or code script; not a human gate or a host wait', () => {
  assert.equal(commits(engines.build.steps[0]), true);
  assert.equal(commits(engines.e.steps[3]), true);
  assert.equal(commits({ id: 'x', action: { type: 'script', command: './agent.sh code:create-branch {project}' } }), true);
  assert.equal(commits({ id: 'x', action: { type: 'script', command: './agent.sh vm:test-repos {project}' } }), true);   // in the machine
  assert.equal(commits(engines.e.steps[1]), false);
  assert.equal(commits(engines.e.steps[2]), false);
  assert.equal(commits(undefined), true);   // a step not found: it may have
});

test('ASS-558 AC3: a list is due — at once when there is none and the variation has work; after a move out of a step that commits; periodically until done', () => {
  const sub = (from, to, minutes) => move('plan', 'plan', minutes, { 'sub-state-change': { 'state-engine': 'build', 'from-state': from, 'to-state': to } });
  assert.equal(due({ name: 'A', 'state-changes': [move('backlog', 'plan', 0)] }, null, 1), null);   // nothing to find yet
  assert.equal(due(worked([]), null, 1), 'no list yet');
  assert.equal(due({ name: 'A', 'state-changes': [move('backlog', 'plan', 0, { 'agent-dispatch-log': [{ 'dispatched-to': 'Ada' }] })] }, null, 1), 'no list yet');
  assert.equal(due(worked([sub('generate', 'await', 5)]), list(4), 6), 'left generate');                 // an agent's turn ended after the refresh
  assert.equal(due(worked([sub('generate', 'await', 3)]), list(4), 6), null);                             // ... before it: nothing new
  assert.equal(due(worked([sub('pause', 'generate', 5)]), list(4), 6), null);                             // a human step left
  assert.equal(due(worked([move('wait', 'gate', 5)]), list(4), 6), null);                                 // a host wait left
  assert.equal(due(worked([move('merge', 'done', 5)], { 'harness-status': { state: 'done' } }), list(4), 6), 'moved into done');
  assert.equal(due(worked([move('gate', 'plan', 5)]), list(4), 4 + COMMITS_REFRESH_MINUTES), 'periodic');
  assert.equal(due(worked([move('gate', 'plan', 5)]), list(4), 3 + COMMITS_REFRESH_MINUTES), null);
  assert.equal(due(worked([move('merge', 'done', 5)], { 'harness-status': { state: 'done' } }), list(6), 600), null);   // done, refreshed after: left
  assert.equal(commitsDue(worked([]), list(0), { engines, engineName: 'e', now: Date.parse(at(3)), everyMs: 2 * MIN }), 'periodic');   // harness.json's own interval
});

// A projects folder with project p: ABC-1 to ABC-<n> in its sprint, each with a branch (work to find), and their lists as given.
function projectsWith(n, lists = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'commit-refresh-'));
  const tickets = Array.from({ length: n }, (_, i) => ({ key: `ABC-${i + 1}`, variations: [worked([move('backlog', 'plan', 0)])] }));
  for (const [key, l] of Object.entries(lists)) { mkdirSync(join(dir, 'p', 'work', key), { recursive: true }); writeFileSync(join(dir, 'p', 'work', key, 'commits-A.json'), JSON.stringify(l)); }
  return { dir, state: { harness: {}, projects: [{ id: 'p', engineName: 'e', engines, tickets }] } };
}
function context(dir, now) {
  const calls = [], logs = [];
  const ctx = { memory: { timers: new Map() }, paths: { projects: dir }, now: () => new Date(Date.parse(at(now.at))), log: (...a) => logs.push(a.join(' ')), commitLists: true,
    cli: async args => { calls.push(args.join(' ')); if (args[2] === 'ABC-2') throw new Error('glab: 503'); return '{}'; } };
  return { ctx, calls, logs };
}

test('ASS-558 AC3: refreshCommitLists runs ticket:refresh-commits for the due variations in the background, oldest first, at most MAX_PER_CHECK a minute; a failure is logged and the rest go on', async () => {
  const { dir, state } = projectsWith(MAX_PER_CHECK + 2, { 'ABC-1': list(-1), 'ABC-3': list(-30), 'ABC-4': list(0), 'ABC-5': list(-20) });
  const now = { at: 1 };
  const { ctx, calls, logs } = context(dir, now);
  await refreshCommitLists(ctx, state);
  assert.equal(calls.length, MAX_PER_CHECK);
  assert.equal(calls[0].startsWith('ticket:refresh-commits p ABC-'), true);
  assert.ok(!calls.includes('ticket:refresh-commits p ABC-1 A') && !calls.includes('ticket:refresh-commits p ABC-4 A'), 'fresh lists left');
  assert.deepEqual(calls.slice(-2), ['ticket:refresh-commits p ABC-3 A', 'ticket:refresh-commits p ABC-5 A']);   // the never-refreshed first, then the oldest
  assert.ok(logs.some(l => /ABC-2 A \(no list yet\): glab: 503/.test(l)), logs.join('\n'));
  await refreshCommitLists(ctx, state);
  assert.equal(calls.length, MAX_PER_CHECK);                        // not again within the minute
  now.at += CHECK_EVERY_MS / MIN;
  await refreshCommitLists(ctx, state);
  assert.ok(calls.length > MAX_PER_CHECK);
  const off = context(dir, now);
  off.ctx.commitLists = false;
  await refreshCommitLists(off.ctx, state);
  assert.deepEqual(off.calls, []);
});

test('ASS-558 AC3: a context made with COMMIT_LISTS_DISABLED=1 (the fixtures\' env) refreshes nothing; without it, it does', () => {
  assert.equal(createContext({ root: '/nowhere', env: { COMMIT_LISTS_DISABLED: '1' } }).commitLists, false);
  assert.equal(createContext({ root: '/nowhere', env: {} }).commitLists, true);
});

test('ASS-558 AC3: no more than MAX_PER_CHECK refreshes a job, the rest the next minute', async () => {
  const { dir, state } = projectsWith(MAX_PER_CHECK + 5);
  const { ctx, calls } = context(dir, { at: 1 });
  await refreshCommitLists(ctx, state);
  assert.equal(calls.length, MAX_PER_CHECK);
});
