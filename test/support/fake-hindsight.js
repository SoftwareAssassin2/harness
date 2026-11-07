// A stand-in for a project's Hindsight server (ASS-62) for the tests:
// fakeHindsight() starts one on a free port of 127.0.0.1 and returns { port,
// banks, requests, close() }. It keeps memories as Hindsight does, per bank,
// one memory unit per retain (Hindsight's LLM would extract several facts;
// none is called here), and answers the parts of its API the harness uses,
// at Hindsight's own paths (hindsight.vectorize.io/api-reference):
//   GET    /health                                      → { status: "healthy" }
//   PUT    /v1/default/banks/<bank>                     → the bank, made if missing
//   GET    /v1/default/banks/<bank>/memories/list       → { items, total, limit, offset }
//   DELETE /v1/default/banks/<bank>/documents/<id>      → the document and its memories gone
//   POST   /mcp/<bank>/                                 → an MCP tools/call (JSON-RPC) of
//          retain { content, context, metadata, document_id }, recall { query } or
//          delete_document { document_id }
// and its bank transfer (ASS-148), asynchronous as Hindsight's is — each
// operation is "processing" the first time it is polled, then done:
//   DELETE /v1/default/banks/<bank>                     → the bank and its memories gone
//   POST   /v1/default/banks/<bank>/transfer/export     → { operation_id }: the bank's
//          archive — here its memories as JSON, no real ZIP — kept for download
//   POST   /v1/default/banks/<bank>/transfer/import?mode=restore&target_bank_id=<b>
//          → { operation_id }: the multipart "file" archive restored as bank <b>
//          (the archive's own bank by default), which must not exist yet
//   GET    /v1/default/banks/<bank>/operations/<id>    → { operation_id, status,
//          result_metadata }: an export's download_url, storage_key, byte_size,
//          filename; an import's counts; failed with error_message
//   GET    /v1/default/files/download/<key>             → an export's archive
// down() makes it refuse every connection until up() — a server that is not
// answering — keeping its banks.
// As Hindsight documents: a retain with a document_id already in the bank
// replaces that document's memories; deleting a document removes them; recall
// returns the memories sharing a word of three letters or more with the query.
// Observations (ASS-156) — fact_type "observation", document_id null, the facts
// they came from in source_memory_ids — are never written here (Hindsight's
// consolidation does that with its LLM); a test puts them in `banks`. As
// Hindsight 1.1.0 does, a fact's removal takes every observation drawn from it.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export function fakeHindsight() {
  const banks = new Map();   // bank → [{ id, text, context, metadata, document_id, mentioned_at, fact_type, state, source_memory_ids }]
  const requests = [];
  const operations = new Map(); // id → { polled, result_metadata } or { polled, error_message }
  const files = new Map();      // storage key → archive
  const operation = done => { const id = randomUUID(); operations.set(id, { polled: 0, ...done }); return { operation_id: id, status: 'pending' }; };
  const bank = name => { if (!banks.has(name)) banks.set(name, []); return banks.get(name); };
  // The bank's memories without the document's, and without every observation drawn from them.
  const without = (name, doc) => {
    const gone = new Set(bank(name).filter(u => u.document_id === doc).map(u => u.id));
    return bank(name).filter(u => !gone.has(u.id) && !(u.source_memory_ids ?? []).some(id => gone.has(id)));
  };
  const words = text => new Set(String(text).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const tools = {
    retain(name, { content, context = 'general', metadata = {}, document_id: doc = randomUUID() }) {
      const units = without(name, doc);
      units.push({ id: randomUUID(), text: content, context, metadata, document_id: doc, mentioned_at: new Date().toISOString(), fact_type: 'world', state: 'valid', source_memory_ids: [] });
      banks.set(name, units);
      return { status: 'accepted', document_id: doc };
    },
    recall(name, { query }) {
      const want = words(query);
      return { results: bank(name).filter(u => [...words(u.text)].some(w => want.has(w))) };
    },
    delete_document(name, { document_id: doc }) {
      banks.set(name, without(name, doc));
      return { success: true };
    },
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const raw = Buffer.concat(chunks);
      let body = null;   // JSON, or null: a multipart upload, or nothing
      try { if (raw.length && !/multipart/.test(req.headers['content-type'] ?? '')) body = JSON.parse(raw.toString('utf8')); } catch { /* not JSON */ }
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      let m;
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { status: 'healthy' });
      if (req.method === 'PUT' && (m = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)$/))) { bank(m[1]); return send(200, { bank_id: m[1] }); }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)\/memories\/list$/))) {
        const items = bank(m[1]);
        return send(200, { items, total: items.length, limit: Number(url.searchParams.get('limit') ?? 100), offset: 0 });
      }
      if (req.method === 'DELETE' && (m = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)\/documents\/([^/]+)$/))) {
        tools.delete_document(m[1], { document_id: decodeURIComponent(m[2]) });
        return send(200, { success: true });
      }
      if (req.method === 'DELETE' && (m = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)$/))) {
        if (!banks.delete(m[1])) return send(404, { detail: `Bank ${m[1]} not found` });
        return send(200, { success: true });
      }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)\/transfer\/export$/))) {
        if (!banks.has(m[1])) return send(404, { detail: `Bank ${m[1]} not found` });
        const key = `${m[1]}/${randomUUID()}.zip`, archive = JSON.stringify({ bank: m[1], units: banks.get(m[1]) });
        files.set(key, archive);
        return send(202, operation({ result_metadata: { download_url: `/v1/default/files/download/${key}`, storage_key: key, byte_size: archive.length, filename: 'transfer.zip' } }));
      }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)\/transfer\/import$/))) {
        const file = filePart(req.headers['content-type'], raw);
        let archive;
        try { archive = JSON.parse(file); } catch { return send(202, operation({ error_message: 'not a transfer archive' })); }
        const target = url.searchParams.get('target_bank_id') ?? archive.bank;
        if ((url.searchParams.get('mode') ?? 'restore') !== 'restore') return send(422, { detail: 'only restore mode is faked' });
        if (banks.has(target)) return send(202, operation({ error_message: `bank ${target} already exists; restore writes a new bank` }));
        banks.set(target, archive.units);
        return send(202, operation({ result_metadata: { documents: new Set(archive.units.map(u => u.document_id)).size, memory_units: archive.units.length } }));
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)\/operations\/([^/]+)$/))) {
        const op = operations.get(m[2]);
        if (!op) return send(200, { operation_id: m[2], status: 'not_found' });
        if (op.polled++ === 0) return send(200, { operation_id: m[2], status: 'processing' });
        return send(200, op.error_message ? { operation_id: m[2], status: 'failed', error_message: op.error_message } : { operation_id: m[2], status: 'completed', result_metadata: op.result_metadata });
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/v1\/default\/files\/download\/(.+)$/)) && files.has(m[1])) {
        res.writeHead(200, { 'content-type': 'application/zip' });
        return res.end(files.get(m[1]));
      }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/mcp\/([^/]+)\/$/)) && body?.method === 'tools/call' && tools[body.params?.name]) {
        const result = tools[body.params.name](m[1], body.params.arguments ?? {});
        return send(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      }
      send(404, { detail: 'Not Found' });
    });
  });
  const close = () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({
      port, banks, requests, close,
      down: close,
      up: () => new Promise(done => server.listen(port, '127.0.0.1', done)),
    });
  }));
}

// filePart(contentType, body) — the multipart/form-data body's "file" part, as text.
function filePart(contentType, body) {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType ?? '')?.[2];
  if (!boundary) return '';
  for (const part of body.toString('latin1').split(`--${boundary}`)) {
    const at = part.indexOf('\r\n\r\n');
    if (at >= 0 && /name="file"/.test(part.slice(0, at))) return Buffer.from(part.slice(at + 4).replace(/\r\n$/, ''), 'latin1').toString('utf8');
  }
  return '';
}
