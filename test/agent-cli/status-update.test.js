// assignments:status-update — an agent saying, in its own words, what it is doing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

function assignments() {
  const file = join(mkdtempSync(join(tmpdir(), 'su-')), 'assignments.json');
  writeFileSync(file, JSON.stringify({ status: 'Running', assignments: [{ 'agent-name': 'Spock', 'ai-feedback-short': 'Reviewing' }, { 'agent-name': 'Leia' }] }, null, 4));
  return file;
}
const update = (file, ...args) => run(AGENT, ['assignments:status-update', ...args], { env: { ...process.env, ASSIGNMENTS_FILE: file } });
const read = file => JSON.parse(readFileSync(file, 'utf8'));

test('assignments:status-update writes the agent\'s ai-status-update-short and when, leaving the rest alone', async () => {
  const file = assignments();
  await update(file, 'Spock', 'Fixing the latency budget');
  const [spock, leia] = read(file).assignments;
  assert.match(spock['last-ai-status-update'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(spock, { 'agent-name': 'Spock', 'ai-feedback-short': 'Reviewing', 'ai-status-update-short': 'Fixing the latency budget', 'last-ai-status-update': spock['last-ai-status-update'] });
  assert.deepEqual(leia, { 'agent-name': 'Leia' });
  await update(file, 'Spock', 'Done; waiting on review');            // a new one replaces the last
  assert.equal(read(file).assignments[0]['ai-status-update-short'], 'Done; waiting on review');
  await update(file, 'Spock', 'x'.repeat(34));                       // the longest allowed
  assert.equal(read(file).assignments[0]['ai-status-update-short'], 'x'.repeat(34));
});

test('assignments:status-update fails, writing nothing, for an agent with no assignment, an empty update or one over 34 characters', async () => {
  const file = assignments();
  const before = readFileSync(file, 'utf8');
  await assert.rejects(update(file, 'Hulk', 'Smashing'), /no assignment for Hulk/);
  await assert.rejects(update(file, 'Spock', '  '), /empty/);
  await assert.rejects(update(file, 'Spock', 'x'.repeat(35)), /assignments:status-update: the status update is longer than 34 characters/);
  await assert.rejects(update(file, 'Spock'), /usage/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

// ASS-463 AC3: the update from a file, so a host agent's call stays one bare command line whatever the text holds.
test('ASS-463: assignments:status-update --from <file> writes that file\'s text, its trailing newline dropped; a missing file, an over-long text or a stray argument fails, writing nothing', async () => {
  const file = assignments();
  const dir = mkdtempSync(join(tmpdir(), 'su-from-'));
  const text = join(dir, 'update.txt');
  writeFileSync(text, 'it\'s "$HOME" & `x`; ok\n');
  await update(file, 'Spock', '--from', text);
  assert.equal(read(file).assignments[0]['ai-status-update-short'], 'it\'s "$HOME" & `x`; ok');
  const before = readFileSync(file, 'utf8');
  await assert.rejects(update(file, 'Spock', '--from', join(dir, 'none.txt')), /assignments:status-update: no file/);
  writeFileSync(text, 'y'.repeat(35));
  await assert.rejects(update(file, 'Spock', '--from', text), /longer than 34 characters/);
  await assert.rejects(update(file, 'Spock', 'a', 'b'), /usage/);
  assert.equal(readFileSync(file, 'utf8'), before);
});
