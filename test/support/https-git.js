// An HTTPS git forge for the tests (ASS-583): the bare repositories under `root` served by git's own
// git-http-backend, over TLS with a self-signed certificate made for the run, every request refused (401, a
// WWW-Authenticate challenge, as GitLab answers) unless it carries Basic auth `user`:`token`. Git trusts it through
// GIT_SSL_CAINFO (env). `requests` records each request's path and whether it was let in; `url(name)` a repository's.
// Not a test file (npm test's pattern leaves it alone).
import { createServer } from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BACKEND = join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend');

export async function httpsGit(root, { user = 'oauth2', token }) {
  const dir = mkdtempSync(join(tmpdir(), 'https-git-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const expected = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
  const requests = [];
  const server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
    const url = new URL(req.url, 'https://127.0.0.1');
    const allowed = req.headers.authorization === expected;
    requests.push({ path: url.pathname, allowed, authorization: req.headers.authorization ?? null });
    if (!allowed) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test forge"', 'Content-Type': 'text/plain' });
      return res.end('HTTP Basic: Access denied\n');
    }
    const cgi = spawn(BACKEND, [], { env: {
      GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: user, REMOTE_ADDR: '127.0.0.1',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
      PATH: process.env.PATH,
    } });
    const out = [];
    cgi.stdout.on('data', d => out.push(d));
    cgi.on('close', () => {
      const all = Buffer.concat(out), at = all.indexOf('\r\n\r\n'), cut = at >= 0 ? at : all.indexOf('\n\n');
      const head = all.subarray(0, cut).toString(), body = all.subarray(cut + (at >= 0 ? 4 : 2));
      let status = 200; const headers = {};
      for (const line of head.split(/\r?\n/)) {
        const [k, ...v] = line.split(':'); if (!k) continue;
        if (k.toLowerCase() === 'status') status = parseInt(v.join(':'), 10); else headers[k] = v.join(':').trim();
      }
      res.writeHead(status, headers); res.end(body);
    });
    req.pipe(cgi.stdin);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`;
  return {
    host, requests, ca: join(dir, 'cert.pem'),
    url: name => `https://${host}/${name}`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
