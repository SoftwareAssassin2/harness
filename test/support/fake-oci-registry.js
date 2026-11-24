// A fake OCI registry for the tests (ASS-466, shared since ASS-534): an HTTP
// server on the loopback holding manifests and blobs per repository, with
// cross-repository mounts and uploads at a Location, as zot answers its API.
// Every request is recorded as "<METHOD> <url>". fakeOciRegistry() returns
// { port, close(), requests, manifests, blobs, blob(repo, content),
// manifest(repo, ref, body, type), get(repo, ref), upstream(path, tag) — an
// amd64-only image in the cache's repository, as Artifact Registry serves
// it }. Under test/support/, which npm test's pattern leaves alone.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json', OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json', DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const sha = content => `sha256:${createHash('sha256').update(content).digest('hex')}`;

// A fake registry: manifests and blobs per repository, cross-repository mounts,
// uploads at a Location. Every request is recorded as "<METHOD> <url>".
export async function fakeOciRegistry() {
  const manifests = new Map(), blobs = new Map(), requests = [];
  const reg = {
    requests, manifests, blobs,
    blob(repo, content) { const b = Buffer.from(content); blobs.set(`${repo}@${sha(b)}`, b); return { digest: sha(b), size: b.length }; },
    manifest(repo, ref, body, type) { const b = Buffer.from(body); manifests.set(`${repo}@${ref}`, { body: b, type }); manifests.set(`${repo}@${sha(b)}`, { body: b, type }); return sha(b); },
    get: (repo, ref) => manifests.get(`${repo}@${ref}`),
    // An amd64-only image in the cache's repository, as Artifact Registry serves it (a Docker v2 manifest).
    upstream(path, tag) {
      const config = reg.blob(path, JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Cmd: ['postgres'] }, rootfs: { type: 'layers', diff_ids: [] }, tag }));
      const layer = reg.blob(path, `amd64 layer of ${path}:${tag}`);
      const body = JSON.stringify({ schemaVersion: 2, mediaType: DOCKER_MANIFEST, config: { mediaType: 'application/vnd.docker.container.image.v1+json', ...config }, layers: [{ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', ...layer }] });
      return { digest: reg.manifest(path, tag, body, DOCKER_MANIFEST), body, config, layer };
    },
  };
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks), url = new URL(req.url, 'http://x');
      requests.push(`${req.method} ${req.url}`);
      const send = (status, content, headers = {}) => { res.writeHead(status, headers); res.end(req.method === 'HEAD' ? undefined : content); };
      if (url.pathname === '/v2/') return send(200, '{}');
      let m = /^\/v2\/(.+)\/blobs\/uploads\/(.*)$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        const from = url.searchParams.get('from'), digest = url.searchParams.get('mount');
        if (from && blobs.has(`${from}@${digest}`)) { blobs.set(`${m[1]}@${digest}`, blobs.get(`${from}@${digest}`)); return send(201, ''); }
        return send(202, '', { Location: `/v2/${m[1]}/blobs/uploads/u${requests.length}` });
      }
      if (m && req.method === 'PUT') {
        const digest = url.searchParams.get('digest');
        if (sha(body) !== digest) return send(400, 'digest mismatch');
        blobs.set(`${m[1]}@${digest}`, body);
        return send(201, '');
      }
      m = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(url.pathname);
      if (m?.[2] === 'manifests' && req.method === 'DELETE') { manifests.delete(`${m[1]}@${m[3]}`); return send(202, ''); }
      if (m?.[2] === 'manifests' && req.method === 'PUT') {
        const parsed = JSON.parse(body);
        // As zot does: an index's images, and an image's blobs, must be in the repository already.
        const missing = parsed.manifests ? parsed.manifests.filter(c => !manifests.has(`${m[1]}@${c.digest}`)) : [parsed.config, ...parsed.layers].filter(b => !blobs.has(`${m[1]}@${b.digest}`));
        if (missing.length) return send(400, JSON.stringify({ errors: [{ code: 'MANIFEST_BLOB_UNKNOWN', missing }] }));
        reg.manifest(m[1], m[3], body, req.headers['content-type']);
        return send(201, '');
      }
      if (m?.[2] === 'manifests') {
        const found = manifests.get(`${m[1]}@${m[3]}`);
        return found ? send(200, found.body, { 'Content-Type': found.type, 'Docker-Content-Digest': sha(found.body) }) : send(404, '{"errors":[{"code":"MANIFEST_UNKNOWN"}]}');
      }
      if (m?.[2] === 'blobs') {
        const found = blobs.get(`${m[1]}@${m[3]}`);
        return found ? send(200, found, { 'Content-Length': found.length }) : send(404, '');
      }
      send(404, '');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  reg.port = srv.address().port;
  reg.close = () => new Promise(r => srv.close(r));
  return reg;
}

