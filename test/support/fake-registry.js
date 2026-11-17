// Registries for the workstation image tests (ASS-472), each an HTTP server on
// the Mac's loopback, which a fake workstation's sessions share
// (fake-ssh.js), so the workstation's 127.0.0.1:<port> reaches it.
// fakeRegistry({ token }) answers the registry API's manifest requests (GET
// and HEAD /v2/<path>/manifests/<tag or digest>) for the images put(path,
// reference, digest) holds — 200 with Docker-Content-Digest, else 404
// "manifest unknown" — and, given a token, only with `Authorization: Basic
// base64(oauth2accesstoken:<token>)`, else 401 (Artifact Registry as a
// Docker config logged in with a service account's token; without, zot,
// which asks for none). asked lists "<METHOD> <url>". ASS-473: flaky(n)
// answers its next n manifest requests 503, as a registry dropping a pull. fakeMetadata(token)
// is a GCE metadata server: the default service account's token, only with
// Metadata-Flavor: Google; failing() makes it answer 500 until undone.
// Each returns { url, port, close() }; await ready first.
// Under test/support/, which npm test's pattern leaves alone.
import { createServer } from 'node:http';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

export async function fakeRegistry({ token = null } = {}) {
  const images = new Map(), asked = [];
  let flaky = 0;
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    if (flaky > 0 && /\/manifests\//.test(req.url)) { flaky -= 1; res.writeHead(503); return res.end('{"errors":[{"code":"UNAVAILABLE","message":"service unavailable"}]}'); }
    if (token && req.headers.authorization !== `Basic ${Buffer.from(`oauth2accesstoken:${token}`).toString('base64')}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"errors":[{"code":"UNAUTHORIZED","message":"authentication failed"}]}');
    }
    const m = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(req.url);
    const digest = m && images.get(`${m[1]}:${decodeURIComponent(m[2])}`);
    if (!digest) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}]}'); }
    res.writeHead(200, { 'Docker-Content-Digest': digest, 'Content-Type': 'application/vnd.oci.image.index.v1+json' });
    res.end(req.method === 'HEAD' ? undefined : '{}');
  });
  const port = await listen(server);
  return {
    port, url: `http://127.0.0.1:${port}`, asked,
    put: (path, reference, digest) => { images.set(`${path}:${reference}`, digest); if (!reference.startsWith('sha256:')) images.set(`${path}:${digest}`, digest); },
    remove: (path, reference) => images.delete(`${path}:${reference}`),
    flaky: n => { flaky = n; },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

export async function fakeMetadata(token) {
  let failing = false;
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.url);
    if (failing) { res.writeHead(500); return res.end('metadata server unavailable'); }
    if (req.headers['metadata-flavor'] !== 'Google' || req.url !== '/computeMetadata/v1/instance/service-accounts/default/token') { res.writeHead(403); return res.end('forbidden'); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Metadata-Flavor': 'Google' });
    res.end(JSON.stringify({ access_token: token, expires_in: 3599, token_type: 'Bearer' }));
  });
  const port = await listen(server);
  return {
    port, url: `http://127.0.0.1:${port}`, asked,
    failing: (on = true) => { failing = on; },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
