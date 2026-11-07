// Each project's memory (ASS-62): its own Hindsight instance on the Mac, one
// bank named after the project, reached over MCP — from the host at
// 127.0.0.1:<port>, from a ticket's VM at host.lima.internal:<port>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryMcpConfig, memoryPort } from '../../src/agents/memory.js';

test('AC2: a project\'s MCP configuration names its own instance and bank — 127.0.0.1 on the host, host.lima.internal in a VM', () => {
  const project = { id: 'example', json: { hindsight: { port: 8892, 'llm-api-key': null } } };
  assert.equal(memoryPort(project), 8892);
  assert.deepEqual(memoryMcpConfig(project), { mcpServers: { hindsight: { type: 'http', url: 'http://127.0.0.1:8892/mcp/example/' } } });
  assert.deepEqual(memoryMcpConfig(project, { vm: true }), { mcpServers: { hindsight: { type: 'http', url: 'http://host.lima.internal:8892/mcp/example/' } } });
});

test('a project without hindsight in its project.json has no memory', () => {
  assert.equal(memoryPort({ id: 'p', json: {} }), null);
  assert.equal(memoryMcpConfig({ id: 'p', json: {} }), undefined);
});

test('AC8: listMemories lists a project\'s memories with their source; deleteMemory deletes one — the document it was retained as — so it is never recalled again', async t => {
  const { fakeHindsight } = await import('../support/fake-hindsight.js');
  const { listMemories, deleteMemory } = await import('../../src/agents/memory.js');
  const h = await fakeHindsight();
  t.after(h.close);
  const call = (name, args) => fetch(`http://127.0.0.1:${h.port}/mcp/p/`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then(r => r.json());
  const source = { ticket: 'ASS-62', step: 'plan', model: 'claude-opus-5-5', date: '2026-10-25' };
  await call('retain', { content: 'npm test runs every suite', document_id: 'tests-npm', metadata: source });
  await call('retain', { content: 'zot listens on 127.0.0.1', document_id: 'zot-loopback', metadata: source });
  const listed = await listMemories(h.port, 'p');
  assert.deepEqual(listed.map(m => [m.text, m.document_id, m.metadata]), [['npm test runs every suite', 'tests-npm', source], ['zot listens on 127.0.0.1', 'zot-loopback', source]]);
  await deleteMemory(h.port, 'p', 'tests-npm');
  assert.deepEqual((await listMemories(h.port, 'p')).map(m => m.document_id), ['zot-loopback']);
  assert.deepEqual(JSON.parse((await call('recall', { query: 'npm test suite' })).result.content[0].text).results, []);
  await h.close();
  await assert.rejects(listMemories(h.port, 'p'), /p's Hindsight is not answering on 127\.0\.0\.1:\d+/);
});
