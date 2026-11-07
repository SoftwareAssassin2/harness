// question:accept and question:reject (ASS-31): the AI's judgement of an
// operator's answer, through the same locked writer as question:answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A ticket ABC-1 whose questions have the given statuses.
function ticket(...statuses) {
  const dir = mkdtempSync(join(tmpdir(), 'judge-'));
  mkdirSync(join(dir, 'p', 'work', 'ABC-1'), { recursive: true });
  const list = statuses.map((status, i) => ({ question: `Q${i}?`, answer: status === 'Asked' ? '' : `A${i}`, status, 'ai-feedback-if-not-accepted': '' }));
  writeFileSync(join(dir, 'p', 'work', 'ABC-1', 'questions-and-answers.json'), JSON.stringify({ list }, null, 4));
  return dir;
}
const cli = (dir, ...args) => run(AGENT, args, { env: { ...process.env, PROJECTS_DIR: dir } });
const file = dir => join(dir, 'p', 'work', 'ABC-1', 'questions-and-answers.json');
const list = dir => JSON.parse(readFileSync(file(dir), 'utf8')).list;

test('question:accept makes an Answered question Answer Accepted, leaving the rest alone', async () => {
  const dir = ticket('Answered', 'Answered');
  await cli(dir, 'question:accept', 'p', 'ABC-1', '1');
  assert.deepEqual(list(dir).map(q => q.status), ['Answered', 'Answer Accepted']);
  assert.equal(list(dir)[1].answer, 'A1');
});

test('question:reject makes an Answered question Answer Rejected, with the why', async () => {
  const dir = ticket('Answered');
  await cli(dir, 'question:reject', 'p', 'ABC-1', '0', 'Says which, not when.');
  assert.deepEqual([list(dir)[0].status, list(dir)[0]['ai-feedback-if-not-accepted'], list(dir)[0].answer], ['Answer Rejected', 'Says which, not when.', 'A0']);
});

test('a rejected question answered again goes back to Answered, for the AI to judge again', async () => {
  const dir = ticket('Answered');
  await cli(dir, 'question:reject', 'p', 'ABC-1', '0', 'Too vague.');
  await cli(dir, 'question:answer', 'p', 'ABC-1', '0', 'Every 2 minutes.');
  assert.equal(list(dir)[0].status, 'Answered');
  await cli(dir, 'question:accept', 'p', 'ABC-1', '0');
  assert.equal(list(dir)[0].status, 'Answer Accepted');
});

test('only an Answered question can be judged; a bad call changes nothing', async () => {
  const dir = ticket('Asked', 'Answer Accepted', 'Answer Rejected', 'Answered');
  const before = readFileSync(file(dir), 'utf8');
  for (const i of ['0', '1', '2']) {
    await assert.rejects(cli(dir, 'question:accept', 'p', 'ABC-1', i), /not Answered/);
    await assert.rejects(cli(dir, 'question:reject', 'p', 'ABC-1', i, 'no'), /not Answered/);
  }
  await assert.rejects(cli(dir, 'question:accept', 'p', 'ABC-1', '9'), /no question 9/);
  await assert.rejects(cli(dir, 'question:accept', 'p', 'ABC-9', '0'), /no file/);
  await assert.rejects(cli(dir, 'question:accept', 'p', '../p', '0'), /ticket/);
  await assert.rejects(cli(dir, 'question:reject', 'p', 'ABC-1', '3', '  '), /why/);
  await assert.rejects(cli(dir, 'question:reject', 'p', 'ABC-1', '3'), /usage/);
  assert.equal(readFileSync(file(dir), 'utf8'), before);
});
