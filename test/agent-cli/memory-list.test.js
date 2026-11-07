// memory:list <project> <ticket-key> (ASS-146) — the memories an agent saved
// working one ticket: those of the project's Hindsight bank whose
// metadata.ticket is the key. A deleted or reverted ticket's review
// (engines/check-memory, scoped) checks these alone. Hindsight is the stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './harness-fixture.js';
import { fakeHindsight } from '../support/fake-hindsight.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
const unit = (text, ticket, doc) => ({ id: doc, text, context: 'general', metadata: ticket ? { ticket, step: 'build', model: 'claude-opus-5', date: '2026-10-20' } : {}, document_id: doc, mentioned_at: '2026-10-20T00:00:00Z', fact_type: 'world', state: 'valid' });

test('ASS-146 AC3: memory:list lists only the memories whose metadata.ticket is the key, any case, each with its document_id and source', async t => {
  const f = fixture();
  const hindsight = await fakeHindsight();
  t.after(() => hindsight.close());
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p.hindsight = { port: hindsight.port, 'llm-api-key': null }; });
  hindsight.banks.set('p', [unit('the build needs node 24', 'ABC-3', 'd1'), unit('jira is slow', 'ABC-4', 'd2'), unit('use pnpm', 'abc-3', 'd3'), unit('a note', null, 'd4')]);
  const listed = JSON.parse((await f.agent('memory:list', 'p', 'abc-3')).stdout);
  assert.deepEqual(listed.map(m => [m.document_id, m.text, m.metadata.ticket]), [['d1', 'the build needs node 24', 'ABC-3'], ['d3', 'use pnpm', 'abc-3']]);
  assert.deepEqual(JSON.parse((await f.agent('memory:list', 'p', 'ABC-9')).stdout), []);
});

test('ASS-146: memory:list fails, naming it, when the project has no Hindsight or it is not answering', async () => {
  const f = fixture();
  await assert.rejects(f.agent('memory:list', 'p', 'ABC-3'), e => /memory:list: p has no hindsight in project\.json/.test(e.stderr));
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p.hindsight = { port: 1, 'llm-api-key': null }; });
  await assert.rejects(f.agent('memory:list', 'p', 'ABC-3'), e => /memory:list: p's Hindsight is not answering on 127\.0\.0\.1:1/.test(e.stderr));
});

// ASS-156: Hindsight's consolidation writes observations from the facts —
// fact_type "observation", no document_id, no metadata — each naming the facts
// it came from in source_memory_ids. Hindsight 1.1.0 deletes an observation
// itself when any of its source facts is deleted or replaced, so those it still
// holds are drawn from facts that still stand.
const obs = (id, text, sources) => ({ id, text, context: '', metadata: {}, document_id: null, mentioned_at: '2026-10-21T00:00:00Z', fact_type: 'observation', state: 'valid', source_memory_ids: sources });

test('ASS-156 AC1: memory:list also lists, marked derived, every observation drawn from one of the ticket\'s facts', async t => {
  const f = fixture();
  const hindsight = await fakeHindsight();
  t.after(() => hindsight.close());
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p.hindsight = { port: hindsight.port, 'llm-api-key': null }; });
  hindsight.banks.set('p', [unit('the build needs node 24', 'ABC-3', 'd1'), unit('jira is slow', 'ABC-4', 'd2'),
    obs('o1', 'builds need node 24 and jira is slow', ['d1', 'd2']), obs('o2', 'jira is slow', ['d2']), obs('o3', 'node 24', ['d1'])]);
  const listed = JSON.parse((await f.agent('memory:list', 'p', 'ABC-3')).stdout);
  assert.deepEqual(listed.map(m => [m.id, m.derived ?? false]), [['d1', false], ['o1', true], ['o3', true]]);
  assert.deepEqual(listed[1].source_memory_ids, ['d1', 'd2']);
});

test('ASS-156 AC1: the stub, as Hindsight 1.1.0, deletes the observations drawn from a fact when its document is deleted or replaced; the review sees none left of them', async t => {
  const hindsight = await fakeHindsight();
  t.after(() => hindsight.close());
  const mcp = (name, args) => fetch(`http://127.0.0.1:${hindsight.port}/mcp/p/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  hindsight.banks.set('p', [unit('the build needs node 24', 'ABC-3', 'd1'), unit('jira is slow', 'ABC-4', 'd2'), unit('use pnpm', 'ABC-5', 'd3'),
    obs('o1', 'builds need node 24 and jira is slow', ['d1', 'd2']), obs('o2', 'jira is slow', ['d2']), obs('o3', 'pnpm', ['d3'])]);
  await mcp('delete_document', { document_id: 'd1' });
  assert.deepEqual(hindsight.banks.get('p').map(m => m.id), ['d2', 'd3', 'o2', 'o3']);
  await mcp('retain', { content: 'use npm', document_id: 'd3' });
  assert.deepEqual(hindsight.banks.get('p').map(m => m.text), ['jira is slow', 'jira is slow', 'use npm']);
});
