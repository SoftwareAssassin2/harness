// Every agent's memory, as its prompt tells it (ASS-62): the grouped and v2
// engines wrap each dispatch in receive-dispatch-grouped and
// receive-pair-dispatch-grouped, which tell the agent to recall at the start,
// to retain what is worth keeping at the end with its source, never what must
// not be kept, and to correct a memory found untrue rather than add beside it.
// The flat engines keep receive-dispatch and receive-pair-dispatch as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './harness-fixture.js';
import { engineDir } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...path) => readFileSync(join(ROOT, ...path), 'utf8');
const engine = name => JSON.parse(readFileSync(join(engineDir(name), 'state-engine.json'), 'utf8'));

test('AC7: agent:dispatch fills a wrapper\'s {step}, {model} and {date} — the record\'s state, its model and today (UTC) — the source an agent saves with each memory', async () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'prompts', 'receive-dispatch', 'prompt.txt'), 'source: {"ticket": "{ticket}", "step": "{step}", "model": "{model}", "date": "{date}"}\n{assignment}\n');
  const { stdout } = await f.agent('agent:dispatch', 'Daredevil');
  const today = new Date().toISOString().slice(0, 10);
  assert.match(stdout, new RegExp(`\\nsource: \\{"ticket": "ABC-3", "step": "generate-solution", "model": "claude-opus-5", "date": "${today}"\\}\\n`));
});

test('the grouped and v2 engines wrap every dispatch in the -grouped wrappers; the flat engines keep theirs', () => {
  for (const name of ['harness-development-v2', 'harness-development-grouped', 'example-development-grouped']) {
    assert.equal(engine(name)['receive-dispatch-prompt'], 'receive-dispatch-grouped', name);
    assert.equal(engine(name)['receive-pair-dispatch-prompt'], 'receive-pair-dispatch-grouped', name);
  }
  for (const name of ['harness-development', 'example-development']) {
    assert.equal(engine(name)['receive-dispatch-prompt'], 'receive-dispatch', name);
    assert.equal(engine(name)['receive-pair-dispatch-prompt'], 'receive-pair-dispatch', name);
  }
});

test('AC3, AC6, AC7: both -grouped wrappers do what their flat wrapper does, plus the memory instructions: recall first, correct what is untrue, retain with its source, never secrets, personal information or the ticket\'s own text', () => {
  for (const wrapper of ['receive-dispatch', 'receive-pair-dispatch']) {
    const grouped = read('prompts', `${wrapper}-grouped`, 'prompt.txt');
    const memory = grouped.slice(grouped.indexOf('Memory:'), grouped.indexOf('Here is your assignment:'));
    // ASS-258: it fills what its flat wrapper fills — every placeholder of it — however either is worded.
    const placeholders = t => new Set(t.match(/\{[a-z-]+\}/g));
    for (const p of placeholders(read('prompts', wrapper, 'prompt.txt'))) assert.ok(placeholders(grouped.replace(memory, '')).has(p), `${wrapper}-grouped fills ${p}`);
    assert.match(memory, /^Memory: .*hindsight MCP tools.*If they are unavailable, carry on without them\./s);
    assert.match(memory, /At the start of this step.* recall /s);
    assert.match(memory, /no longer true.*retain the corrected fact with the same document_id.*delete_document/s);
    assert.match(memory, /At the end of this step, retain each root cause, toolchain quirk or settled decision/);
    assert.match(memory, /metadata \{"ticket": "\{ticket\}", "step": "\{step\}", "model": "\{model\}", "date": "\{date\}"\}/);
    assert.match(memory, /Never retain secrets, credentials or tokens; account emails or other personal information.*claude auth status.*; or anything the ticket already says\./s);
    assert.deepEqual(JSON.parse(read('prompts', `${wrapper}-grouped`, 'prompt.json')).persona, JSON.parse(read('prompts', wrapper, 'prompt.json')).persona);
  }
});
