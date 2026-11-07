// question:ask (ASS-170): the one way an agent asks a question — appended
// Asked, through the same locked writer as the other question commands, so
// control counts it open. It says whether it blocks (ASS-248): a blocking one
// holds its ticket for the operator; a non-blocking one is gone on with, its
// recommended answer the assumption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

// Project p, with ticket ABC-1's work folder but no questions file yet.
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'ask-'));
  mkdirSync(join(dir, 'p', 'work', 'ABC-1'), { recursive: true });
  return dir;
}
const ask = (dir, ...args) => run(AGENT, ['question:ask', 'p', ...args], { env: { ...process.env, PROJECTS_DIR: dir } });
const ticketFile = dir => join(dir, 'p', 'work', 'ABC-1', 'questions-and-answers.json');
const list = file => JSON.parse(readFileSync(file, 'utf8')).list;

test('question:ask appends an Asked question with every field a question has, blocking or not as its flag says (ASS-248 AC1)', async () => {
  const dir = project();
  await ask(dir, 'ABC-1', '--blocking', 'Which cards?', 'AC2 depends on it.', 'Visa only.');
  await ask(dir, 'ABC-1', '--non-blocking', 'Refunds?', '', 'None.');
  const [first, second] = list(ticketFile(dir));
  assert.match(first['asked-time-stamp'], STAMP);
  assert.deepEqual(Object.keys(first), ['question', 'recomended-answer', 'answer', 'why-asked', 'why-this-answer', 'scope', 'asked-on-ticket', 'asked-time-stamp', 'answered-time-stamp', 'status', 'ai-feedback-if-not-accepted', 'blocking']);
  assert.deepEqual({ ...first, 'asked-time-stamp': '' }, {
    question: 'Which cards?', 'recomended-answer': 'Visa only.', answer: '', 'why-asked': 'AC2 depends on it.', 'why-this-answer': '', scope: '',
    'asked-on-ticket': 'ABC-1', 'asked-time-stamp': '', 'answered-time-stamp': '', status: 'Asked', 'ai-feedback-if-not-accepted': '', blocking: true,
  });
  assert.deepEqual([second.question, second['why-asked'], second['recomended-answer'], second.status, second.blocking], ['Refunds?', '', 'None.', 'Asked', false]);
});

test('question:ask takes its flag anywhere after the ticket (ASS-248 AC1)', async () => {
  const dir = project();
  await ask(dir, 'ABC-1', 'Which cards?', 'Why.', 'Visa only.', '--non-blocking');
  await ask(dir, 'ABC-1', 'Which region?', '--blocking', 'Why.', 'EU.');
  assert.deepEqual(list(ticketFile(dir)).map(q => [q.question, q['why-asked'], q['recomended-answer'], q.blocking]), [['Which cards?', 'Why.', 'Visa only.', false], ['Which region?', 'Why.', 'EU.', true]]);
});

test('question:ask refuses a missing flag, both flags, or no recommended answer, saying which, writing nothing (ASS-248 AC1)', async () => {
  const dir = project();
  await assert.rejects(ask(dir, 'ABC-1', 'Which cards?', 'Why.', 'Visa only.'), /exactly one of --blocking or --non-blocking/);
  await assert.rejects(ask(dir, 'ABC-1', '--blocking', '--non-blocking', 'Which cards?', 'Why.', 'Visa only.'), /exactly one of --blocking or --non-blocking/);
  await assert.rejects(ask(dir, 'ABC-1', '--blocking', '--blocking', 'Which cards?', 'Why.', 'Visa only.'), /exactly one of --blocking or --non-blocking/);
  await assert.rejects(ask(dir, 'ABC-1', '--blocking', 'Which cards?', 'Why.', ' '), /recommended answer is empty/);
  await assert.rejects(ask(dir, 'ABC-1', '--non-blocking', 'Which cards?', 'Why.'), /usage/);
  assert.equal(existsSync(ticketFile(dir)), false);
});

test('question:ask global goes in the project\'s global questions file, keeping what is there', async () => {
  const dir = project();
  const global = join(dir, 'p', 'global-questions-and-answers.json');
  writeFileSync(global, JSON.stringify({ list: [{ question: 'Old?', status: 'Answer Accepted' }] }));
  await ask(dir, 'global', '--blocking', 'Which region?', '', 'EU.');
  assert.deepEqual(list(global).map(q => [q.question, q.status, q['asked-on-ticket']]), [['Old?', 'Answer Accepted', undefined], ['Which region?', 'Asked', '']]);
});

test('question:ask refuses an empty question, a bad name or a missing ticket folder, writing nothing', async () => {
  const dir = project();
  await assert.rejects(ask(dir, 'ABC-1', '--blocking', '  ', '', 'x'), /empty/);
  await assert.rejects(ask(dir, 'ABC-1'), /usage/);
  await assert.rejects(ask(dir, '../p', '--blocking', 'Q?', '', 'x'), /ticket/);
  await assert.rejects(ask(dir, 'ABC-9', '--blocking', 'Q?', '', 'x'), /no file/);
  assert.equal(existsSync(ticketFile(dir)), false);
});
