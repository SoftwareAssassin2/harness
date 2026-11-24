// ASS-532 spike: a stand-in for control's forwarder (src/control/forwarder.js)
// with the same shape — HTTP on the Mac's 127.0.0.1:<PORT>, POST /run
// { token, argv } answered with NDJSON { o: base64 } then { exit } — but it
// runs nothing: it echoes the argv, and refuses (403) any token but TOKEN. Used
// to see whether a sandbox can reach a server bound to the Mac's loopback.
import http from 'node:http';
const port = Number(process.env.PORT || 18099), token = process.env.TOKEN || 'spike-token';
http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    let j = {}; try { j = JSON.parse(body); } catch {}
    console.log(new Date().toISOString(), req.socket.remoteAddress, req.method, req.url, JSON.stringify(j.argv));
    if (req.method !== 'POST' || req.url !== '/run') { res.statusCode = 404; return res.end(); }
    if (j.token !== token) { res.statusCode = 403; return res.end(JSON.stringify({ refused: 'unknown token' }) + '\n'); }
    res.setHeader('content-type', 'application/x-ndjson');
    res.write(JSON.stringify({ o: Buffer.from(`ran ${JSON.stringify(j.argv)}\n`).toString('base64') }) + '\n');
    res.end(JSON.stringify({ exit: 0 }) + '\n');
  });
}).listen(port, '127.0.0.1', () => console.log('fake forwarder on 127.0.0.1:' + port));
