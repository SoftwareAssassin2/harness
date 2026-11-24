// ASS-532 spike: stands in for a Claude Code session in a sandbox. It holds ONE
// keep-alive TLS connection to URL (env, default https://echo.spike-echo.svc.cluster.local/echo)
// and sends a request on it every INTERVAL seconds, logging to LOG each
// request's result, the socket's local port (same port = same connection) and
// any socket error or close. With SLOW=<seconds> it instead sends one request
// the server answers only after that long (a turn waiting on the model), so a
// suspend can be taken mid-request. No real API, no key.
import https from 'node:https';
import { appendFileSync } from 'node:fs';
const url = new URL(process.env.URL || 'https://echo.spike-echo.svc.cluster.local/echo');
const log = process.env.LOG || '/home/agent/tlshold.log';
const every = Number(process.env.INTERVAL || 5) * 1000;
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
const say = m => appendFileSync(log, `${new Date().toISOString()} pid=${process.pid} ${m}\n`);
let n = 0;
function once(path) {
  const started = Date.now();
  const req = https.request({ host: url.hostname, port: url.port || 443, path, agent, servername: url.hostname, rejectUnauthorized: false }, res => {
    let body = ''; res.on('data', d => body += d);
    res.on('end', () => say(`#${n} ${path} -> ${res.statusCode} in ${Date.now() - started}ms localPort=${req.socket?.localPort} reused=${req.reusedSocket} body=${body.slice(0, 80).replace(/\s+/g, ' ')}`));
  });
  req.on('socket', s => { if (!s._watched) { s._watched = true; s.on('close', e => say(`socket localPort=${s.localPort} closed hadError=${e}`)); } });
  req.on('error', e => say(`#${n} ${path} ERROR ${e.code || ''} ${e.message} after ${Date.now() - started}ms`));
  req.end();
}
say(`start url=${url} slow=${process.env.SLOW || ''}`);
if (process.env.SLOW) { n++; once(`/slow?s=${process.env.SLOW}`); }
else setInterval(() => { n++; once(url.pathname); }, every);
setInterval(() => say('tick'), 10000);   // shows the process itself keeps running (or the gap while suspended)
