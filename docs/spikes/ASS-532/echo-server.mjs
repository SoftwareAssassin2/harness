// ASS-532 spike: an in-cluster stand-in for an upstream API (GitLab, Anthropic).
// HTTPS on 443 (self-signed, generated at start) and HTTP on 80.
// /echo returns the request's headers as JSON (so injected credentials can be
// seen); /slow?s=N answers after N seconds; /delayN/v1/messages answers the same after N seconds; /v1/messages answers like a minimal
// Anthropic Messages API reply so a client gets a well-formed response. Logs every request.
import http from 'node:http'; import https from 'node:https'; import { execSync } from 'node:child_process';
execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/k.pem -out /tmp/c.pem -days 2 -subj /CN=echo.spike-echo.svc.cluster.local -addext subjectAltName=DNS:echo.spike-echo.svc.cluster.local,DNS:echo.spike-echo.svc 2>/dev/null');
const fs = await import('node:fs');
const handler = (req, res) => {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    console.log(new Date().toISOString(), req.socket.remoteAddress, req.method, req.url, JSON.stringify(req.headers));
    if (u.pathname === '/slow') return setTimeout(() => { res.end(`slow done after ${u.searchParams.get('s')}s\n`); }, Number(u.searchParams.get('s') || 30) * 1000);
    const delayed = u.pathname.match(/^\/delay(\d+)(\/v1\/messages.*)$/);   // ANTHROPIC_BASE_URL=http://echo/delay60: a model call that takes 60 s
    if (delayed) { req.url = delayed[2]; return setTimeout(() => handler2(req, res, body), Number(delayed[1]) * 1000); }
    return handler2(req, res, body);
  });
};
const handler2 = (req, res, body) => {
  { const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/v1/messages')) { res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ id: 'msg_spike', type: 'message', role: 'assistant', model: 'spike', content: [{ type: 'text', text: 'echo: ' + JSON.stringify({ auth: req.headers.authorization, key: req.headers['x-api-key'] }) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })); }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }) + '\n');
  }
};
http.createServer(handler).listen(80);
https.createServer({ key: fs.readFileSync('/tmp/k.pem'), cert: fs.readFileSync('/tmp/c.pem'), keepAliveTimeout: 600000 }, handler).listen(443);
console.log('echo up');
