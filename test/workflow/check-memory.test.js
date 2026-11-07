// The memory cleanup (ASS-62 AC6): the grouped and v2 engines check their
// project's memory once a day — engines/check-memory, its one agent step
// clean-memory — beside the health checks; the flat engines do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEngines, walk, engineDir } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const engine = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));

test('AC6: the grouped and v2 engines run check-memory daily; the flat engines have no memory cleanup', () => {
  for (const name of ['harness-development-v2', 'harness-development-grouped', 'example-development-grouped']) {
    const e = engine(name);
    assert.equal(e['check-memory-interval-seconds'], 86400, name);
    assert.deepEqual(e['check-memory-steps'].map(s => [s.id, s.action, s['exit-events']]), [['check-memory', { type: 'state-engine', engine: 'check-memory' }, [{ condition: { 'is-done': true } }]]], name);
  }
  for (const name of ['harness-development', 'example-development']) assert.equal(engine(name)['check-memory-steps'], undefined, name);
});

test('AC6: check-memory\'s agent checks every memory against the project as it stands now: corrects under the same document_id, or removes, what no longer holds, and reports it', () => {
  // Its run: the clean-memory agent's turn, then done.
  const run = walk(loadEngines(), 'check-memory');
  assert.deepEqual([run.trail[0], run.end, run.rests], ['check-memory/clean-memory', 'done', false]);
  assert.equal(engine('check-memory').steps.find(s => s.id === 'clean-memory').action.prompt, 'clean-memory');
  const prompt = readFileSync(join(ROOT, 'prompts', 'clean-memory', 'prompt.txt'), 'utf8');
  assert.match(prompt, /list_memories/);
  assert.match(prompt, /\{project-code-folder\}.*\{project-folder\}/s);
  assert.match(prompt, /retain the corrected fact under the same document_id.*else delete_document it/s);
  assert.match(prompt, /secret, credential, token, account email or other personal information: delete_document it/);
  assert.match(prompt, /\{ticket-folder\}\/memory-cleanup\.md/);
});

test('ASS-146 AC3: run scoped to a ticket ({ticket}: a deleted or reverted one), clean-memory lists that ticket\'s memories alone (memory:list) and keeps, corrects or deletes each; with none, every memory as before', () => {
  const prompt = readFileSync(join(ROOT, 'prompts', 'clean-memory', 'prompt.txt'), 'utf8');
  assert.match(prompt, /\{agent-sh\} memory:list \{project\} \{ticket\}/);
  assert.match(prompt, /metadata\.ticket/);
  assert.match(prompt, /deleted or its change reverted/);
  assert.match(prompt, /no other memory/i);
  assert.match(prompt, /With no ticket named, every memory/);
  assert.match(prompt, /1\. List every memory in the bank \(list_memories, page by page\)/);   // the daily check's own steps, as they were
  assert.ok(JSON.parse(readFileSync(join(ROOT, 'prompts', 'clean-memory', 'prompt.json'), 'utf8'))['input-arguments'].some(a => a.name === 'ticket' && a.required === false));
});

test('ASS-156 AC1: the scoped review checks the observations drawn from the ticket\'s facts too — last, as Hindsight drops one whose fact is deleted or corrected; one left that no longer holds goes in the report', () => {
  const prompt = readFileSync(join(ROOT, 'prompts', 'clean-memory', 'prompt.txt'), 'utf8');
  assert.match(prompt, /marked derived, Hindsight's observations drawn from them \(no document_id\)/);
  assert.match(prompt, /Hindsight deletes one itself when you delete or correct a fact it came from/);
  assert.match(prompt, /its tools cannot delete — name it in the report/);
});
