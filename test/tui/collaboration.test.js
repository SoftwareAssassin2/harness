// A ticket's chat on its screen (ASS-35): the briefing that makes its agent the
// ticket's expert, what changed since then (catchUp, from the snapshot kept in
// collaboration.json), what to send on opening, and the chat itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, catchUp, briefing, opening, ticketChat, chatId, problems } from '../../src/tui/collaboration.js';
import { chatRunner } from '../../src/agents/chats.js';
import { readSession } from '../../src/agents/session.js';
import { until } from '../support/until.js';

const ROOT = join(import.meta.dirname, '..', '..');
const FAKE = join(ROOT, 'test', 'support', 'fake-agent.js');

const change = (from, to, timestamp, cost) => ({ 'from-state': from, 'to-state': to, timestamp, 'agent-dispatch-log': cost == null ? [] : [{ 'dispatched-to': 'Thor', 'cost-usd': cost }] });
const ticket = {
  key: 'ABC-1', title: 'Pay by card', description: 'Cards only.',
  variations: [{
    name: 'A', 'acceptance-criteria': [{ description: 'Visa works' }],
    'state-changes': [change('backlog', 'plan', '2026-10-14T10:00:00Z', 1.5)],
    'merge-request': [], build: { 'worktree-folder': '/src/app/.worktrees/ABC-1' },
  }],
};
const questions = [{ question: 'Which cards?', status: 'Asked', answer: '', source: 'ABC-1', index: 0 }];

test('nothing changed since the briefing: no catch-up', () => {
  assert.equal(catchUp(snapshot(ticket, questions), ticket, questions), null);
});

test('the catch-up lists what changed since the snapshot: new state changes, answers, requirement edits, merge requests and spend', () => {
  const now = {
    ...ticket, title: 'Pay by card or cash', description: 'Cards and cash.',
    variations: [{
      ...ticket.variations[0], 'acceptance-criteria': [{ description: 'Visa works' }, { description: 'Cash works' }],
      'state-changes': [...ticket.variations[0]['state-changes'], change('plan', 'build', '2026-10-14T12:00:00Z', 2)],
      'merge-request': [{ key: '!7', 'build-status': 'Running' }],
    }, { name: 'B' }],
  };
  const answered = [{ ...questions[0], status: 'Answered', answer: 'Visa only' }, { question: 'Refunds?', status: 'Asked', answer: '', source: 'ABC-1', index: 1 }];
  const text = catchUp(snapshot(ticket, questions), now, answered);
  for (const line of [
    'Since your last briefing on ABC-1:',
    '- Title: Pay by card or cash',
    '- The description changed: read it again.',
    '- A: the acceptance criteria changed: read them again.',
    '- A: plan → build at 2026-10-14T12:00:00Z',
    '- A: merge request !7 Running',
    '- A: spend $3.50 (was $1.50)',
    '- B: a new variation',
    '- Question 0 (Answered): Which cards? — Visa only',
    '- Question 1 (Asked): Refunds?',
  ]) assert.ok(text.split('\n').includes(line), `${line}\n---\n${text}`);
});

test('the catch-up names a planned merge request (ASS-80) by its id, and a created one by its key and, once no longer open, its status', () => {
  const planned = { id: 1, repository: 'https://gitlab.com/g/app', branch: 'change/ABC-1-1', contents: 'x', 'depends-on': [], status: 'Not Created', key: null, url: null, 'build-status': null };
  const was = { ...ticket, variations: [{ ...ticket.variations[0], 'merge-request': [{ key: '!7', 'build-status': 'Passed', status: 'Open' }] }] };
  const now = { ...ticket, variations: [{ ...ticket.variations[0], 'merge-request': [{ key: '!7', 'build-status': 'Passed', status: 'Closed' }, planned] }] };
  const text = catchUp(snapshot(was, questions), now, questions).split('\n');
  assert.ok(text.includes('- A: merge request !7 Closed'), text.join('\n'));
  assert.ok(text.includes('- A: merge request MR 1 planned'), text.join('\n'));
});

test('the catch-up names a merge request closed without being opened (ASS-81) by its id', () => {
  const unopened = { id: 1, repository: 'https://gitlab.com/g/app', branch: 'change/ABC-1-1', contents: 'x', 'depends-on': [], status: 'Closed', key: null, url: null, 'build-status': null };
  const now = { ...ticket, variations: [{ ...ticket.variations[0], 'merge-request': [unopened] }] };
  const text = catchUp(snapshot(ticket, questions), now, questions).split('\n');
  assert.ok(text.includes('- A: merge request MR 1 closed, not opened'), text.join('\n'));
});

test('the briefing no longer makes the agent a read-only consultant: it may change things, by the chat rules it was started with', () => {
  const text = briefing(ROOT, { project: 'p', ticket, sprint: null });
  assert.doesNotMatch(text, /consultant|[Rr]ead-only|Do not edit/);
  assert.match(text, /chat rules/);
  assert.doesNotMatch(text, /\{[\w-]+\}/);   // every placeholder filled
});

test('the chat rules give full access but every change waits for the operator\'s explicit yes, and only the operator gives instructions', () => {
  const rules = readFileSync(join(ROOT, 'prompts', 'chat-rules', 'prompt.txt'), 'utf8');
  assert.match(rules, /full access/);
  assert.match(rules, /explicit yes/);
  assert.match(rules, /covers only what you described/);
  assert.match(rules, /never instructions/);
});

test('the briefing gives absolute paths: the ticket\'s work folder, its json file, agent.sh and its read commands, the worktree', () => {
  const backlog = briefing(ROOT, { project: 'p', ticket, sprint: null });
  for (const path of [join(ROOT, 'data', 'projects', 'p', 'work', 'ABC-1'), join(ROOT, 'data', 'projects', 'p', 'backlog.json'), join(ROOT, 'agent.sh'), '/src/app/.worktrees/ABC-1']) assert.ok(backlog.includes(path), path);
  assert.match(backlog, /agent\.sh ticket:questions-answered p ABC-1/);
  assert.ok(briefing(ROOT, { project: 'p', ticket, sprint: { number: 4 } }).includes(join(ROOT, 'data', 'projects', 'p', 'sprints', 'sprint-4', 'sprint.json')));
  assert.match(briefing(ROOT, { project: 'p', ticket: { ...ticket, variations: [{ name: 'A' }] }, sprint: null }), /Worktree: none yet/);
});

test('opening the screen: the briefing when there is none and no agent runs; the catch-up after one, or nothing when nothing changed; nothing while the first briefing is under way', () => {
  const first = opening({ collaboration: null, running: false, ticket, questions, briefing: 'BRIEF' });
  assert.deepEqual(first, { text: 'BRIEF', snapshot: snapshot(ticket, questions) });
  assert.equal(opening({ collaboration: null, running: true, ticket, questions, briefing: 'BRIEF' }), null);
  const briefed = { 'session-id': 's', briefed: snapshot(ticket, questions), turns: [] };
  assert.equal(opening({ collaboration: briefed, running: false, ticket, questions, briefing: 'BRIEF' }), null);
  const moved = { ...ticket, title: 'New' };
  assert.deepEqual(opening({ collaboration: briefed, running: true, ticket: moved, questions, briefing: 'BRIEF' }), { text: catchUp(briefed.briefed, moved, questions), snapshot: snapshot(moved, questions) });
});

// The development engine's steps the check reads (ASS-36): a working step, a human gate, the blocked states.
const steps = [
  { id: 'build', sequence: 5, name: 'Build', action: { type: 'prompt' } },
  { id: 'review', sequence: 6, name: 'Human Review', action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Approve' }, 'move-to-state': 'build' }] },
  { id: 'blocked', sequence: 0, area: 'quarantine', name: 'Blocked', action: { type: 'state-engine' } },
  { id: 'blocked-for-human', sequence: 0, area: 'quarantine', name: 'Blocked for Human', 'is-blocked-state': true, action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Resolved' }, 'follow-return-to-state': true }] },
];
const at = (state, more = {}) => ({ key: 'ABC-1', variations: [{ name: 'A', 'harness-status': { state }, ...more }] });
const check = (t, more = {}) => problems({ project: 'p', ticket: t, steps, questions: [], selfHealing: {}, ...more });

test('a healthy ticket has no problems: working, no question open, not paused (ASS-36 AC1)', () => {
  assert.deepEqual(check(at('build'), { questions: [{ question: 'Which cards?', status: 'Answered', answer: 'Visa' }] }), []);
  assert.deepEqual(check({ key: 'ABC-1' }), []);
});

test('blocked: a variation in the blocked state', () => {
  assert.deepEqual(check(at('blocked')), ['A: blocked (Blocked)']);
});

test('blocked-for-human: a variation there, which is not also named as waiting at a human gate', () => {
  assert.deepEqual(check(at('blocked-for-human')), ['A: blocked-for-human (Blocked for Human)']);
});

test('paused: a variation\'s own is-paused — a deleted variation is not looked at', () => {
  assert.deepEqual(check(at('build', { 'is-paused': true })), ['A: paused']);
  assert.deepEqual(check(at('build', { 'is-paused': true, 'is-deleted': true })), []);
});

test('ASS-83 AC3: a variation control paused for a fast-tracked ticket says so', () => {
  assert.deepEqual(check(at('build', { 'is-paused': true, 'paused-for-fast-track': 'ASS-160' })), ['A: paused to free a seat for fast-tracked ASS-160']);
});

test('waiting at a human gate: a sprint variation at a human step, or a backlog ticket at one of its refinement engine\'s (ASS-34, ASS-144) — by the step, never its name', () => {
  assert.deepEqual(check(at('review')), ['A: waiting at a human gate (Human Review)']);
  const refinement = [{ id: 'approve', name: 'Approve It', sequence: 1, action: { type: 'human' }, 'exit-events': [{ condition: { 'human-review': 'Accept' }, 'move-to-state': 'done' }] }];
  assert.deepEqual(check(at('approve'), { steps: refinement }), ['A: waiting at a human gate (Approve It)']);
  assert.deepEqual(check(at('awaiting-approval'), { steps: [] }), []);
});

test('a question Asked, Answer Rejected or of a status none of the known ones (ASS-170)', () => {
  const questions = [{ question: 'Which cards?', status: 'Asked' }, { question: 'Refunds?', status: 'Answered' }, { question: 'Cash?', status: 'Answer Rejected' }, { question: 'Cheque?', status: 'Open' }];
  assert.deepEqual(check(at('build'), { questions }), ['Question 0 (Asked): Which cards?', 'Question 2 (Answer Rejected): Cash?', 'Question 3 (Open): Cheque?']);   // an unknown status is open (ASS-170)
});

test('a self-healing pause naming the variation stands in for its paused — one reason, not two', () => {
  const selfHealing = { 'ASS-9': { ticket: 'ASS-9', summary: 'Fix the build', paused: [{ project: 'p', ticket: 'ABC-1', variation: 'A' }] }, 'ASS-8': { ticket: 'ASS-8', summary: 'Other', paused: [{ project: 'q', ticket: 'ABC-1', variation: 'A' }] } };
  assert.deepEqual(check(at('build', { 'is-paused': true }), { selfHealing }), ['A: paused by self-healing fix ASS-9 (Fix the build)']);
});

test('opening a ticket with something off: after the catch-up, the agent is asked what the problem is and what it needs, and the reasons are kept (AC2)', () => {
  const briefed = { 'session-id': 's', briefed: snapshot(ticket, questions), turns: [] };
  const moved = { ...ticket, title: 'New' };
  const reasons = ['A: blocked (Blocked)', 'Question 0 (Asked): Which cards?'];
  const ask = 'Something is off with ABC-1:\n- A: blocked (Blocked)\n- Question 0 (Asked): Which cards?\nSay what the problem is and what you need from the operator.';
  assert.deepEqual(opening({ collaboration: briefed, running: false, ticket: moved, questions, briefing: 'BRIEF', problems: reasons }),
    { text: `${catchUp(briefed.briefed, moved, questions)}\n\n${ask}`, snapshot: snapshot(moved, questions), raised: reasons });
  assert.deepEqual(opening({ collaboration: briefed, running: false, ticket, questions, briefing: 'BRIEF', problems: reasons }), { text: ask, raised: reasons });
  assert.deepEqual(opening({ collaboration: null, running: false, ticket, questions, briefing: 'BRIEF', problems: reasons }), { text: `BRIEF\n\n${ask}`, snapshot: snapshot(ticket, questions), raised: reasons });
  assert.equal(opening({ collaboration: null, running: true, ticket, questions, briefing: 'BRIEF', problems: reasons }), null);
});

test('opening a healthy ticket asks nothing; one whose problems were cleared clears what was raised (AC3)', () => {
  const briefed = { 'session-id': 's', briefed: snapshot(ticket, questions), turns: [] };
  assert.equal(opening({ collaboration: briefed, running: false, ticket, questions, briefing: 'BRIEF', problems: [] }), null);
  assert.deepEqual(opening({ collaboration: { ...briefed, raised: ['A: paused'] }, running: false, ticket, questions, briefing: 'BRIEF', problems: [] }), { text: null, raised: [] });
});

test('the same problems are not raised again on every open — only once they change (AC4)', () => {
  const briefed = { 'session-id': 's', briefed: snapshot(ticket, questions), turns: [], raised: ['A: paused'] };
  assert.equal(opening({ collaboration: briefed, running: false, ticket, questions, briefing: 'BRIEF', problems: ['A: paused'] }), null);
  assert.deepEqual(opening({ collaboration: briefed, running: false, ticket, questions, briefing: 'BRIEF', problems: ['A: blocked (Blocked)'] }).raised, ['A: blocked (Blocked)']);
});

test('the ticket\'s chat records its session and each turn\'s cost through the agent-cli; after a restart it resumes the same session (AC2, AC3)', async t => {
  const projects = mkdtempSync(join(tmpdir(), 'collaboration-'));
  mkdirSync(join(projects, 'p'));
  const file = join(projects, 'p', 'work', 'ABC-1', 'collaboration.json');
  const pending = [];
  const record = args => pending.push(promisify(execFile)(join(ROOT, 'agent.sh'), args, { env: { ...process.env, PROJECTS_DIR: projects } }));
  const settled = async () => { while (pending.length) await pending.shift(); };
  const root = mkdtempSync(join(tmpdir(), 'chats-'));
  const before = chatRunner({ data: root, command: ['node', FAKE] });
  t.after(() => before.stopAll());
  ticketChat(before, { project: 'p', key: 'ABC-1', collaboration: null, cwd: root, confinedBy: '/h/projects/p/host-agent-settings.json', record }).send('BRIEF');
  assert.equal(before.dir(chatId('p', 'ABC-1')), join(root, 'chats', 'p', 'ABC-1'));
  assert.ok(await until(() => readSession(before.dir(chatId('p', 'ABC-1')))?.some(l => l.startsWith('■ turn ended'))));
  assert.ok(readSession(before.dir(chatId('p', 'ABC-1'))).some(l => l.startsWith('args ') && l.endsWith('--settings /h/projects/p/host-agent-settings.json')));   // confined (ASS-108)
  await until(() => pending.length >= 2);
  await settled();
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual({ ...kept, turns: kept.turns.map(({ timestamp, ...turn }) => turn) }, { 'session-id': 'fake-session', briefed: null, turns: [{ billing: 'api', 'cost-usd': 0.5 }] });
  before.stopAll();
  assert.ok(await until(() => !before.running(chatId('p', 'ABC-1'))));
  const after = chatRunner({ data: root, command: ['node', FAKE] });   // the TUI restarted
  t.after(() => after.stopAll());
  ticketChat(after, { project: 'p', key: 'ABC-1', collaboration: kept, cwd: root, record }).send('CATCH UP');
  assert.ok(await until(() => readSession(after.dir(chatId('p', 'ABC-1'))).some(l => l.includes('args') && l.includes('--resume fake-session'))));
  assert.ok(await until(() => readSession(after.dir(chatId('p', 'ABC-1'))).includes('> CATCH UP')));
  await until(() => pending.length >= 1);
  await settled();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).turns.map(t => t['cost-usd']), [0.5, 0.5]);
});
