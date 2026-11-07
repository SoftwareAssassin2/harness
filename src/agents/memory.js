// Each project's memory (ASS-62): a Hindsight server of its own on the Mac
// (memory:up starts it; control's memory.js keeps it running), on the port
// its project.json names — "hindsight": { "port": <n>, "llm-api-key": … } —
// holding one bank, named after the project. Every agent of the project gets
// that bank's MCP endpoint (Hindsight's /mcp/<bank>/, streamable HTTP) as its
// --mcp-config: retain, recall, reflect and the rest of Hindsight's tools.
// The server listens on 127.0.0.1 only; an agent in a ticket's VM reaches it
// as host.lima.internal, Lima's address for the Mac's loopback, which vm:start
// lets that VM reach at its own project's port alone — so no agent can reach
// another project's bank (AC4).
// Hindsight's HTTP API (hindsight.vectorize.io/api-reference), used here for
// what is no agent's: the health check, the TUI's memory screen and its delete.

const HOST = '127.0.0.1';
const VM_HOST = 'host.lima.internal';

// memoryPort(project) — the port of the project's Hindsight ({ id, json }), or null when it has none.
export const memoryPort = project => project?.json?.hindsight?.port ?? null;

// memoryMcpConfig(project, { vm }) — the --mcp-config of the project's
// agents: its bank's endpoint, at host.lima.internal for an agent in a VM;
// undefined for a project with no Hindsight.
export function memoryMcpConfig(project, { vm = false } = {}) {
  const port = memoryPort(project);
  if (port == null) return undefined;
  return { mcpServers: { hindsight: { type: 'http', url: `http://${vm ? VM_HOST : HOST}:${port}/mcp/${project.id}/` } } };
}

// memoryAnswers(port, ms) — whether the Hindsight on the port answers its health check, in `ms`.
export const memoryAnswers = (port, ms = 2000) =>
  fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(ms) }).then(res => res.ok, () => false);

// Hindsight's HTTP API on the port, path under /v1/default/banks/<bank>; its
// JSON, or thrown — naming the bank's project — when it does not answer or fails.
async function api(port, bank, path, init = {}) {
  let res;
  try { res = await fetch(`http://${HOST}:${port}/v1/default/banks/${encodeURIComponent(bank)}${path}`, { ...init, signal: AbortSignal.timeout(10_000) }); } catch {
    throw new Error(`${bank}'s Hindsight is not answering on ${HOST}:${port}`);
  }
  if (!res.ok) throw new Error(`${bank}'s Hindsight answered ${res.status} to ${init.method ?? 'GET'} ${path}`);
  return res.json();
}

// listMemories(port, bank, { limit }) — the bank's memory units, newest
// first: { id, text, document_id, metadata — its source, ticket, step, model
// and date (AC7) — mentioned_at, fact_type, … }; up to `limit`.
export const listMemories = async (port, bank, { limit = 500 } = {}) => (await api(port, bank, `/memories/list?limit=${limit}`)).items ?? [];

// deleteMemory(port, bank, documentId) — the document a memory was retained
// as deleted, and with it every memory unit Hindsight extracted from it.
// Hindsight deletes no single unit (its memories API can only invalidate
// one), so a memory goes with its retain, as an agent's correction does.
export const deleteMemory = (port, bank, documentId) => api(port, bank, `/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' });
